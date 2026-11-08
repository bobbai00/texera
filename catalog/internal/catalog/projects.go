package catalog

// Projects: where work is managed from. A project inherits from one other, its base, up to
// Texera, the root: its people read and use what the projects up its chain hold, and its
// settings fill in what its own leave out. A preference (the look, a default) comes from the
// nearest project that sets it; a limit is the strictest along the chain, so a project may
// narrow what it inherits and never widen it. A project's admins (its owners) change the
// project itself: its settings, its base, its people. Its members (editors) work in it.
//
// Inheriting is a kind of sharing: the people of a project read and use what its base holds.
// So a project inherits only from a base its admin administers too, or from Texera, which is
// open to everyone; the base's admins may send it back to Texera; and a project is public only
// when every project up its chain is, since its readers read what it inherits.

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

const (
	// rootLabel marks Texera, the project at the top of every chain.
	rootLabel = "texera.root"
	// homeLabel marks a person's home project.
	homeLabel = "texera.home"
)

// identityLabels are the catalog's own: what they mark is told by them, so nobody sets or
// removes them through the API.
var identityLabels = []string{rootLabel, homeLabel}

// Root returns Texera, the project every project inherits from; nil before the seed.
func (s *Service) Root() *store.Resource {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.root
}

// isRoot reports whether a resource is Texera.
func (s *Service) isRoot(r *store.Resource) bool {
	root := s.Root()
	return root != nil && r != nil && r.RID == root.RID
}

// chainOf returns a project and what it inherits from, nearest first.
func (s *Service) chainOf(ctx context.Context, project uuid.UUID) ([]store.Resource, error) {
	chain, err := s.Store.Chain(ctx, project)
	if err != nil {
		return nil, wrap(err, "project "+project.String())
	}
	return chain, nil
}

// chainRIDs returns the rids of a project's chain, nearest first; nil when it cannot be read.
func (s *Service) chainRIDs(ctx context.Context, project uuid.UUID) []uuid.UUID {
	chain, err := s.Store.Chain(ctx, project)
	if err != nil {
		return nil
	}
	out := make([]uuid.UUID, len(chain))
	for i := range chain {
		out[i] = chain[i].RID
	}
	return out
}

// ProjectSettings is what a project's work runs with, for someone who may read the project.
func (s *Service) ProjectSettings(ctx context.Context, caller *auth.Caller, rid uuid.UUID) (*api.ProjectSettings, error) {
	if _, err := s.Get(ctx, caller, &projectKind, rid); err != nil {
		return nil, err
	}
	return s.settingsOf(ctx, rid)
}

// settingsOf resolves a project's settings along its chain: each preference from the nearest
// project that sets it, each limit the strictest. Where each value comes from is kept.
func (s *Service) settingsOf(ctx context.Context, project uuid.UUID) (*api.ProjectSettings, error) {
	chain, err := s.chainOf(ctx, project)
	if err != nil {
		return nil, err
	}
	return resolveSettings(chain), nil
}

// defaultsOf returns what a project's work runs with when nothing nearer chooses.
func (s *Service) defaultsOf(ctx context.Context, project *uuid.UUID) api.ProjectDefaults {
	if project == nil {
		return api.ProjectDefaults{}
	}
	settings, err := s.settingsOf(ctx, *project)
	if err != nil {
		return api.ProjectDefaults{}
	}
	return settings.Defaults
}

