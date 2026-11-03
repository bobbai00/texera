package server

import (
	"context"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/store"
)

// loadExecution fetches an execution and checks read access on its workflow.
func (s *Server) loadExecution(ctx context.Context, caller *authn.Caller, eidStr string, action authz.Action) (*store.Execution, error) {
	eid, err := uuid.Parse(eidStr)
	if err != nil {
		return nil, badRequest("bad execution id")
	}
	ex, err := s.store.GetExecution(ctx, eid)
	if err != nil {
		if store.IsNotFound(err) {
			return nil, notFound("execution")
		}
		return nil, err
	}
	if err := s.pdp.Require(ctx, caller, action, ex.WorkflowRID); err != nil {
		return nil, err
	}
	return ex, nil
}

// ExecutionsList lists executions by workflow or conversation.
func (s *Server) ExecutionsList(ctx context.Context, req api.ExecutionsListRequestObject) (api.ExecutionsListResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	var wf, conv *uuid.UUID
	if req.Params.Workflow != nil {
		r, err := s.loadResource(ctx, caller, *req.Params.Workflow, "workflow", authz.ActionRead)
		if err != nil {
			return nil, err
		}
		wf = &r.RID
	}
	if req.Params.Conversation != nil {
		r, err := s.loadResource(ctx, caller, *req.Params.Conversation, "conversation", authz.ActionRead)
		if err != nil {
			return nil, err
		}
		conv = &r.RID
	}
	if wf == nil && conv == nil {
		return nil, badRequest("workflow or conversation is required")
	}
	limit, offset := limitOf(req.Params.Limit, 50), decodeCursor(req.Params.Cursor)
	exs, err := s.store.ListExecutions(ctx, wf, conv, limit, offset)
	if err != nil {
		return nil, err
	}
	items := make([]api.Execution, 0, len(exs))
	for i := range exs {
		items = append(items, s.executionView(ctx, exs[i].EID))
	}
	return api.ExecutionsList200JSONResponse(api.ExecutionPage{Items: items, NextCursor: encodeCursor(offset, len(exs), limit)}), nil
}

// ExecutionsRead returns one execution.
func (s *Server) ExecutionsRead(ctx context.Context, req api.ExecutionsReadRequestObject) (api.ExecutionsReadResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	ex, err := s.loadExecution(ctx, caller, req.Eid, authz.ActionRead)
	if err != nil {
		return nil, err
	}
	return api.ExecutionsRead200JSONResponse(s.executionView(ctx, ex.EID)), nil
}

// ExecutionsCancel asks the unit to stop a run.
func (s *Server) ExecutionsCancel(ctx context.Context, req api.ExecutionsCancelRequestObject) (api.ExecutionsCancelResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	ex, err := s.loadExecution(ctx, caller, req.Eid, authz.ActionRead)
	if err != nil {
		return nil, err
	}
	switch ex.Status {
	case "completed", "failed", "cancelled":
		return api.ExecutionsCancel200JSONResponse(s.executionView(ctx, ex.EID)), nil
	}
	unitRes, err := s.store.GetResource(ctx, ex.CuRID)
	if err == nil {
		if unit, err := s.unitFor(ctx, unitRes); err == nil {
			_, _ = unit.Cancel(ctx, ex.EID.String())
		}
	}
	if _, err := s.store.SetExecutionStatus(ctx, ex.EID, "cancelled", nil); err != nil {
		return nil, err
	}
	return api.ExecutionsCancel200JSONResponse(s.executionView(ctx, ex.EID)), nil
}

// ExecutionsResult reads a page of a port result from the unit.
func (s *Server) ExecutionsResult(ctx context.Context, req api.ExecutionsResultRequestObject) (api.ExecutionsResultResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	ex, err := s.loadExecution(ctx, caller, req.Eid, authz.ActionRead)
	if err != nil {
		return nil, err
	}
	unitRes, err := s.store.GetResource(ctx, ex.CuRID)
	if err != nil {
		return nil, notFound("the execution's unit")
	}
	unit, err := s.unitFor(ctx, unitRes)
	if err != nil {
		return nil, err
	}
	var offset int64
	if req.Params.Offset != nil {
		offset = *req.Params.Offset
	}
	limit := int32(100)
	if req.Params.Limit != nil && *req.Params.Limit > 0 {
		limit = *req.Params.Limit
	}
	if limit > 1000 {
		limit = 1000
	}
	page, err := unit.Result(ctx, ex.EID.String(), req.Opid, req.Port, s.recordedTable(ctx, ex.EID, req.Opid, req.Port), offset, limit)
	if err != nil {
		return nil, err
	}
	out := api.RowPage{Offset: page.Offset, Total: page.Total, Rows: page.Rows, Schema: []api.Attribute{}}
	for _, a := range page.Schema {
		out.Schema = append(out.Schema, api.Attribute{AttributeName: a.AttributeName, AttributeType: a.AttributeType})
	}
	if out.Rows == nil {
		out.Rows = [][]any{}
	}
	return api.ExecutionsResult200JSONResponse(out), nil
}

// recordedTable is where the lineage events said a port result was written, or "" when none was
// recorded. Passing it lets a unit serve results of runs it no longer holds in memory.
func (s *Server) recordedTable(ctx context.Context, eid uuid.UUID, opid, port string) string {
	results, err := s.store.ListPortResults(ctx, eid)
	if err != nil {
		return ""
	}
	for _, r := range results {
		if r.Opid == opid && r.Port == port && r.TableID != nil {
			return *r.TableID
		}
	}
	return ""
}
