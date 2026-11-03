package server

import (
	"context"
	"encoding/json"
	"time"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/engine"
	"github.com/apache/texera/catalog/internal/store"
)

// unitFor resolves a computing unit resource to a client for its endpoint. Only static
// units have endpoints in this slice; other kinds are the unit operator's job.
func (s *Server) unitFor(ctx context.Context, r *store.Resource) (*engine.Unit, error) {
	var spec api.ComputingUnitSpec
	if err := json.Unmarshal(r.Spec, &spec); err != nil {
		return nil, badRequest("unit spec: %v", err)
	}
	if spec.Endpoint == nil || *spec.Endpoint == "" {
		return nil, &Problem{Status: 503, Code: "unit_unavailable", Message: "the unit has no endpoint yet"}
	}
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return nil, unavailable("service token", err)
	}
	return engine.NewUnit(*spec.Endpoint, token)
}

// unitStatus probes a unit's health and reports its phase and gateway path.
func (s *Server) unitStatus(ctx context.Context, u *api.ComputingUnit) *api.ComputingUnitStatus {
	st := api.ComputingUnitStatus{Phase: api.ComputingUnitStatusPhasePending}
	path := "/units/" + u.Metadata.Rid
	st.GatewayPath = &path
	if u.Status != nil && u.Status.Phase == api.ComputingUnitStatusPhaseTerminated {
		st.Phase = api.ComputingUnitStatusPhaseTerminated
		return &st
	}
	if u.Spec.Endpoint == nil || *u.Spec.Endpoint == "" {
		return &st
	}
	probe, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	unit, err := engine.NewUnit(*u.Spec.Endpoint, "")
	if err != nil {
		msg := err.Error()
		st.Phase, st.Message = api.ComputingUnitStatusPhaseFailed, &msg
		return &st
	}
	if _, err := unit.Health(probe); err != nil {
		msg := err.Error()
		st.Phase, st.Message = api.ComputingUnitStatusPhaseFailed, &msg
		return &st
	}
	st.Phase = api.ComputingUnitStatusPhaseReady
	return &st
}

// pickUnit chooses the unit for a run: the requested one, the workflow's default, or the
// first ready unit the caller may use.
func (s *Server) pickUnit(ctx context.Context, caller *authn.Caller, requested *api.Rid, wfSpec api.WorkflowSpec) (*store.Resource, error) {
	if requested != nil && *requested != "" {
		return s.loadResource(ctx, caller, *requested, "computing_unit", authz.ActionRead)
	}
	if wfSpec.DefaultComputingUnit != nil && *wfSpec.DefaultComputingUnit != "" {
		return s.loadResource(ctx, caller, *wfSpec.DefaultComputingUnit, "computing_unit", authz.ActionRead)
	}
	rs, err := s.store.SearchResources(ctx, store.ResourceFilter{Kind: "computing_unit", ReadableBy: &caller.Principal.PID, Limit: 50})
	if err != nil {
		return nil, err
	}
	for i := range rs {
		var st api.ComputingUnitStatus
		if len(rs[i].Status) > 0 && json.Unmarshal(rs[i].Status, &st) == nil && st.Phase == api.ComputingUnitStatusPhaseTerminated {
			continue
		}
		return &rs[i], nil
	}
	return nil, &Problem{Status: 409, Code: "no_unit", Message: "no computing unit is available; create one or ask an administrator"}
}
