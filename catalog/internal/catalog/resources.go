package catalog

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

// CreateInput is what Create needs.
type CreateInput struct {
	Kind        kinds.Kind
	RID         *uuid.UUID
	Name        string
	Description *string
	Parent      *uuid.UUID
	// Base is, for a project, the project it inherits from; nil: Texera.
	Base       *uuid.UUID
	Visibility string
	Labels     map[string]string
	Spec       json.RawMessage
	Status     json.RawMessage
	Message    *string
	// Owner overrides the caller as owner; only a service caller may set it (seeding).
	Owner *uuid.UUID
}

// Create makes a resource of a top-level kind under a project, with its first version when
// the kind snapshots its spec.
func (s *Service) Create(ctx context.Context, caller *auth.Caller, in CreateInput) (*store.Resource, *store.Version, error) {
	k := in.Kind
	if k.Nested {
		return nil, nil, Invalid(k.Name+" is created through its parent", nil)
	}
	if strings.TrimSpace(in.Name) == "" {
		return nil, nil, Invalid("a name is required", nil)
	}
	var parent, project, base *uuid.UUID
	if k.Name != "project" {
		p, err := s.parentProject(ctx, caller, in.Parent)
		if err != nil {
			return nil, nil, err
		}
		parent, project = &p.RID, p.ProjectRID
	} else if root := s.Root(); root != nil {
		// A project inherits from Texera unless it names a base its creator administers.
		base = &root.RID
		if in.Base != nil {
			b, err := s.baseFor(ctx, caller, nil, *in.Base, in.Visibility == "public")
			if err != nil {
				return nil, nil, err
			}
			base = &b.RID
		}
	}
	if !caller.Service {
		in.Labels = keepIdentityLabels(nil, in.Labels)
	}
	owner := caller.PID()
	if in.Owner != nil && caller.Service {
		owner = *in.Owner
	}
	spec := in.Spec
	if len(spec) == 0 {
		spec = json.RawMessage(`{}`)
	}
	spec, err := s.prepareSpec(ctx, caller, k, in.Name, project, spec)
	if err != nil {
		return nil, nil, err
	}
	versioned := k.Versioned && k.Content == "spec"
	rid := uuid.New()
	if in.RID != nil {
		rid = *in.RID
	}
	from := uri.Of(k, rid.String())
	if versioned {
		from = from.WithVersion(1)
	}
	references, err := s.references(ctx, caller, rid, from, spec)
	if err != nil {
		return nil, nil, err
	}
	r, v, err := s.Store.CreateResource(ctx, store.NewResource{
		RID: &rid, Kind: k.Name, Name: strings.TrimSpace(in.Name), Description: in.Description, ParentRID: parent, ProjectRID: project, BaseRID: base,
		OwnerPID: owner, CreatedByPID: caller.PID(), Visibility: in.Visibility, Labels: in.Labels, Spec: spec, Status: in.Status, Origin: caller.Origin,
		Versioned: versioned, ContentKind: k.Content, Content: spec, Message: in.Message, References: references,
	})
	if err != nil {
		return nil, nil, wrap(err, k.Name)
	}
	if err := s.afterCreate(ctx, r); err != nil {
		_ = s.Store.DeleteResource(ctx, r.RID)
		return nil, nil, err
	}
	s.Relay.Flush(ctx)
	return r, v, nil
}

// parentProject resolves the project a new resource goes into: the given one, checked for
// write; else, for a call made in a chat, the chat's project when the caller may write to it,
// so what an agent makes is where the chat is; else the caller's home project.
func (s *Service) parentProject(ctx context.Context, caller *auth.Caller, parent *uuid.UUID) (*store.Resource, error) {
	if parent == nil {
		if chat := s.chatProject(ctx, caller); chat != nil && s.require(ctx, caller, authz.Write, chat.RID) == nil {
			return chat, nil
		}
		return s.HomeProject(ctx, caller)
	}
	p, err := s.Store.GetResource(ctx, *parent)
	if err != nil || p.Kind != "project" {
		return nil, NotFound("project " + parent.String())
	}
	if err := s.require(ctx, caller, authz.Write, p.RID); err != nil {
		return nil, err
	}
	return p, nil
}