// resolveSettings folds a chain's specs, nearest first, into what holds.
func resolveSettings(chain []store.Resource) *api.ProjectSettings {
	out := &api.ProjectSettings{Chain: []api.ProjectRef{}, From: map[string]api.Rid{}}
	var shortest time.Duration
	for i := range chain {
		p := &chain[i]
		out.Chain = append(out.Chain, api.ProjectRef{Rid: api.Rid(p.RID.String()), Name: p.Name})
		var spec api.ProjectSpec
		_ = json.Unmarshal(p.Spec, &spec)
		from := api.Rid(p.RID.String())
		if b := spec.Branding; b != nil {
			nearest(&out.Branding.Name, b.Name, "branding.name", from, out.From)
			nearest(&out.Branding.LogoUrl, b.LogoUrl, "branding.logoUrl", from, out.From)
		}
		if d := spec.Defaults; d != nil {
			nearest(&out.Defaults.AgentTemplate, d.AgentTemplate, "defaults.agentTemplate", from, out.From)
			nearest(&out.Defaults.ModelEndpoint, d.ModelEndpoint, "defaults.modelEndpoint", from, out.From)
			nearest(&out.Defaults.ComputingUnit, d.ComputingUnit, "defaults.computingUnit", from, out.From)
			nearest(&out.Defaults.Profile, d.Profile, "defaults.profile", from, out.From)
			nearest(&out.Defaults.Warehouse, d.Warehouse, "defaults.warehouse", from, out.From)
			nearest(&out.Defaults.McpServers, d.McpServers, "defaults.mcpServers", from, out.From)
			if d.WorkMode != nil && d.WorkMode.Valid() {
				nearest(&out.Defaults.WorkMode, d.WorkMode, "defaults.workMode", from, out.From)
			}
		}
		if l := spec.Limits; l != nil {
			if l.Results != nil && (out.Limits.Results == nil || asDuration(*l.Results) < shortest) {
				results := *l.Results
				out.Limits.Results, shortest = &results, asDuration(results)
				out.From["limits.results"] = from
			}
			if l.WarehouseEndpoints != nil {
				if out.Limits.WarehouseEndpoints == nil {
					listed := slices.Clone(*l.WarehouseEndpoints)
					out.Limits.WarehouseEndpoints = &listed
					out.From["limits.warehouseEndpoints"] = from
				} else {
					kept := slices.DeleteFunc(slices.Clone(*out.Limits.WarehouseEndpoints), func(e string) bool {
						return !slices.ContainsFunc(*l.WarehouseEndpoints, func(o string) bool { return sameEndpoint(e, o) })
					})
					out.Limits.WarehouseEndpoints = &kept
				}
			}
		}
	}
	// A list narrows what a project inherits, and Texera's is where the stores come from: a store
	// it does not list is on no project's list. The lake and the units connect to the address a
	// warehouse names, so only Texera's admins open the deployment to a store.
	if top := len(chain) - 1; top >= 0 && chain[top].BaseRID == nil && out.Limits.WarehouseEndpoints != nil {
		var texera api.ProjectSpec
		_ = json.Unmarshal(chain[top].Spec, &texera)
		if texera.Limits == nil || texera.Limits.WarehouseEndpoints == nil {
			out.Limits.WarehouseEndpoints = &[]string{}
		}
	}
	return out
}

// nearest fills a value the nearer projects left unset, and says where it came from.
func nearest[T any](dst **T, value *T, path string, from api.Rid, sources map[string]api.Rid) {
	if *dst != nil || value == nil {
		return
	}
	if s, ok := any(value).(*string); ok && strings.TrimSpace(*s) == "" {
		return
	}
	if u, ok := any(value).(*api.Uri); ok && strings.TrimSpace(string(*u)) == "" {
		return
	}
	v := *value
	*dst = &v
	sources[path] = from
}

// sameEndpoint compares two store endpoints, a trailing slash aside.
func sameEndpoint(a, b string) bool { return strings.TrimRight(a, "/") == strings.TrimRight(b, "/") }

// projectRefOf names a project of a chain by its rid, for where a default comes from.
func projectRefOf(settings *api.ProjectSettings, rid api.Rid) *api.ChatProject {
	for _, p := range settings.Chain {
		if p.Rid == rid {
			return &api.ChatProject{Rid: p.Rid, Name: p.Name}
		}
	}
	return nil
}

