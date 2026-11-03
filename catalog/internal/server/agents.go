package server

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/store"
)

// AgentsSpawn creates an agent principal from a template for a conversation or an execution.
func (s *Server) AgentsSpawn(ctx context.Context, req api.AgentsSpawnRequestObject) (api.AgentsSpawnResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	tpl, err := s.loadResource(ctx, caller, req.Body.Template.Rid, "agent_template", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	vno := req.Body.Template.Vno
	if vno <= 0 {
		vno = tpl.HeadVno
	}
	var spec api.AgentTemplateSpec
	_ = json.Unmarshal(tpl.Spec, &spec)
	in := store.NewAgent{DisplayName: spec.Card.Name, SponsorPID: caller.Principal.PID, TemplateRID: tpl.RID, TemplateVno: vno}
	if req.Body.DisplayName != nil && *req.Body.DisplayName != "" {
		in.DisplayName = *req.Body.DisplayName
	}
	if in.DisplayName == "" {
		in.DisplayName = tpl.Name
	}
	if req.Body.Lifetime != nil {
		in.Lifetime = string(*req.Body.Lifetime)
	}
	if caller.Agent != nil {
		spawner := caller.Agent.PID
		in.SpawnedByPID = &spawner
	}
	if req.Body.Conversation != nil {
		conv, err := s.loadResource(ctx, caller, *req.Body.Conversation, "conversation", authz.ActionWrite)
		if err != nil {
			return nil, err
		}
		in.ConversationRID = &conv.RID
	}
	if req.Body.Execution != nil {
		eid, err := uuid.Parse(*req.Body.Execution)
		if err != nil {
			return nil, badRequest("bad execution id")
		}
		in.EID = &eid
		in.Opid = req.Body.Opid
		if in.Lifetime == "" {
			in.Lifetime = "execution"
		}
	}
	a, err := s.store.SpawnAgent(ctx, in)
	if err != nil {
		return nil, err
	}
	s.drainer.Kick()
	return api.AgentsSpawn200JSONResponse(toAgent(a)), nil
}

// AgentsRead returns an agent (its sponsor, the service identity, or anyone who may read
// its conversation).
func (s *Server) AgentsRead(ctx context.Context, req api.AgentsReadRequestObject) (api.AgentsReadResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	pid, err := uuid.Parse(req.Pid)
	if err != nil {
		return nil, badRequest("bad agent id")
	}
	a, err := s.store.GetAgent(ctx, pid)
	if err != nil {
		return nil, err
	}
	if err := s.mayAccessAgent(ctx, caller, a); err != nil {
		return nil, err
	}
	return api.AgentsRead200JSONResponse(toAgent(a)), nil
}

func (s *Server) mayAccessAgent(ctx context.Context, caller *callerT, a *store.Agent) error {
	if caller.IsService {
		return nil
	}
	p, err := s.store.GetPrincipal(ctx, a.PID)
	if err == nil && p.SponsorPID != nil && *p.SponsorPID == caller.Principal.PID {
		return nil
	}
	if a.ConversationRID != nil {
		return s.pdp.Require(ctx, caller, authz.ActionRead, *a.ConversationRID)
	}
	return forbidden()
}

// AgentsRetire marks an agent retired.
func (s *Server) AgentsRetire(ctx context.Context, req api.AgentsRetireRequestObject) (api.AgentsRetireResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	pid, err := uuid.Parse(req.Pid)
	if err != nil {
		return nil, badRequest("bad agent id")
	}
	a, err := s.store.GetAgent(ctx, pid)
	if err != nil {
		return nil, err
	}
	if err := s.mayAccessAgent(ctx, caller, a); err != nil {
		return nil, err
	}
	a, err = s.store.RetireAgent(ctx, pid)
	if err != nil {
		return nil, err
	}
	return api.AgentsRetire200JSONResponse(toAgent(a)), nil
}

// AgentsList lists agents of a conversation or execution.
func (s *Server) AgentsList(ctx context.Context, req api.AgentsListRequestObject) (api.AgentsListResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	var conv, eid *uuid.UUID
	if req.Params.Conversation != nil {
		r, err := s.loadResource(ctx, caller, *req.Params.Conversation, "conversation", authz.ActionRead)
		if err != nil {
			return nil, err
		}
		conv = &r.RID
	}
	if req.Params.Execution != nil {
		ex, err := s.loadExecution(ctx, caller, *req.Params.Execution, authz.ActionRead)
		if err != nil {
			return nil, err
		}
		eid = &ex.EID
	}
	if conv == nil && eid == nil {
		return nil, badRequest("conversation or execution is required")
	}
	as, err := s.store.ListAgents(ctx, conv, eid)
	if err != nil {
		return nil, err
	}
	out := make([]api.Agent, 0, len(as))
	for i := range as {
		out = append(out, toAgent(&as[i]))
	}
	return api.AgentsList200JSONResponse(out), nil
}