// HomeProject returns the caller's personal project, creating it on first use.
func (s *Service) HomeProject(ctx context.Context, caller *auth.Caller) (*store.Resource, error) {
	pid := caller.PID()
	rs, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "project", OwnerPID: &pid, Labels: map[string]string{homeLabel: "true"}, Limit: 1})
	if err != nil {
		return nil, err
	}
	if len(rs) > 0 {
		return &rs[0], nil
	}
	name := caller.Principal.DisplayName
	if name == "" {
		name = "home"
	}
	var base *uuid.UUID
	if root := s.Root(); root != nil {
		base = &root.RID
	}
	r, _, err := s.Store.CreateResource(ctx, store.NewResource{
		Kind: "project", Name: name + "'s home", OwnerPID: pid, CreatedByPID: pid, BaseRID: base, Labels: map[string]string{homeLabel: "true"},
	})
	if err != nil {
		return nil, wrap(err, "project")
	}
	s.Relay.Flush(ctx)
	return r, nil
}

// Get returns a live resource the caller may read; kind, when given, must match.
func (s *Service) Get(ctx context.Context, caller *auth.Caller, kind *kinds.Kind, rid uuid.UUID) (*store.Resource, error) {
	r, err := s.Store.GetResource(ctx, rid)
	if err != nil || (kind != nil && r.Kind != kind.Name) {
		what := "resource"
		if kind != nil {
			what = kind.Name
		}
		return nil, NotFound(what + " " + rid.String())
	}
	if err := s.require(ctx, caller, authz.Read, rid); err != nil {
		return nil, err
	}
	return r, nil
}

// ListFilter selects resources for a list.
type ListFilter struct {
	// Scope is a project: the list holds what is in it and what it inherits, up its chain to
	// Texera. Absent, a call made in a chat is scoped to the chat's project, unless the filter
	// names its own place (a project, a parent, an origin).
	Scope   *uuid.UUID
	Parent  *uuid.UUID
	Project *uuid.UUID
	Origin  *uuid.UUID
	// Shared keeps what others shared with the caller: what they hold a grant on and do not own.
	Shared bool
	Query  string
	Fields map[string]string
	Labels map[string]string
	Limit  int
	Cursor string
}

// Page is a list with its cursor.
type Page struct {
	Items      []store.Resource
	NextCursor string
}

// pageSize is how many items a page holds: as many as were asked for, `usual` when nothing
// was, and never more than `most`. Asking for more than a page holds is asking for a full
// page, not for the usual one.
func pageSize(limit, usual, most int) int {
	switch {
	case limit <= 0:
		return usual
	case limit > most:
		return most
	}
	return limit
}

// List returns the resources of a kind (any kind when nil) the caller may read.
func (s *Service) List(ctx context.Context, caller *auth.Caller, kind *kinds.Kind, f ListFilter) (*Page, error) {
	limit := pageSize(f.Limit, 50, 200)
	offset := decodeCursor(f.Cursor)
	scope, err := s.scope(ctx, caller, f)
	if err != nil {
		return nil, err
	}
	filter := store.ResourceFilter{Scope: scope, ParentRID: f.Parent, ProjectRID: f.Project, OriginConversation: f.Origin, Query: f.Query, Fields: f.Fields, Labels: f.Labels, ReadableBy: readableBy(caller), Limit: limit + 1, Offset: offset}
	if kind != nil {
		filter.Kind = kind.Name
	}
	if f.Shared {
		pid := caller.PID()
		filter.SharedWith = &pid
	}
	rs, err := s.Store.ListResources(ctx, filter)
	if err != nil {
		return nil, err
	}
	page := &Page{Items: rs}
	if len(rs) > limit {
		page.Items = rs[:limit]
		page.NextCursor = encodeCursor(offset + limit)
	}
	return page, nil
}

// scope is the projects a list is narrowed to: the one the filter names, or the chat's for a
// call made in a chat, with every project up its chain, whose resources it inherits. Nil
// narrows nothing.
func (s *Service) scope(ctx context.Context, caller *auth.Caller, f ListFilter) ([]uuid.UUID, error) {
	project := f.Scope
	if project != nil {
		if p, err := s.Store.GetResource(ctx, *project); err != nil || p.Kind != projectKind.Name {
			return nil, Invalid("scope must name a project", nil)
		}
	} else if f.Project == nil && f.Parent == nil && f.Origin == nil && !f.Shared {
		if chat := s.chatProject(ctx, caller); chat != nil {
			project = &chat.RID
		}
	}
	if project == nil {
		return nil, nil
	}
	return s.chainRIDs(ctx, *project), nil
}

// chatProject is the project of the chat a call acts in, when the runtime vouches for one.
func (s *Service) chatProject(ctx context.Context, caller *auth.Caller) *store.Resource {
	if caller.Origin == nil {
		return nil
	}
	conversation, err := s.Store.GetResource(ctx, caller.Origin.Conversation)
	if err != nil || conversation.Kind != conversationKind.Name || conversation.ProjectRID == nil {
		return nil
	}
	project, err := s.Store.GetResource(ctx, *conversation.ProjectRID)
	if err != nil {
		return nil
	}
	return project
}

func encodeCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}

func decodeCursor(cursor string) int {
	if cursor == "" {
		return 0
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(string(raw))
	if n < 0 {
		return 0
	}
	return n
}

// UpdateSpecInput is what UpdateSpec needs.
type UpdateSpecInput struct {
	RID          uuid.UUID
	Spec         json.RawMessage
	Message      *string
	ExpectedHead *int
	IfMatch      string
	// OnBehalfOf names the people whose edits the new version holds, when the live service
	// saves for them.
	OnBehalfOf []uuid.UUID
}

// UpdateSpec replaces a spec; a kind that snapshots its spec gets a new version.
func (s *Service) UpdateSpec(ctx context.Context, caller *auth.Caller, k kinds.Kind, in UpdateSpecInput) (*store.Resource, *store.Version, error) {
	r, err := s.Get(ctx, caller, &k, in.RID)
	if err != nil {
		return nil, nil, err
	}
	// A project's settings are its admins' to change; what is in a project, its members'.
	permission := authz.Write
	if k.Name == projectKind.Name {
		permission = authz.Admin
	}
	if err := s.require(ctx, caller, permission, r.RID); err != nil {
		return nil, nil, err
	}
	if k.Name == "workflow" {
		in.Spec = keepLayout(in.Spec, r.Spec)
	}
	spec, err := s.prepareSpec(ctx, caller, k, r.Name, r.ProjectRID, in.Spec)
	if err != nil {
		return nil, nil, err
	}
	if err := s.beforeUpdate(ctx, r, spec); err != nil {
		return nil, nil, err
	}
	versioned := k.Versioned && k.Content == "spec"
	from := URI(r)
	expected := in.ExpectedHead
	if versioned {
		if expected == nil {
			head := r.HeadVno
			expected = &head
		}
		from = from.WithVersion(*expected + 1)
	}
	references, err := s.references(ctx, caller, r.RID, from, spec)
	if err != nil {
		return nil, nil, err
	}
	creator, contributors, err := s.authorsOf(ctx, caller, in.OnBehalfOf)
	if err != nil {
		return nil, nil, err
	}
	updated, v, err := s.Store.UpdateSpec(ctx, store.SpecUpdate{
		RID: r.RID, Spec: spec, ExpectedHead: expected, IfMatch: in.IfMatch, Versioned: versioned, ContentKind: k.Content, Content: spec,
		Message: in.Message, CreatedByPID: creator, Contributors: contributors, Origin: caller.Origin, From: from.String(), References: references,
	})
	if err != nil {
		return nil, nil, wrap(err, k.Name)
	}
	if err := s.afterUpdate(ctx, r, updated); err != nil {
		return nil, nil, err
	}
	return updated, v, nil
}

// MetadataInput is what UpdateMetadata needs; nil fields are kept.
type MetadataInput struct {
	RID         uuid.UUID
	Name        *string
	Description *string
	Parent      *uuid.UUID
	// Base is a project's new base.
	Base       *uuid.UUID
	Visibility *string
	Labels     map[string]string
	IfMatch    string
}

// UpdateMetadata renames, describes, moves, publishes or labels a resource; a project's admins
// do so for their project, and choose what it inherits from.
func (s *Service) UpdateMetadata(ctx context.Context, caller *auth.Caller, in MetadataInput) (*store.Resource, error) {
	if r, err := s.Store.GetResource(ctx, in.RID); err == nil && r.Kind == projectKind.Name {
		return s.updateProject(ctx, caller, r, in)
	}
	r, err := s.Get(ctx, caller, nil, in.RID)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Write, r.RID); err != nil {
		return nil, err
	}
	if in.Base != nil {
		return nil, Invalid("only a project inherits from a base", map[string]any{"field": "base"})
	}
	update := store.MetadataUpdate{RID: r.RID, Name: in.Name, Description: in.Description, IfMatch: in.IfMatch}
	if in.Labels != nil {
		update.Labels = keepIdentityLabels(r.Labels, in.Labels)
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		return nil, Invalid("a name is required", nil)
	}
	if in.Visibility != nil {
		if *in.Visibility != "public" && *in.Visibility != "private" {
			return nil, Invalid("visibility must be public or private", nil)
		}
		if err := s.require(ctx, caller, authz.Share, r.RID); err != nil {
			return nil, err
		}
		update.Visibility = in.Visibility
	}
	if in.Parent != nil {
		k, _ := kinds.ByName(r.Kind)
		if k.Nested {
			return nil, Invalid(r.Kind+" cannot be moved", nil)
		}
		p, err := s.parentProject(ctx, caller, in.Parent)
		if err != nil {
			return nil, err
		}
		update.ParentRID, update.ProjectRID = &p.RID, p.ProjectRID
	}
	updated, err := s.Store.UpdateMetadata(ctx, update)
	if err != nil {
		return nil, wrap(err, r.Kind)
	}
	s.Relay.Flush(ctx)
	return updated, nil
}

