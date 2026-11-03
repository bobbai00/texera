package server

import (
	"context"
	"encoding/json"

	jsonpatch "github.com/evanphx/json-patch/v5"
	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/store"
)

// ResourcesSearch lists resources the caller may read.
func (s *Server) ResourcesSearch(ctx context.Context, req api.ResourcesSearchRequestObject) (api.ResourcesSearchResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	f := store.ResourceFilter{Limit: limitOf(req.Params.Limit, 50), Offset: decodeCursor(req.Params.Cursor), ReadableBy: &caller.Principal.PID}
	if req.Params.Q != nil {
		f.Query = *req.Params.Q
	}
	if req.Params.Kind != nil {
		f.Kind = string(*req.Params.Kind)
	}
	if req.Params.Project != nil {
		rid, err := parseRid(*req.Params.Project)
		if err != nil {
			return nil, err
		}
		f.ParentRID = &rid
	}
	if req.Params.Origin != nil {
		rid, err := parseRid(*req.Params.Origin)
		if err != nil {
			return nil, err
		}
		f.Origin = &rid
	}
	rs, err := s.store.SearchResources(ctx, f)
	if err != nil {
		return nil, err
	}
	items := make([]api.Resource, 0, len(rs))
	for i := range rs {
		items = append(items, toResource(&rs[i]))
	}
	return api.ResourcesSearch200JSONResponse(api.ResourcePage{Items: items, NextCursor: encodeCursor(f.Offset, len(rs), f.Limit)}), nil
}

// ResourcesRead returns the untyped envelope.
func (s *Server) ResourcesRead(ctx context.Context, req api.ResourcesReadRequestObject) (api.ResourcesReadResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	return api.ResourcesRead200JSONResponse(toResource(r)), nil
}

// ResourcesUpdateMetadata patches name, description, project, visibility and labels.
func (s *Server) ResourcesUpdateMetadata(ctx context.Context, req api.ResourcesUpdateMetadataRequestObject) (api.ResourcesUpdateMetadataResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "", authz.ActionWrite)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	p := store.MetadataPatch{Name: req.Body.Name, Description: req.Body.Description}
	if req.Body.Visibility != nil {
		v := string(*req.Body.Visibility)
		if v == "public" {
			if err := s.pdp.Require(ctx, caller, authz.ActionShare, r.RID); err != nil {
				return nil, err
			}
		}
		p.Visibility = &v
	}
	if req.Body.Labels != nil {
		p.Labels = *req.Body.Labels
	}
	if req.Body.Project != nil {
		proj, err := s.loadResource(ctx, caller, *req.Body.Project, "project", authz.ActionWrite)
		if err != nil {
			return nil, err
		}
		p.ParentRID = &proj.RID
	}
	out, err := s.store.UpdateMetadata(ctx, r.RID, p)
	if err != nil {
		return nil, err
	}
	s.drainer.Kick()
	return api.ResourcesUpdateMetadata200JSONResponse(toResource(out)), nil
}

// ResourcesDelete soft-deletes a resource.
func (s *Server) ResourcesDelete(ctx context.Context, req api.ResourcesDeleteRequestObject) (api.ResourcesDeleteResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "", authz.ActionDelete)
	if err != nil {
		return nil, err
	}
	if err := s.store.SoftDeleteResource(ctx, r.RID); err != nil {
		return nil, err
	}
	s.drainer.Kick()
	return api.ResourcesDelete204Response{}, nil
}

// ResourcesListVersions lists versions newest first.
func (s *Server) ResourcesListVersions(ctx context.Context, req api.ResourcesListVersionsRequestObject) (api.ResourcesListVersionsResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	limit, offset := limitOf(req.Params.Limit, 50), decodeCursor(req.Params.Cursor)
	vs, err := s.store.ListVersions(ctx, r.RID, limit, offset)
	if err != nil {
		return nil, err
	}
	items := make([]api.ResourceVersion, 0, len(vs))
	for i := range vs {
		items = append(items, toVersion(&vs[i], r.Kind))
	}
	return api.ResourcesListVersions200JSONResponse(api.VersionPage{Items: items, NextCursor: encodeCursor(offset, len(vs), limit)}), nil
}

// ResourcesReadVersion returns one version with content.
func (s *Server) ResourcesReadVersion(ctx context.Context, req api.ResourcesReadVersionRequestObject) (api.ResourcesReadVersionResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	v, err := s.store.GetVersion(ctx, r.RID, req.Vno)
	if err != nil {
		if store.IsNotFound(err) {
			return nil, notFound("version")
		}
		return nil, err
	}
	return api.ResourcesReadVersion200JSONResponse(toVersion(v, r.Kind)), nil
}

// ResourcesCreateVersion appends a version from full content or a JSON Patch.
func (s *Server) ResourcesCreateVersion(ctx context.Context, req api.ResourcesCreateVersionRequestObject) (api.ResourcesCreateVersionResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "", authz.ActionWrite)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	v, err := s.newVersion(ctx, caller, r, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.ResourcesCreateVersion200JSONResponse(toVersion(v, r.Kind)), nil
}

