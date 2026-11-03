package server

import (
	"context"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/store"
)

// EvaluationEvaluate answers an AuthZEN access evaluation. The subject defaults to the
// caller; a service caller may ask about any principal.
func (s *Server) EvaluationEvaluate(ctx context.Context, req api.EvaluationEvaluateRequestObject) (api.EvaluationEvaluateResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	subject := caller
	if req.Body.Subject.Id != "" && req.Body.Subject.Id != caller.Principal.PID.String() {
		if !caller.IsService {
			return nil, forbidden()
		}
		pid, err := uuid.Parse(req.Body.Subject.Id)
		if err != nil {
			return nil, badRequest("subject.id must be a principal id")
		}
		p, err := s.store.GetPrincipal(ctx, pid)
		if err != nil {
			if store.IsNotFound(err) {
				return api.EvaluationEvaluate200JSONResponse(api.AuthzResponse{Decision: false}), nil
			}
			return nil, err
		}
		subject = &authn.Caller{Principal: p}
	}
	rid, err := uuid.Parse(req.Body.Resource.Id)
	if err != nil {
		return nil, badRequest("resource.id must be a resource id")
	}
	var action authz.Action
	switch req.Body.Action.Name {
	case "read", "can_read", "view":
		action = authz.ActionRead
	case "write", "can_write", "edit":
		action = authz.ActionWrite
	case "share", "can_share":
		action = authz.ActionShare
	case "delete", "can_delete":
		action = authz.ActionDelete
	default:
		return nil, badRequest("unknown action %q", req.Body.Action.Name)
	}
	ok, err := s.pdp.Allowed(ctx, subject, action, rid)
	if err != nil {
		return nil, err
	}
	return api.EvaluationEvaluate200JSONResponse(api.AuthzResponse{Decision: ok}), nil
}
