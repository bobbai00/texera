package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/store"
)

// Ingest consumes an OpenLineage run event from a unit (or any producer with a service
// token). The engine's contract: run.runId is the execution id; a run-level event has
// job.name == eid and run.facets.texera_execution = {status, error?}; an operator-level
// event has job.name == "<eid>/<operatorID>", run.facets.texera_operator = {opid, state,
// tuples?, error?}, outputs[] named "<eid>/<operatorID>/<portID>" with facets.texera_port =
// {table?, snapshot?, tupleCount?, bytes?, hash?}, and inputs[] named
// "<fromEid>/<fromOperatorID>/<fromPortID>".
func (s *Service) Ingest(ctx context.Context, caller *auth.Caller, ev api.LineageEvent) error {
	eid, err := uuid.Parse(ev.Run.RunId)
	if err != nil {
		return Invalid("run.runId must be the execution id", nil)
	}
	exec, err := s.Store.GetResource(ctx, eid)
	if err != nil {
		return NotFound("execution " + eid.String())
	}
	// Only the unit that runs the execution reports on it: the sender's subject must be that
	// unit's identity. Nobody else, the platform's own client included.
	if caller.Service || !s.reportsFor(ctx, caller, exec) {
		return Forbidden()
	}
	raw := mustJSON(ev)
	if _, err := s.Store.AddLineageEvent(ctx, &eid, raw); err != nil {
		return err
	}
	if err := s.LineageSink.Emit(ctx, raw); err != nil {
		s.Log.Warn("lineage sink", "err", err)
	}
	facets := map[string]any{}
	if ev.Run.Facets != nil {
		facets = *ev.Run.Facets
	}
	if !strings.Contains(strings.TrimPrefix(ev.Job.Name, eid.String()), "/") {
		return s.applyRunEvent(ctx, exec, ev, facets)
	}
	return s.applyOperatorEvent(ctx, exec, ev, facets)
}

// reportsFor tells whether the caller is the identity of the unit an execution runs on.
func (s *Service) reportsFor(ctx context.Context, caller *auth.Caller, exec *store.Resource) bool {
	var spec api.ExecutionSpec
	if err := json.Unmarshal(exec.Spec, &spec); err != nil {
		return false
	}
	unit, err := s.named(ctx, string(spec.ComputingUnit), unitKind)
	if err != nil {
		return false
	}
	identity := unitIdentity(unit)
	return identity != nil && caller.Claims.Subject != "" && caller.Claims.Subject == identity.Subject
}

func (s *Service) applyRunEvent(ctx context.Context, exec *store.Resource, ev api.LineageEvent, facets map[string]any) error {
	phase := ""
	var errBody map[string]any
	if te, ok := facets["texera_execution"].(map[string]any); ok {
		if st, ok := te["status"].(string); ok {
			phase = st
		}
		if e, ok := te["error"]; ok && e != nil {
			errBody = map[string]any{"message": e}
			if m, ok := e.(map[string]any); ok {
				errBody = m
			}
		}
	}
	if phase == "" {
		switch ev.EventType {
		case api.LineageEventEventTypeSTART, api.LineageEventEventTypeRUNNING:
			phase = "running"
		case api.LineageEventEventTypeCOMPLETE:
			phase = "completed"
		case api.LineageEventEventTypeFAIL:
			phase = "failed"
		case api.LineageEventEventTypeABORT:
			phase = "cancelled"
		}
	}
	switch phase {
	case "running", "paused", "completed", "failed", "cancelled":
		s.setPhase(ctx, exec.RID, api.ExecutionPhase(phase), errBody)
	}
	return nil
}

