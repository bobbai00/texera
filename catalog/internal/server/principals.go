package server

import (
	"context"

	"github.com/apache/texera/catalog/internal/api"
)

// MeGet returns the caller and its home project.
func (s *Server) MeGet(ctx context.Context, _ api.MeGetRequestObject) (api.MeGetResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	home, err := s.homeProject(ctx, caller.Principal)
	if err != nil {
		return nil, err
	}
	return api.MeGet200JSONResponse(api.Whoami{Principal: toPrincipal(caller.Principal), HomeProject: home.RID.String()}), nil
}

// PrincipalsList searches principals (for sharing dialogs).
func (s *Server) PrincipalsList(ctx context.Context, req api.PrincipalsListRequestObject) (api.PrincipalsListResponseObject, error) {
	if _, err := callerOf(ctx); err != nil {
		return nil, err
	}
	q, kind := "", ""
	if req.Params.Q != nil {
		q = *req.Params.Q
	}
	if req.Params.Kind != nil {
		kind = string(*req.Params.Kind)
	}
	ps, err := s.store.SearchPrincipals(ctx, q, kind, limitOf(req.Params.Limit, 50))
	if err != nil {
		return nil, err
	}
	items := make([]api.Principal, 0, len(ps))
	for i := range ps {
		items = append(items, toPrincipal(&ps[i]))
	}
	return api.PrincipalsList200JSONResponse(api.PrincipalPage{Items: items}), nil
}

// PrincipalsRead returns one principal.
func (s *Server) PrincipalsRead(ctx context.Context, req api.PrincipalsReadRequestObject) (api.PrincipalsReadResponseObject, error) {
	if _, err := callerOf(ctx); err != nil {
		return nil, err
	}
	pid, err := parseRid(req.Pid)
	if err != nil {
		return nil, err
	}
	p, err := s.store.GetPrincipal(ctx, pid)
	if err != nil {
		return nil, err
	}
	return api.PrincipalsRead200JSONResponse(toPrincipal(p)), nil
}