// baseFor checks the base a project asks to inherit from: a live project other than the one
// asking, which the caller administers unless it is Texera, which does not inherit from the
// project asking (no loop), and which is public up its chain when the project is public.
func (s *Service) baseFor(ctx context.Context, caller *auth.Caller, project *store.Resource, rid uuid.UUID, public bool) (*store.Resource, error) {
	base, err := s.Store.GetResource(ctx, rid)
	if err != nil || base.Kind != projectKind.Name {
		return nil, NotFound("project " + rid.String())
	}
	if project != nil && base.RID == project.RID {
		return nil, Invalid("a project cannot inherit from itself", map[string]any{"field": "base"})
	}
	if !s.isRoot(base) {
		if err := s.require(ctx, caller, authz.Admin, base.RID); err != nil {
			return nil, &Error{Status: 403, Code: "forbidden", Message: fmt.Sprintf("a project inherits only from a project its admin administers too, or from Texera: %s is not yours to administer", base.Name)}
		}
	}
	chain, err := s.chainOf(ctx, base.RID)
	if err != nil {
		return nil, err
	}
	for i := range chain {
		if project != nil && chain[i].RID == project.RID {
			return nil, Invalid(fmt.Sprintf("%s inherits from %s already: a chain cannot loop", base.Name, project.Name), map[string]any{"field": "base"})
		}
		if public && chain[i].Visibility != "public" {
			return nil, Conflict("private_base", fmt.Sprintf("a public project's readers read what it inherits, and %s is private: make it public first or keep this project private", chain[i].Name), nil)
		}
	}
	return base, nil
}

// publicChain checks that a project may be public: every project up its chain is.
func (s *Service) publicChain(ctx context.Context, project *store.Resource) error {
	if project.BaseRID == nil {
		return nil
	}
	chain, err := s.chainOf(ctx, *project.BaseRID)
	if err != nil {
		return err
	}
	for i := range chain {
		if chain[i].Visibility != "public" {
			return Conflict("private_base", fmt.Sprintf("a public project's readers read what it inherits, and %s is private: make it public first or keep this project private", chain[i].Name), nil)
		}
	}
	return nil
}

// updateProject changes a project's metadata: its admins rename, describe, label, publish it and
// choose its base; the admins of its base may send it back to Texera, which inherits from
// nothing and stays open to everyone.
func (s *Service) updateProject(ctx context.Context, caller *auth.Caller, r *store.Resource, in MetadataInput) (*store.Resource, error) {
	if in.Parent != nil {
		return nil, Invalid("a project lives nowhere: it inherits from its base instead", map[string]any{"field": "parent"})
	}
	root := s.Root()
	detach := in.Base != nil && root != nil && *in.Base == root.RID && r.BaseRID != nil && *r.BaseRID != root.RID &&
		in.Name == nil && in.Description == nil && in.Visibility == nil && in.Labels == nil
	if detach && s.decide(ctx, caller, authz.Admin, r.RID) != nil {
		// Not the project's admin: the admin of what it inherits from may still let it go.
		if err := s.decide(ctx, caller, authz.Admin, *r.BaseRID); err != nil {
			return nil, err
		}
		updated, err := s.Store.UpdateMetadata(ctx, store.MetadataUpdate{RID: r.RID, BaseRID: in.Base, IfMatch: in.IfMatch})
		if err != nil {
			return nil, wrap(err, "project")
		}
		s.Relay.Flush(ctx)
		return updated, nil
	}
	if err := s.require(ctx, caller, authz.Read, r.RID); err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Admin, r.RID); err != nil {
		return nil, err
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		return nil, Invalid("a name is required", nil)
	}
	update := store.MetadataUpdate{RID: r.RID, Name: in.Name, Description: in.Description, IfMatch: in.IfMatch}
	if in.Labels != nil {
		update.Labels = keepIdentityLabels(r.Labels, in.Labels)
	}
	public := r.Visibility == "public"
	if in.Visibility != nil {
		if *in.Visibility != "public" && *in.Visibility != "private" {
			return nil, Invalid("visibility must be public or private", nil)
		}
		if s.isRoot(r) && *in.Visibility != "public" {
			return nil, Conflict("root", "Texera stays open to everyone: every project inherits from it", nil)
		}
		public = *in.Visibility == "public"
		update.Visibility = in.Visibility
	}
	if in.Base != nil {
		if s.isRoot(r) {
			return nil, Invalid("Texera inherits from nothing: it is the top of every chain", map[string]any{"field": "base"})
		}
		base, err := s.baseFor(ctx, caller, r, *in.Base, public)
		if err != nil {
			return nil, err
		}
		update.BaseRID = &base.RID
	} else if public && r.Visibility != "public" {
		if err := s.publicChain(ctx, r); err != nil {
			return nil, err
		}
	}
	updated, err := s.Store.UpdateMetadata(ctx, update)
	if err != nil {
		return nil, wrap(err, "project")
	}
	s.Relay.Flush(ctx)
	return updated, nil
}