// Delete removes a resource that nothing references and that has no children.
func (s *Service) Delete(ctx context.Context, caller *auth.Caller, kind *kinds.Kind, rid uuid.UUID) error {
	r, err := s.Get(ctx, caller, kind, rid)
	if err != nil {
		return err
	}
	if err := s.require(ctx, caller, authz.Delete, r.RID); err != nil {
		return err
	}
	if s.isRoot(r) {
		return Conflict("root", "Texera holds what every project inherits: it cannot be deleted", nil)
	}
	if n, err := s.Store.CountChildren(ctx, r.RID); err != nil {
		return err
	} else if n > 0 {
		return Conflict("has_children", fmt.Sprintf("%s holds %d resources; delete or move them first", r.Name, n), nil)
	}
	deps, err := s.Store.Dependents(ctx, r.RID, 0)
	if err != nil {
		return err
	}
	if len(deps) > 0 {
		var from []string
		for _, d := range deps {
			from = append(from, d.From)
		}
		return Conflict("referenced", fmt.Sprintf("%s is referenced by %d resources", r.Name, len(from)), map[string]any{"dependents": from})
	}
	if err := s.beforeDelete(ctx, r); err != nil {
		return err
	}
	if err := s.Store.DeleteResource(ctx, r.RID); err != nil {
		return wrap(err, r.Kind)
	}
	s.Relay.Flush(ctx)
	return nil
}

// Versions lists a resource's versions, newest first.
func (s *Service) Versions(ctx context.Context, caller *auth.Caller, kind *kinds.Kind, rid uuid.UUID, limit int, cursor string) (*store.Resource, []store.Version, string, error) {
	r, err := s.Get(ctx, caller, kind, rid)
	if err != nil {
		return nil, nil, "", err
	}
	limit = pageSize(limit, 50, 200)
	offset := decodeCursor(cursor)
	vs, err := s.Store.ListVersions(ctx, rid, limit+1, offset)
	if err != nil {
		return nil, nil, "", err
	}
	next := ""
	if len(vs) > limit {
		vs = vs[:limit]
		next = encodeCursor(offset + limit)
	}
	return r, vs, next, nil
}

// Version returns one version; vno <= 0 means the head.
func (s *Service) Version(ctx context.Context, caller *auth.Caller, kind *kinds.Kind, rid uuid.UUID, vno int) (*store.Resource, *store.Version, error) {
	r, err := s.Get(ctx, caller, kind, rid)
	if err != nil {
		return nil, nil, err
	}
	v, err := s.Store.GetVersion(ctx, rid, vno)
	if err != nil {
		return nil, nil, NotFound(fmt.Sprintf("version %d of %s", vno, r.Name))
	}
	return r, v, nil
}

// Grants lists a resource's direct grants, for whoever may share it.
func (s *Service) Grants(ctx context.Context, caller *auth.Caller, rid uuid.UUID) ([]store.Grant, error) {
	if _, err := s.Get(ctx, caller, nil, rid); err != nil {
		return nil, err
	}
	if err := s.decide(ctx, caller, authz.Share, rid); err != nil {
		return nil, err
	}
	return s.Store.ListGrants(ctx, rid)
}

// Grant gives a principal a relation on a resource.
func (s *Service) Grant(ctx context.Context, caller *auth.Caller, rid, pid uuid.UUID, relation string) (*store.Grant, error) {
	if _, err := s.Get(ctx, caller, nil, rid); err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Share, rid); err != nil {
		return nil, err
	}
	if !store.ValidRelation(relation) {
		return nil, Invalid("relation must be owner, editor, viewer or user", nil)
	}
	if _, err := s.Store.GetPrincipal(ctx, pid); err != nil {
		return nil, NotFound("principal " + pid.String())
	}
	g, err := s.Store.Grant(ctx, rid, pid, relation)
	if err != nil {
		return nil, wrap(err, "grant")
	}
	s.Relay.Flush(ctx)
	return g, nil
}