// newVersion applies CreateVersion semantics: full content, or a patch over the head.
func (s *Server) newVersion(ctx context.Context, caller *callerT, r *store.Resource, body api.CreateVersion) (*store.Version, error) {
	origin, err := originFor(caller, body.Origin)
	if err != nil {
		return nil, err
	}
	var content json.RawMessage
	switch {
	case body.Patch != nil:
		head, err := s.store.GetVersion(ctx, r.RID, 0)
		if err != nil {
			if store.IsNotFound(err) {
				return nil, badRequest("the resource has no version to patch")
			}
			return nil, err
		}
		patchDoc, err := json.Marshal(*body.Patch)
		if err != nil {
			return nil, badRequest("invalid patch: %v", err)
		}
		patch, err := jsonpatch.DecodePatch(patchDoc)
		if err != nil {
			return nil, badRequest("invalid patch: %v", err)
		}
		base := head.Content
		if len(base) == 0 {
			base = json.RawMessage(`{}`)
		}
		content, err = patch.ApplyWithOptions(base, &jsonpatch.ApplyOptions{EnsurePathExistsOnAdd: true, AllowMissingPathOnRemove: false})
		if err != nil {
			return nil, badRequest("patch does not apply: %v", err)
		}
		if body.ExpectedHead == nil {
			h := head.Vno
			body.ExpectedHead = &h
		}
	case body.Content != nil:
		content, err = json.Marshal(body.Content)
		if err != nil {
			return nil, badRequest("invalid content")
		}
	default:
		return nil, badRequest("content or patch is required")
	}
	v, err := s.store.CreateVersion(ctx, store.NewVersion{
		RID: r.RID, Content: content, Message: body.Message, CreatedByPID: caller.Actor(), OnBehalfOfPID: onBehalfOf(caller),
		Origin: origin, ExpectedHead: body.ExpectedHead,
	})
	if err != nil {
		if store.IsConflict(err) {
			return nil, conflict("the head version moved; reload and retry")
		}
		return nil, err
	}
	return v, nil
}

// ResourcesLineage returns version edges around a version.
func (s *Server) ResourcesLineage(ctx context.Context, req api.ResourcesLineageRequestObject) (api.ResourcesLineageResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	var vno int32
	if req.Params.Vno != nil {
		vno = *req.Params.Vno
	}
	up, down, err := s.store.Lineage(ctx, r.RID, vno)
	if err != nil {
		return nil, err
	}
	out := api.Lineage{Upstream: []api.VersionEdge{}, Downstream: []api.VersionEdge{}}
	for _, e := range up {
		out.Upstream = append(out.Upstream, toEdge(e))
	}
	for _, e := range down {
		out.Downstream = append(out.Downstream, toEdge(e))
	}
	return api.ResourcesLineage200JSONResponse(out), nil
}

// ResourcesListGrants lists grants (share permission required).
func (s *Server) ResourcesListGrants(ctx context.Context, req api.ResourcesListGrantsRequestObject) (api.ResourcesListGrantsResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	gs, err := s.store.ListGrants(ctx, r.RID)
	if err != nil {
		return nil, err
	}
	out := make([]api.Grant, 0, len(gs))
	for i := range gs {
		out = append(out, toGrant(&gs[i]))
	}
	return api.ResourcesListGrants200JSONResponse(out), nil
}

// ResourcesGrant upserts a grant.
func (s *Server) ResourcesGrant(ctx context.Context, req api.ResourcesGrantRequestObject) (api.ResourcesGrantResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "", authz.ActionShare)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	pid, err := uuid.Parse(req.Pid)
	if err != nil {
		return nil, badRequest("bad principal id")
	}
	if _, err := s.store.GetPrincipal(ctx, pid); err != nil {
		return nil, notFound("principal")
	}
	g, err := s.store.PutGrant(ctx, r.RID, pid, string(req.Body.Relation))
	if err != nil {
		return nil, err
	}
	s.drainer.Kick()
	return api.ResourcesGrant200JSONResponse(toGrant(g)), nil
}

// ResourcesRevoke deletes a grant.
func (s *Server) ResourcesRevoke(ctx context.Context, req api.ResourcesRevokeRequestObject) (api.ResourcesRevokeResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "", authz.ActionShare)
	if err != nil {
		return nil, err
	}
	pid, err := uuid.Parse(req.Pid)
	if err != nil {
		return nil, badRequest("bad principal id")
	}
	if pid == r.OwnerPID {
		return nil, badRequest("the owner's grant cannot be revoked")
	}
	if err := s.store.DeleteGrant(ctx, r.RID, pid); err != nil {
		return nil, err
	}
	s.drainer.Kick()
	return api.ResourcesRevoke204Response{}, nil
}
