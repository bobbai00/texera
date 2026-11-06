package server_test

import (
	"net/http"
	"sort"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
)

// A run up to an operator runs only what leads to it, and keeps its result. The workflow does
// not change: what the run went up to is the execution's, like its unit.

// branches is a workflow of two branches over one file: scan (marked) → first → second, and
// scan → other.
func branches(t *testing.T, h *harness) (workflow string, head int) {
	t.Helper()
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	op := func(id, kind string, marked bool) map[string]any {
		o := map[string]any{"operatorID": id, "operatorType": kind, "operatorProperties": map[string]any{}}
		if kind == "CSVFileScan" {
			o["operatorProperties"] = map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/iris.csv"}
		}
		if marked {
			o["viewResult"] = true
		}
		return o
	}
	link := func(id, from, to string) map[string]any {
		return map[string]any{"linkID": id, "source": map[string]any{"operatorID": from, "portID": "output-0"}, "target": map[string]any{"operatorID": to, "portID": "input-0"}}
	}
	wf := h.create("alice", "workflows", "branches", map[string]any{
		"operators": []any{op("scan", "CSVFileScan", true), op("first", "Aggregate", false), op("second", "Aggregate", false), op("other", "Aggregate", false)},
		"links":     []any{link("l1", "scan", "first"), link("l2", "first", "second"), link("l3", "scan", "other")},
	})
	return p + "/workflows/" + rid(wf), int(wf.Metadata.Head)
}

// started waits for the unit to be asked to start an execution, and returns the request.
func started(t *testing.T, h *harness, eid string) map[string]any {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		for _, s := range h.unit.starts() {
			if s["eid"] == eid {
				return s
			}
		}
	}
	t.Fatalf("the unit was not asked to start %s", eid)
	return nil
}

func TestARunUpToAnOperatorRunsOnlyWhatLeadsToIt(t *testing.T) {
	h := newHarness(t)
	workflow, head := branches(t, h)
	var exec envelope
	h.mustJSON("alice", "POST", workflow+"/run", map[string]any{"upTo": "first"}, &exec)
	var spec api.ExecutionSpec
	mustDecode(t, exec.Spec, &spec)
	if spec.UpTo == nil || *spec.UpTo != "first" {
		t.Fatalf("the execution says what it ran up to: %+v", spec.UpTo)
	}

	// The unit runs scan and first, nothing after first and nothing beside it.
	req := started(t, h, rid(exec))
	var ran []string
	for _, o := range req["logicalPlan"].(map[string]any)["operators"].([]any) {
		ran = append(ran, o.(map[string]any)["operatorID"].(string))
	}
	sort.Strings(ran)
	if len(ran) != 2 || ran[0] != "first" || ran[1] != "scan" {
		t.Fatalf("operators run: %v", ran)
	}
	// The results kept: first's, which it ran up to, and scan's, which is marked.
	var kept []string
	for _, table := range req["resultStore"].(map[string]any)["tables"].([]any) {
		kept = append(kept, table.(map[string]any)["opid"].(string))
	}
	sort.Strings(kept)
	if len(kept) != 2 || kept[0] != "first" || kept[1] != "scan" {
		t.Fatalf("results kept: %v", kept)
	}
	var status api.ExecutionStatus
	mustDecode(t, exec.Status, &status)
	if status.Ports == nil || len(*status.Ports) != 2 {
		t.Fatalf("the ports of the results kept are known from the start: %+v", status.Ports)
	}

	// The workflow is as it was.
	var wf envelope
	h.mustJSON("alice", "GET", workflow, nil, &wf)
	if int(wf.Metadata.Head) != head {
		t.Fatalf("a run up to an operator made a version: head %d, was %d", wf.Metadata.Head, head)
	}
}

func TestARunUpToAnOperatorThatIsNotThereOrIsOffIsRefused(t *testing.T) {
	h := newHarness(t)
	workflow, _ := branches(t, h)
	wantError(t, h, "POST", workflow+"/run", map[string]any{"upTo": "nosuch"}, http.StatusBadRequest, "invalid", "no operator nosuch in this version")

	var wf envelope
	h.mustJSON("alice", "GET", workflow, nil, &wf)
	var spec map[string]any
	mustDecode(t, wf.Spec, &spec)
	for _, o := range spec["operators"].([]any) {
		if o.(map[string]any)["operatorID"] == "second" {
			o.(map[string]any)["isDisabled"] = true
		}
	}
	h.mustJSON("alice", "PUT", workflow, map[string]any{"spec": spec}, nil)
	wantError(t, h, "POST", workflow+"/run", map[string]any{"upTo": "second"}, http.StatusBadRequest, "invalid", "second is turned off")
}