func (s *Service) applyOperatorEvent(ctx context.Context, exec *store.Resource, ev api.LineageEvent, facets map[string]any) error {
	// Progress reported while the execution was going but arriving after its end changes nothing:
	// the terminal report is the last word on every operator.
	if ev.EventType == api.LineageEventEventTypeRUNNING {
		var st api.ExecutionStatus
		_ = json.Unmarshal(exec.Status, &st)
		if isTerminal(st.Phase) {
			return nil
		}
	}
	parts := strings.SplitN(ev.Job.Name, "/", 2)
	operatorID := parts[len(parts)-1]
	var opState *api.OperatorRunStatus
	if to, ok := facets["texera_operator"].(map[string]any); ok {
		if id, ok := to["opid"].(string); ok && id != "" {
			operatorID = id
		}
		state, _ := to["state"].(string)
		opState = &api.OperatorRunStatus{State: state, RowsIn: intPtr(to["rowsIn"]), RowsOut: intPtr(to["rowsOut"])}
		if e, ok := to["error"]; ok && e != nil {
			opState.Error = &e
		}
	}
	var ports []api.PortSummary
	var produced []store.Edge
	var reused []store.Edge
	execURI := URI(exec).String()
	execRID := exec.RID
	if ev.Outputs != nil {
		for _, out := range *ev.Outputs {
			portID := out.Name[strings.LastIndex(out.Name, "/")+1:]
			p := api.PortSummary{OperatorID: operatorID, PortID: portID}
			if out.Facets != nil {
				if tp, ok := (*out.Facets)["texera_port"].(map[string]any); ok {
					p.Table = strPtr(tp["table"])
					p.Snapshot = strPtr(tp["snapshot"])
					p.Rows = intPtr(tp["tupleCount"])
					p.Bytes = intPtr(tp["bytes"])
					p.Hash = strPtr(tp["hash"])
				}
			}
			// A result is a port the plan keeps a table for: the engine stores others for its own
			// schedule, and those are no result. The unit writes where the plan says: a table the
			// plan does not name is refused.
			planned := plannedTable(exec, operatorID, portID)
			if planned == "" {
				continue
			}
			if p.Table != nil && *p.Table != executionNamespace(exec.RID)+"."+planned {
				return Invalid(fmt.Sprintf("port %s/%s reported table %s, the plan names %s.%s", operatorID, portID, *p.Table, executionNamespace(exec.RID), planned), nil)
			}
			ports = append(ports, p)
			portURI := execURI + "/operators/" + operatorID + "/ports/" + portID
			if p.Table != nil {
				to := "iceberg://" + *p.Table
				if p.Snapshot != nil {
					to += "@" + *p.Snapshot
				}
				attrs := map[string]any{"table": *p.Table}
				if p.Snapshot != nil {
					attrs["snapshot"] = *p.Snapshot
				}
				if p.Rows != nil {
					attrs["rows"] = *p.Rows
				}
				if p.Bytes != nil {
					attrs["bytes"] = *p.Bytes
				}
				if p.Hash != nil {
					attrs["hash"] = *p.Hash
				}
				produced = append(produced, store.Edge{From: portURI, Relation: "produced", To: to, FromRID: exec.RID, ExecutionRID: &execRID, Attrs: mustJSON(attrs)})
			}
			if ev.Inputs != nil {
				for _, in := range *ev.Inputs {
					seg := strings.Split(in.Name, "/")
					if len(seg) != 3 || seg[0] == exec.RID.String() {
						continue
					}
					fromEID, err := uuid.Parse(seg[0])
					if err != nil {
						continue
					}
					other, err := s.Store.GetResource(ctx, fromEID)
					if err != nil {
						continue
					}
					otherPort := URI(other).String() + "/operators/" + seg[1] + "/ports/" + seg[2]
					toRID := fromEID
					reused = append(reused, store.Edge{From: portURI, Relation: "reused", To: otherPort, FromRID: exec.RID, ToRID: &toRID, ExecutionRID: &execRID})
				}
			}
		}
	}
	if opState == nil && len(ports) == 0 {
		return nil
	}
	if err := s.updateExecutionStatus(ctx, exec.RID, func(st *api.ExecutionStatus) {
		if opState != nil {
			if st.Operators == nil {
				st.Operators = &map[string]api.OperatorRunStatus{}
			}
			(*st.Operators)[operatorID] = *opState
		}
		// What the unit reports of a port goes onto what the catalog knew of it from the plan.
		for _, p := range ports {
			merged := []api.PortSummary{}
			found := false
			if st.Ports != nil {
				for _, e := range *st.Ports {
					if e.OperatorID == p.OperatorID && e.PortID == p.PortID {
						e, found = reportedOn(e, p), true
					}
					merged = append(merged, e)
				}
			}
			if !found {
				merged = append(merged, p)
			}
			st.Ports = &merged
		}
	}); err != nil {
		return err
	}
	if len(produced)+len(reused) > 0 {
		if err := s.Store.AddEdges(ctx, append(produced, reused...)); err != nil {
			return err
		}
	}
	return nil
}

// reportedOn is what the catalog knows of a port once the unit reported on it: what the unit
// said, over what was known before.
func reportedOn(known, reported api.PortSummary) api.PortSummary {
	if reported.Table != nil {
		known.Table = reported.Table
	}
	if reported.Snapshot != nil {
		known.Snapshot = reported.Snapshot
	}
	if reported.Rows != nil {
		known.Rows = reported.Rows
	}
	if reported.Bytes != nil {
		known.Bytes = reported.Bytes
	}
	if reported.Hash != nil {
		known.Hash = reported.Hash
	}
	if reported.Schema != nil {
		known.Schema = reported.Schema
	}
	return known
}

func strPtr(v any) *string {
	switch t := v.(type) {
	case string:
		if t == "" {
			return nil
		}
		return &t
	case float64:
		b, _ := json.Marshal(t)
		s := string(b)
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