// keepIdentityLabels takes a caller's labels for a resource, keeping the catalog's own as they
// were: a caller neither sets nor removes them.
func keepIdentityLabels(current, requested map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range requested {
		if !slices.Contains(identityLabels, k) {
			out[k] = v
		}
	}
	for _, k := range identityLabels {
		if v, ok := current[k]; ok {
			out[k] = v
		}
	}
	return out
}

// Inheritors lists, for a project's admins, the projects that inherit from it: they let them in,
// and they may send any back to Texera. They see each by name whether or not they may open it.
func (s *Service) Inheritors(ctx context.Context, caller *auth.Caller, rid uuid.UUID) ([]api.ProjectRef, error) {
	r, err := s.Get(ctx, caller, &projectKind, rid)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Admin, r.RID); err != nil {
		return nil, err
	}
	if s.isRoot(r) {
		return nil, Invalid("every project inherits from Texera unless it inherits from another: Texera lists none", nil)
	}
	inheritors, err := s.Store.Inheritors(ctx, r.RID, 500)
	if err != nil {
		return nil, err
	}
	out := make([]api.ProjectRef, 0, len(inheritors))
	for i := range inheritors {
		out = append(out, api.ProjectRef{Rid: api.Rid(inheritors[i].RID.String()), Name: inheritors[i].Name})
	}
	return out, nil
}

// beforeDeleteProject refuses to delete a project another inherits from: its people would lose
// what it gives them.
func (s *Service) beforeDeleteProject(ctx context.Context, r *store.Resource) error {
	inheritors, err := s.Store.Inheritors(ctx, r.RID, 50)
	if err != nil {
		return err
	}
	if len(inheritors) > 0 {
		var names []string
		for i := range inheritors {
			names = append(names, URI(&inheritors[i]).String())
		}
		return Conflict("inherited", fmt.Sprintf("%d projects inherit from %s: they need another base first", len(inheritors), r.Name), map[string]any{"inheritors": names})
	}
	return nil
}

// MakeAdministrator makes a person the identity provider names an administrator one of Texera's
// admins, when they are not one already.
func (s *Service) MakeAdministrator(ctx context.Context, p *store.Principal) error {
	root := s.Root()
	if root == nil {
		return nil
	}
	held, err := s.Store.DirectRelation(ctx, root.RID, p.PID)
	if err != nil || held == "owner" {
		return err
	}
	if _, err := s.Store.Grant(ctx, root.RID, p.PID, "owner"); err != nil {
		return err
	}
	s.Log.Info("an administrator is one of Texera's admins", "pid", p.PID)
	s.Relay.Flush(ctx)
	return nil
}

// offered refuses a workflow that names one of the engine's operator types its project does not
// offer: an operator of that type in the project or in one up its chain. Texera holds every
// operator of the engine a person may use, so a project offers them unless Texera's admins took
// one away; a custom operator is named by its URI and checked when it is compiled.
func (s *Service) offered(ctx context.Context, spec *api.WorkflowSpec, project *uuid.UUID) error {
	if project == nil {
		return nil
	}
	var types []string
	for i := range spec.Operators {
		t := spec.Operators[i].OperatorType
		if !uri.Is(t) && !slices.Contains(types, t) {
			types = append(types, t)
		}
	}
	if len(types) == 0 {
		return nil
	}
	chain, err := s.chainOf(ctx, *project)
	if err != nil {
		return err
	}
	rids := make([]uuid.UUID, len(chain))
	for i := range chain {
		rids[i] = chain[i].RID
	}
	have, err := s.Store.OfferedOperatorTypes(ctx, rids, types)
	if err != nil {
		return err
	}
	for i := range spec.Operators {
		op := &spec.Operators[i]
		if !uri.Is(op.OperatorType) && !have[op.OperatorType] {
			return Invalid(fmt.Sprintf("operator %s: %s is not an operator %s offers, nor any project it inherits from; list_operators says what it offers",
				op.OperatorID, op.OperatorType, chain[0].Name), map[string]any{"operator": op.OperatorID, "field": "operatorType"})
		}
	}
	return nil
}
