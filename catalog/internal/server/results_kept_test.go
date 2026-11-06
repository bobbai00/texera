package server_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
)

// What a run keeps is the result of an operator marked to keep it, of an operator nothing reads
// from, and of the operator the run was asked to go up to: the ports the plan names a table
// for. Nothing else is a result. A port the unit reports that the plan names no table for (the
// engine stores some on its own, for its schedule) is not listed, and its rows are nobody's.

// report posts what the unit reports of one operator: its state and rows, and its output ports.
func report(t *testing.T, h *harness, exec envelope, operator string, facet map[string]any, ports map[string]map[string]any) {
	t.Helper()
	outputs := []any{}
	for port, facets := range ports {
		outputs = append(outputs, map[string]any{"namespace": "texera", "name": rid(exec) + "/" + operator + "/" + port, "facets": map[string]any{"texera_port": facets}})
	}
	event := map[string]any{"eventType": "RUNNING", "eventTime": time.Now().UTC().Format(time.RFC3339), "producer": "test", "schemaURL": "x",
		"run":     map[string]any{"runId": rid(exec), "facets": map[string]any{"texera_operator": facet}},
		"job":     map[string]any{"namespace": "texera", "name": rid(exec) + "/" + operator},
		"outputs": outputs}
	if status, body := h.do("unit", "POST", "/lineage/v1/events", event); status != http.StatusNoContent {
		t.Fatalf("report: %d %s", status, body)
	}
}

func TestOnlyThePortsThePlanNamesAreResults(t *testing.T) {
	h := newHarness(t)
	execPath, exec := anExecution(t, h)
	namespace := "e_" + strings.ReplaceAll(rid(exec), "-", "")
	// scan feeds avg and is not marked: the unit stored its rows for its own schedule, with no
	// table of the plan's. avg is marked: its table is the plan's.
	report(t, h, exec, "scan", map[string]any{"opid": "scan", "state": "Completed", "rowsIn": 0, "rowsOut": 2},
		map[string]map[string]any{"output-0": {"tupleCount": 2}})
	report(t, h, exec, "avg", map[string]any{"opid": "avg", "state": "Running", "rowsIn": 2, "rowsOut": 1},
		map[string]map[string]any{"output-0": {"table": namespace + ".avg_output_0", "tupleCount": 1}})

	var got envelope
	h.mustJSON("alice", "GET", execPath, nil, &got)
	var status api.ExecutionStatus
	mustDecode(t, got.Status, &status)
	if status.Ports == nil || len(*status.Ports) != 1 || (*status.Ports)[0].OperatorID != "avg" || (*status.Ports)[0].Rows == nil || *(*status.Ports)[0].Rows != 1 {
		t.Fatalf("only avg's port is a result: %+v", status.Ports)
	}
	// What each operator did is said of every operator, rows in and rows out.
	scan, avg := (*status.Operators)["scan"], (*status.Operators)["avg"]
	if scan.State != "Completed" || scan.RowsOut == nil || *scan.RowsOut != 2 || avg.RowsIn == nil || *avg.RowsIn != 2 || avg.RowsOut == nil || *avg.RowsOut != 1 {
		t.Fatalf("operators: scan %+v, avg %+v", scan, avg)
	}
	// The rows of a port that is no result are refused by the catalog: the unit is not asked.
	wantError(t, h, "GET", execPath+"/operators/scan/ports/output-0/rows", nil, http.StatusNotFound, "not_found", "no result is kept for scan/output-0")
	if place := h.unit.lastResultPlace(); place != "" {
		t.Fatalf("the unit was asked for rows: %s", place)
	}
}
