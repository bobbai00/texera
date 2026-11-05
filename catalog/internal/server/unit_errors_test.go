package server_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
)

// aRun starts a run over a small file and returns the path of its execution once it is running.
func aRun(t *testing.T, h *harness) (execPath string, exec envelope) {
	t.Helper()
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	spec := map[string]any{
		"operators": []any{
			map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/iris.csv"}},
			map[string]any{"operatorID": "avg", "operatorType": "Aggregate", "viewResult": true, "operatorProperties": map[string]any{}},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "avg", "portID": "input-0"}}},
	}
	wf := h.create("alice", "workflows", "errors", spec)
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "errors run"}, &exec)
	execPath = p + "/workflows/" + rid(wf) + "/executions/" + rid(exec)
	deadline := time.Now().Add(10 * time.Second)
	for field(exec, "phase") != "running" && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		h.mustJSON("alice", "GET", execPath, nil, &exec)
	}
	if field(exec, "phase") != "running" {
		t.Fatalf("phase: %v", exec.Status)
	}
	return execPath, exec
}

// finish reports the run's end, as the unit does.
func finish(t *testing.T, h *harness, exec envelope, status string) {
	t.Helper()
	event := map[string]any{"eventType": "COMPLETE", "eventTime": time.Now().UTC().Format(time.RFC3339), "producer": "test", "schemaURL": "https://openlineage.io/spec/2-0-2/OpenLineage.json",
		"job": map[string]any{"namespace": "texera", "name": "run"},
		"run": map[string]any{"runId": rid(exec), "facets": map[string]any{"texera_execution": map[string]any{"status": status}}}}
	if got, body := h.do("unit", "POST", "/lineage/v1/events", event); got != http.StatusNoContent {
		t.Fatalf("report: %d %s", got, body)
	}
}

// wantError checks a refused call: its status, its code and the engine's words.
func wantError(t *testing.T, h *harness, method, path string, body any, status int, code, words string) {
	t.Helper()
	got, data := h.do("alice", method, path, body)
	if got != status {
		t.Fatalf("%s %s: got %d %s, want %d", method, path, got, data, status)
	}
	var e api.Error
	if err := json.Unmarshal(data, &e); err != nil {
		t.Fatalf("not the contract's error: %s", data)
	}
	if e.Code != code || !strings.Contains(e.Message, words) || strings.Contains(e.Message, "unmarshal") {
		t.Fatalf("got %+v, want code %s saying %q", e, code, words)
	}
}

func TestRowsOfAFinishedRunKeepTheEnginesRefusal(t *testing.T) {
	h := newHarness(t)
	execPath, exec := aRun(t, h)
	finish(t, h, exec, "completed")
	h.unit.refusing("/results/avg/output-0", http.StatusNotFound, "no table e_1.avg_output_0")
	wantError(t, h, "GET", execPath+"/operators/avg/ports/output-0/rows?limit=5", nil, http.StatusNotFound, "not_found", "no table e_1.avg_output_0")
}

func TestRowsOfALiveRunAreEmptyUntilItsTableIsWritten(t *testing.T) {
	h := newHarness(t)
	execPath, _ := aRun(t, h)
	h.unit.refusing("/results/avg/output-0", http.StatusNotFound, "no table e_1.avg_output_0")
	var page api.RowPage
	h.mustJSON("alice", "GET", execPath+"/operators/avg/ports/output-0/rows?offset=0&limit=5", nil, &page)
	if len(page.Rows) != 0 || page.Offset != 0 {
		t.Fatalf("an empty page: %+v", page)
	}
	// The JSON says [] and not null, which the page and the agent both read.
	_, data := h.do("alice", "GET", execPath+"/operators/avg/ports/output-0/rows?offset=0&limit=5", nil)
	if !strings.Contains(string(data), `"rows":[]`) || !strings.Contains(string(data), `"schema":[]`) {
		t.Fatalf("empty arrays: %s", data)
	}
}

func TestAPortThePlanDoesNotNameIsNotFoundEvenWhileTheRunGoes(t *testing.T) {
	h := newHarness(t)
	execPath, _ := aRun(t, h)
	h.unit.refusing("/results/nosuch/output-0", http.StatusNotFound, "no result for nosuch/output-0")
	wantError(t, h, "GET", execPath+"/operators/nosuch/ports/output-0/rows", nil, http.StatusNotFound, "not_found", "no result for nosuch/output-0")
}

func TestAnEngineFailureWhileARunGoesIsNotHiddenAsEmpty(t *testing.T) {
	h := newHarness(t)
	execPath, _ := aRun(t, h)
	h.unit.refusing("/results/avg/output-0", http.StatusInternalServerError, "the table is corrupt")
	wantError(t, h, "GET", execPath+"/operators/avg/ports/output-0/rows", nil, http.StatusBadGateway, "unit_error", "the table is corrupt")
}

func TestTheEnginesRefusalOfAControlKeepsItsWords(t *testing.T) {
	h := newHarness(t)
	execPath, _ := aRun(t, h)
	h.unit.refusing("/pause", http.StatusConflict, "the run is already pausing")
	wantError(t, h, "POST", execPath+"/pause", map[string]any{}, http.StatusConflict, "conflict", "the run is already pausing")
}

func TestACompileTheEngineRefusesKeepsItsWords(t *testing.T) {
	h := newHarness(t)
	execPath, exec := aRun(t, h)
	_ = execPath
	wf := *exec.Metadata.Parent
	h.unit.refusing("/compile", http.StatusBadRequest, "the plan is not valid: no operator scan2")
	wantError(t, h, "POST", p+"/workflows/"+wf+"/validate", map[string]any{}, http.StatusBadRequest, "invalid", "no operator scan2")
}
