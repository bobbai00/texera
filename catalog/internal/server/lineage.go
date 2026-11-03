package server

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/store"
)

// EventsIngest consumes OpenLineage run events from units.
//
// Contract (producer: the engine):
//   - run.runId is the execution id.
//   - Run-level events: job.name == eid, run.facets.texera_execution = {status, error?};
//     eventType START means running, COMPLETE completed, FAIL failed, ABORT cancelled.
//   - Operator-level events: job.name == "<eid>/<opid>", run.facets.texera_operator =
//     {opid, state, tuples?, error?}; outputs[] name "<eid>/<opid>/<port>" with
//     facets.texera_port = {table?, snapshot?, tupleCount?, bytes?, hash?}; inputs[] name
//     "<fromEid>/<fromOpid>/<fromPort>" record consumes edges.
func (s *Server) EventsIngest(ctx context.Context, req api.EventsIngestRequestObject) (api.EventsIngestResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	if !caller.IsService {
		return nil, forbidden()
	}
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	ev := *req.Body
	eid, err := uuid.Parse(ev.Run.RunId)
	if err != nil {
		return nil, badRequest("run.runId must be the execution id")
	}
	_ = s.store.StoreLineageEvent(ctx, &eid, mustJSON(ev))
	if err := s.applyLineageEvent(ctx, eid, ev); err != nil {
		return nil, err
	}
	return api.EventsIngest204Response{}, nil
}

func (s *Server) applyLineageEvent(ctx context.Context, eid uuid.UUID, ev api.LineageEvent) error {
	facets := map[string]any{}
	if ev.Run.Facets != nil {
		facets = *ev.Run.Facets
	}
	jobName := ev.Job.Name
	if !strings.Contains(strings.TrimPrefix(jobName, eid.String()), "/") {
		// Run-level event.
		status := ""
		var errBody json.RawMessage
		if te, ok := facets["texera_execution"].(map[string]any); ok {
			if st, ok := te["status"].(string); ok {
				status = st
			}
			if e, ok := te["error"]; ok && e != nil {
				errBody = mustJSON(e)
			}
		}
		if status == "" {
			switch ev.EventType {
			case api.START, api.RUNNING:
				status = "running"
			case api.COMPLETE:
				status = "completed"
			case api.FAIL:
				status = "failed"
			case api.ABORT:
				status = "cancelled"
			}
		}
		if _, err := s.store.SetExecutionStatus(ctx, eid, status, errBody); err != nil {
			if store.IsNotFound(err) {
				return notFound("execution")
			}
			return err
		}
		return nil
	}
	// Operator-level event.
	parts := strings.SplitN(jobName, "/", 2)
	opid := parts[len(parts)-1]
	if to, ok := facets["texera_operator"].(map[string]any); ok {
		if id, ok := to["opid"].(string); ok && id != "" {
			opid = id
		}
		state := map[string]any{"state": to["state"]}
		if t, ok := to["tuples"]; ok {
			state["tuples"] = t
		}
		if e, ok := to["error"]; ok && e != nil {
			state["error"] = e
		}
		if err := s.store.MergeOperatorState(ctx, eid, opid, mustJSON(state)); err != nil {
			return err
		}
	}
	if ev.Outputs != nil {
		for _, out := range *ev.Outputs {
			port := lastSegment(out.Name)
			pr := store.PortResult{EID: eid, Opid: opid, Port: port}
			if out.Facets != nil {
				if tp, ok := (*out.Facets)["texera_port"].(map[string]any); ok {
					pr.TableID = strPtr(tp["table"])
					pr.SnapshotID = strPtr(tp["snapshot"])
					pr.TupleCount = intPtr(tp["tupleCount"])
					pr.Bytes = intPtr(tp["bytes"])
					pr.Hash = strPtr(tp["hash"])
				}
			}
			if err := s.store.UpsertPortResult(ctx, pr); err != nil {
				return err
			}
			if ev.Inputs != nil {
				for _, in := range *ev.Inputs {
					seg := strings.Split(in.Name, "/")
					if len(seg) != 3 {
						continue
					}
					fromEID, err := uuid.Parse(seg[0])
					if err != nil {
						continue
					}
					_ = s.store.AddPortEdge(ctx, store.PortEdge{EID: eid, Opid: opid, Port: port, FromEID: fromEID, FromOpid: seg[1], FromPort: seg[2]})
				}
			}
		}
	}
	return nil
}

func lastSegment(name string) string {
	i := strings.LastIndex(name, "/")
	if i < 0 {
		return name
	}
	return name[i+1:]
}

func strPtr(v any) *string {
	switch t := v.(type) {
	case string:
		if t == "" {
			return nil
		}
		return &t
	case float64:
		s := json.Number(formatFloat(t)).String()
		return &s
	}
	return nil
}

func intPtr(v any) *int64 {
	switch t := v.(type) {
	case float64:
		n := int64(t)
		return &n
	case int64:
		return &t
	case int:
		n := int64(t)
		return &n
	}
	return nil
}

func formatFloat(f float64) string {
	b, _ := json.Marshal(f)
	return string(b)
}
