package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
)

// A profile is what a computing node is made of: its size and the packages it adds to the
// runtime. A unit is made from one; a unit is saved as one, as the next version of a profile
// the caller may change or as a new profile, its packages pinned as installed.

func nodeOf(t *testing.T, unit envelope) api.ComputingNodeSpec {
	t.Helper()
	var spec api.ComputingUnitSpec
	mustDecode(t, unit.Spec, &spec)
	if spec.ComputingNodes == nil || len(*spec.ComputingNodes) == 0 {
		t.Fatalf("the unit has no node: %s", unit.Spec)
	}
	return (*spec.ComputingNodes)[0]
}

func TestAUnitIsMadeFromAProfile(t *testing.T) {
	h := newHarness(t)
	profile := h.create("alice", "profiles", "small with humanize", map[string]any{"cpu": "2", "memory": "4Gi", "packages": []string{"humanize"}})
	var unit envelope
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "from a profile", "profile": string(profile.Metadata.Uri)}, &unit)
	node := nodeOf(t, unit)
	if node.Profile == nil || string(*node.Profile) != string(profile.Metadata.Uri)+"@1" {
		t.Fatalf("the node names the profile's version: %+v", node.Profile)
	}
	if node.Cpu == nil || *node.Cpu != "2" || node.Memory == nil || *node.Memory != "4Gi" || node.Packages == nil || (*node.Packages)[0] != "humanize" {
		t.Fatalf("the node is the profile's: %+v", node)
	}
	// Waited for, a unit that is not ready when the time is up is answered as it is then.
	started := time.Now()
	var waited envelope
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "waited for", "profile": string(profile.Metadata.Uri), "waitSeconds": 1}, &waited)
	var status api.ComputingUnitStatus
	mustDecode(t, waited.Status, &status)
	if status.Phase != api.ComputingUnitStatusPhasePending || time.Since(started) < time.Second {
		t.Fatalf("a unit waited for: %s after %s", status.Phase, time.Since(started))
	}
	// A profile that is not there, or not the caller's to read, makes no unit.
	wantError(t, h, "POST", p+"/computing-units/from-profile", map[string]any{"name": "nowhere", "profile": "texera://profiles/00000000-0000-4000-8000-000000000099"}, http.StatusNotFound, "not_found", "")
}

func TestAUnitIsSavedAsAProfile(t *testing.T) {
	h := newHarness(t)
	// A run on the deployment's unit installs the platform profile's packages.
	_, exec := anExecution(t, h)
	finish(t, h, exec, "completed")
	var spec api.ExecutionSpec
	mustDecode(t, exec.Spec, &spec)
	unitRID := strings.TrimPrefix(string(spec.ComputingUnit), "texera://computing-units/")

	// As a new profile: its packages pinned as the unit installed them.
	var mine envelope
	h.mustJSON("alice", "POST", p+"/computing-units/"+unitRID+"/profile", map[string]any{"name": "like the deployment's"}, &mine)
	var saved api.ProfileSpec
	mustDecode(t, mine.Spec, &saved)
	if saved.Packages == nil || strings.Join(*saved.Packages, ",") != "numpy==1.0,pandas==1.0,scikit-learn==1.0" {
		t.Fatalf("the packages are saved pinned: %+v", saved.Packages)
	}
	// A new profile needs a name.
	wantError(t, h, "POST", p+"/computing-units/"+unitRID+"/profile", map[string]any{}, http.StatusBadRequest, "invalid", "needs a name")
	// The platform's own profile changes with the platform: it is not saved over.
	var unit envelope
	h.mustJSON("alice", "GET", p+"/computing-units/"+unitRID, nil, &unit)
	builtin := nodeOf(t, unit).Profile
	wantError(t, h, "POST", p+"/computing-units/"+unitRID+"/profile", map[string]any{"profile": strings.SplitN(string(*builtin), "@", 2)[0]}, http.StatusConflict, "builtin", "built in")

	// As the next version of a profile of one's own; a unit made from it is then made from that version.
	var own envelope
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "mine to save", "profile": string(mine.Metadata.Uri)}, &own)
	var next envelope
	h.mustJSON("alice", "POST", p+"/computing-units/"+rid(own)+"/profile", map[string]any{"profile": string(mine.Metadata.Uri)}, &next)
	if next.Metadata.Head != 2 {
		t.Fatalf("saved as the next version: head %d", next.Metadata.Head)
	}
	h.mustJSON("alice", "GET", p+"/computing-units/"+rid(own), nil, &own)
	if got := nodeOf(t, own).Profile; got == nil || string(*got) != string(mine.Metadata.Uri)+"@2" {
		t.Fatalf("the unit is made from what was saved: %v", got)
	}
}

// What a unit installed was for its packages: given other packages it has none of them
// installed until a run installs them; another size changes nothing of it.
func TestAUnitGivenOtherPackagesHasNothingInstalled(t *testing.T) {
	h := newHarness(t)
	profile := h.create("alice", "profiles", "with humanize", map[string]any{"memory": "2Gi", "packages": []string{"humanize"}})
	var unit envelope
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "mine", "profile": string(profile.Metadata.Uri)}, &unit)
	if _, err := h.svc.Store.MergeStatus(context.Background(), uuid.MustParse(rid(unit)), json.RawMessage(`{"installed": ["humanize==4.11.0"]}`)); err != nil {
		t.Fatal(err)
	}
	installed := func() *[]string {
		var u envelope
		h.mustJSON("alice", "GET", p+"/computing-units/"+rid(unit), nil, &u)
		var status api.ComputingUnitStatus
		mustDecode(t, u.Status, &status)
		return status.Installed
	}
	put := func(node api.ComputingNodeSpec) {
		spec := api.ComputingUnitSpec{Provider: api.UnitProviderKubernetes, ComputingNodes: &[]api.ComputingNodeSpec{node}}
		h.mustJSON("alice", "PUT", p+"/computing-units/"+rid(unit), map[string]any{"spec": spec}, nil)
	}
	node := nodeOf(t, unit)
	bigger := "4Gi"
	node.Memory = &bigger
	put(node)
	if got := installed(); got == nil || len(*got) != 1 {
		t.Fatalf("another size keeps what was installed: %v", got)
	}
	more := append(*node.Packages, "tqdm")
	node.Packages = &more
	put(node)
	if got := installed(); got != nil {
		t.Fatalf("other packages have nothing installed yet: %v", *got)
	}
}
