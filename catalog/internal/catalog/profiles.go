package catalog

// Profiles: what a computing node is made of, its size and the Python packages it adds to the
// platform's runtime, versioned. A unit is made from a profile version and may change since;
// saving a unit as a profile makes the next version of a profile or a new one. A run installs
// the unit's packages on it (one environment per list of packages, built once on a unit) and
// records what the unit had, each package pinned as installed.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/engine"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
	"github.com/google/uuid"
)

var profileKind, _ = kinds.ByName("profile")

// masterOf is the node a unit runs its engine on: the master, else the first; nil for a unit
// that names none.
func masterOf(spec *api.ComputingUnitSpec) *api.ComputingNodeSpec {
	if spec.ComputingNodes == nil {
		return nil
	}
	nodes := *spec.ComputingNodes
	for i := range nodes {
		if nodes[i].Role == api.ComputingNodeSpecRoleMaster {
			return &nodes[i]
		}
	}
	if len(nodes) > 0 {
		return &nodes[0]
	}
	return nil
}

// packagesOf is a list of packages as one environment: trimmed, without blanks or repeats, sorted.
func packagesOf(packages *[]string) []string {
	if packages == nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, p := range *packages {
		p = strings.TrimSpace(p)
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

// environmentFor is the environment a node asks its unit for: nil without packages. Its key is
// derived from the packages, so the same list is the same environment.
func environmentFor(node *api.ComputingNodeSpec) *engine.EnvironmentRequest {
	if node == nil {
		return nil
	}
	packages := packagesOf(node.Packages)
	if len(packages) == 0 {
		return nil
	}
	sum := sha256.Sum256([]byte(strings.Join(packages, "\n")))
	return &engine.EnvironmentRequest{Key: "p" + hex.EncodeToString(sum[:8]), Packages: packages}
}

var separators = regexp.MustCompile(`[-_.]+`)

// environmentKey names the packages a unit's node lists; "" for none.
func environmentKey(spec *api.ComputingUnitSpec) string {
	if env := environmentFor(masterOf(spec)); env != nil {
		return env.Key
	}
	return ""
}

// packageName is the name a requirement installs, as pip compares names: `Scikit_Learn>=1` is
// `scikit-learn`.
func packageName(requirement string) string {
	requirement = strings.TrimSpace(requirement)
	if end := strings.IndexAny(requirement, "<>=!~;[ @"); end >= 0 {
		requirement = requirement[:end]
	}
	return separators.ReplaceAllString(strings.ToLower(requirement), "-")
}

// pinned is each requirement as it was installed, when the unit says what it installed: a
// requirement the installed list names becomes that pin; any other stays as asked.
func pinned(asked []string, installed *[]string) []string {
	versions := map[string]string{}
	if installed != nil {
		for _, pin := range *installed {
			versions[packageName(pin)] = pin
		}
	}
	out := make([]string, 0, len(asked))
	for _, requirement := range asked {
		if pin, ok := versions[packageName(requirement)]; ok {
			out = append(out, pin)
		} else {
			out = append(out, requirement)
		}
	}
	return out
}

// computingRecord is what a run records of the unit it ran on: the profile its node was made
// from, its size, its packages (pinned as installed when the unit said so) and its engine.
func computingRecord(unit *store.Resource) *api.ComputingRecord {
	var spec api.ComputingUnitSpec
	var status api.ComputingUnitStatus
	_ = json.Unmarshal(unit.Spec, &spec)
	_ = json.Unmarshal(unit.Status, &status)
	record := &api.ComputingRecord{}
	if node := masterOf(&spec); node != nil {
		record.Profile, record.Cpu, record.Memory, record.Gpu = node.Profile, node.Cpu, node.Memory, node.Gpu
		if packages := packagesOf(node.Packages); len(packages) > 0 {
			p := pinned(packages, status.Installed)
			record.Packages = &p
		}
	}
	if status.Engine != nil && status.Engine.Version != nil {
		record.Runtime = status.Engine.Version
	}
	if string(mustJSON(record)) == "{}" {
		return nil
	}
	return record
}

// nodesFromProfiles gives each node of a unit's spec what the profile it names says, where the
// node says nothing itself, and names the profile's version. The caller must be able to read
// the profile.
func (s *Service) nodesFromProfiles(ctx context.Context, caller *auth.Caller, spec json.RawMessage) (json.RawMessage, error) {
	var unit api.ComputingUnitSpec
	if err := json.Unmarshal(spec, &unit); err != nil || unit.ComputingNodes == nil {
		return spec, nil
	}
	changed := false
	nodes := *unit.ComputingNodes
	for i := range nodes {
		node := &nodes[i]
		if node.Profile == nil || *node.Profile == "" {
			continue
		}
		profile, err := s.resourceByURI(ctx, caller, string(*node.Profile), &profileKind)
		if err != nil {
			return nil, err
		}
		version, err := s.versionURI(ctx, string(*node.Profile), "profile")
		if err != nil {
			return nil, NotFound("profile " + string(*node.Profile))
		}
		ref, err := uri.Parse(version)
		if err != nil {
			return nil, NotFound("profile " + version)
		}
		v, err := s.Store.GetVersion(ctx, profile.RID, ref.Vno)
		if err != nil {
			return nil, NotFound("profile " + version)
		}
		var made api.ProfileSpec
		_ = json.Unmarshal(v.Content, &made)
		pin := api.Uri(version)
		node.Profile = &pin
		if node.Cpu == nil {
			node.Cpu = made.Cpu
		}
		if node.Memory == nil {
			node.Memory = made.Memory
		}
		if node.Gpu == nil {
			node.Gpu = made.Gpu
		}
		if node.Packages == nil {
			node.Packages = made.Packages
		}
		changed = true
	}
	if !changed {
		return spec, nil
	}
	var doc map[string]any
	_ = json.Unmarshal(spec, &doc)
	var asMaps []any
	_ = json.Unmarshal(mustJSON(nodes), &asMaps)
	doc["computingNodes"] = asMaps
	return mustJSON(doc), nil
}

// UnitFromProfile makes a computing unit from a profile: one master node of the profile's size
// with its packages, run on the deployment's Kubernetes. With WaitSeconds it waits for the unit
// to be ready or failed.
func (s *Service) UnitFromProfile(ctx context.Context, caller *auth.Caller, in api.ComputingUnitFromProfile) (*store.Resource, error) {
	profile := in.Profile
	spec := api.ComputingUnitSpec{
		Provider:       api.UnitProviderKubernetes,
		ComputingNodes: &[]api.ComputingNodeSpec{{Name: "master", Role: api.ComputingNodeSpecRoleMaster, Profile: &profile}},
	}
	var parent *uuid.UUID
	if in.Parent != nil {
		p, err := uuid.Parse(string(*in.Parent))
		if err != nil {
			return nil, Invalid("parent: "+err.Error(), map[string]any{"field": "parent"})
		}
		parent = &p
	}
	unit, _, err := s.Create(ctx, caller, CreateInput{Kind: unitKind, Name: in.Name, Parent: parent, Spec: mustJSON(spec)})
	if err != nil || in.WaitSeconds == nil || *in.WaitSeconds <= 0 {
		return unit, err
	}
	return s.waitForUnit(ctx, unit, time.Duration(min(*in.WaitSeconds, 600))*time.Second), nil
}

// waitForUnit probes a unit until it is ready or failed, or the time is up; it returns the unit
// as it is then.
func (s *Service) waitForUnit(ctx context.Context, unit *store.Resource, timeout time.Duration) *store.Resource {
	var spec api.ComputingUnitSpec
	_ = json.Unmarshal(unit.Spec, &spec)
	deadline := time.Now().Add(timeout)
	for {
		phase := s.unitStatus(ctx, unit, spec).Phase
		if phase == api.ComputingUnitStatusPhaseReady || phase == api.ComputingUnitStatusPhaseFailed || time.Now().After(deadline) {
			return unit
		}
		select {
		case <-ctx.Done():
			return unit
		case <-time.After(2 * time.Second):
		}
	}
}

// SaveUnitAsProfile saves a unit's node as a profile: the next version of a profile the caller
// may change, or a new profile. Packages are saved as the unit installed them, each pinned. The
// unit is then made from what was saved, when the caller may change the unit.
func (s *Service) SaveUnitAsProfile(ctx context.Context, caller *auth.Caller, rid uuid.UUID, in api.SaveUnitAsProfile) (*store.Resource, error) {
	unit, err := s.Get(ctx, caller, &unitKind, rid)
	if err != nil {
		return nil, err
	}
	var spec api.ComputingUnitSpec
	var status api.ComputingUnitStatus
	_ = json.Unmarshal(unit.Spec, &spec)
	_ = json.Unmarshal(unit.Status, &status)
	node := masterOf(&spec)
	if node == nil {
		return nil, Invalid(unit.Name+" names no node to save", nil)
	}
	saved := api.ProfileSpec{Cpu: node.Cpu, Memory: node.Memory, Gpu: node.Gpu}
	if packages := packagesOf(node.Packages); len(packages) > 0 {
		p := pinned(packages, status.Installed)
		saved.Packages = &p
	}
	if status.Engine != nil {
		saved.Runtime = status.Engine.Version
	}
	message := "saved from the computing unit " + unit.Name

	var profile *store.Resource
	if in.Profile != nil && *in.Profile != "" {
		target, err := s.resourceByURI(ctx, caller, string(*in.Profile), &profileKind)
		if err != nil {
			return nil, err
		}
		profile, _, err = s.UpdateSpec(ctx, caller, profileKind, UpdateSpecInput{RID: target.RID, Spec: mustJSON(saved), Message: &message})
		if err != nil {
			return nil, err
		}
	} else {
		if in.Name == nil || strings.TrimSpace(*in.Name) == "" {
			return nil, Invalid("a new profile needs a name", map[string]any{"field": "name"})
		}
		// Into the unit's project, unless that is the platform's own: then where the call is made.
		parent := unit.ParentRID
		if s.builtIn(unit) {
			parent = nil
		}
		if in.Parent != nil {
			p, err := uuid.Parse(string(*in.Parent))
			if err != nil {
				return nil, Invalid("parent: "+err.Error(), map[string]any{"field": "parent"})
			}
			parent = &p
		}
		profile, _, err = s.Create(ctx, caller, CreateInput{Kind: profileKind, Name: *in.Name, Parent: parent, Spec: mustJSON(saved), Message: &message})
		if err != nil {
			return nil, err
		}
	}

	// The unit is now made from what was saved.
	made := api.Uri(URI(profile).WithVersion(profile.HeadVno).String())
	node.Profile = &made
	if err := s.require(ctx, caller, authz.Write, unit.RID); err == nil {
		if _, _, err := s.UpdateSpec(ctx, caller, unitKind, UpdateSpecInput{RID: unit.RID, Spec: mustJSON(spec)}); err != nil {
			s.Log.Warn("the unit was not moved to the profile it was saved as", "unit", unit.RID, "err", err)
		}
	}
	return profile, nil
}

// buildEnvironment asks a unit to build the environment of its packages and waits for it; it
// returns the packages as installed.
func (s *Service) buildEnvironment(ctx context.Context, client *engine.Unit, req engine.EnvironmentRequest) ([]string, error) {
	build, err := client.BuildEnvironment(ctx, req)
	if err != nil {
		return nil, err
	}
	for build.Status == engine.EnvironmentBuildStatusBuilding {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
		if build, err = client.EnvironmentStatus(ctx, req.Key); err != nil {
			return nil, err
		}
	}
	if build.Status == engine.EnvironmentBuildStatusFailed {
		return nil, fmt.Errorf("installing %s failed: %s", strings.Join(req.Packages, ", "), deref(build.Message))
	}
	if build.Installed == nil {
		return nil, nil
	}
	return *build.Installed, nil
}

// forgetInstalled drops what a unit installed: it was for packages the unit no longer lists.
func (s *Service) forgetInstalled(ctx context.Context, unit *store.Resource) error {
	var status api.ComputingUnitStatus
	if json.Unmarshal(unit.Status, &status) != nil || status.Installed == nil {
		return nil
	}
	status.Installed = nil
	updated, err := s.Store.UpdateStatus(ctx, unit.RID, mustJSON(status))
	if err != nil {
		return err
	}
	*unit = *updated
	return nil
}

// recordInstalled keeps in a unit's status the packages it installed, and in an execution's
// record the packages it ran with, pinned.
func (s *Service) recordInstalled(ctx context.Context, unitRID, execRID uuid.UUID, asked, installed []string) {
	if len(installed) == 0 {
		return
	}
	if _, err := s.Store.MergeStatus(ctx, unitRID, mustJSON(map[string]any{"installed": installed})); err != nil {
		s.Log.Warn("what the unit installed was not recorded", "unit", unitRID, "err", err)
	}
	if err := s.Store.SetExecutionPackages(ctx, execRID, pinned(asked, &installed)); err != nil && !errors.Is(err, store.ErrNotFound) {
		s.Log.Warn("the packages of an execution were not recorded", "execution", execRID, "err", err)
	}
}