// Revoke removes a principal's relation; the owner's own grant stays.
func (s *Service) Revoke(ctx context.Context, caller *auth.Caller, rid, pid uuid.UUID) error {
	r, err := s.Get(ctx, caller, nil, rid)
	if err != nil {
		return err
	}
	if err := s.require(ctx, caller, authz.Share, rid); err != nil {
		return err
	}
	if r.OwnerPID == pid {
		return Conflict("owner", "the owner's grant cannot be revoked", nil)
	}
	if err := s.Store.Revoke(ctx, rid, pid); err != nil {
		return wrap(err, "grant")
	}
	s.Relay.Flush(ctx)
	return nil
}

// Resolved is what a URI names.
type Resolved struct {
	Resource    *store.Resource
	Version     *store.Version
	Subresource string
}

// Resolve finds what a URI names, checking read access.
func (s *Service) Resolve(ctx context.Context, caller *auth.Caller, name string) (*Resolved, error) {
	ref, err := uri.Parse(name)
	if err != nil {
		return nil, Invalid(err.Error(), nil)
	}
	var r *store.Resource
	{
		rid, err := uuid.Parse(ref.Rid)
		if err != nil {
			return nil, Invalid(err.Error(), nil)
		}
		r, err = s.Get(ctx, caller, &ref.Kind, rid)
		if err != nil {
			return nil, err
		}
		if ref.Parent != "" && (r.ParentRID == nil || r.ParentRID.String() != ref.Parent) {
			return nil, NotFound(name)
		}
	}
	out := &Resolved{Resource: r, Subresource: ref.Subresource}
	if ref.Vno > 0 {
		v, err := s.Store.GetVersion(ctx, r.RID, ref.Vno)
		if err != nil {
			return nil, NotFound(name)
		}
		out.Version = v
	}
	return out, nil
}

// Lineage walks the graph from a resource or one of its versions.
func (s *Service) Lineage(ctx context.Context, caller *auth.Caller, rid uuid.UUID, vno int, direction string, depth int) (string, []store.Edge, error) {
	r, err := s.Get(ctx, caller, nil, rid)
	if err != nil {
		return "", nil, err
	}
	root := URI(r)
	if vno > 0 {
		root = root.WithVersion(vno)
	}
	up := direction == "upstream" || direction == "both" || direction == ""
	down := direction == "downstream" || direction == "both" || direction == ""
	edges, err := s.Store.Walk(ctx, root.String(), up, down, depth)
	if err != nil {
		return "", nil, err
	}
	return root.String(), edges, nil
}

// Dependents lists the live resources whose specs reference a resource or version.
func (s *Service) Dependents(ctx context.Context, caller *auth.Caller, rid uuid.UUID, vno int) ([]store.Edge, error) {
	if _, err := s.Get(ctx, caller, nil, rid); err != nil {
		return nil, err
	}
	return s.Store.Dependents(ctx, rid, vno)
}

// references extracts every resource name from a document, checks that each resolves to
// something the caller may read, and returns the edges to record.
func (s *Service) references(ctx context.Context, caller *auth.Caller, fromRID uuid.UUID, from uri.Ref, doc json.RawMessage) ([]store.Edge, error) {
	var v any
	if err := json.Unmarshal(doc, &v); err != nil {
		return nil, Invalid("not JSON: "+err.Error(), nil)
	}
	found := uri.Extract(v)
	var edges []store.Edge
	for pointer, ref := range found {
		rid, err := uuid.Parse(ref.Rid)
		if err != nil {
			return nil, Invalid("bad reference at "+pointer, nil)
		}
		if rid == fromRID {
			continue
		}
		r, err := s.Store.GetResource(ctx, rid)
		if err != nil || r.Kind != ref.Kind.Name {
			return nil, Invalid(fmt.Sprintf("%s does not exist", ref.String()), map[string]any{"field": pointer})
		}
		if err := s.require(ctx, caller, authz.Read, rid); err != nil {
			return nil, Invalid(fmt.Sprintf("%s is not readable", ref.String()), map[string]any{"field": pointer})
		}
		if ref.Vno > 0 {
			if _, err := s.Store.GetVersion(ctx, rid, ref.Vno); err != nil {
				return nil, Invalid(fmt.Sprintf("%s has no version %d", ref.Resource().String(), ref.Vno), map[string]any{"field": pointer})
			}
		}
		field := pointer
		to := rid
		edges = append(edges, store.Edge{From: from.String(), Relation: "references", To: ref.String(), FromRID: fromRID, ToRID: &to, Field: &field})
	}
	return edges, nil
}
