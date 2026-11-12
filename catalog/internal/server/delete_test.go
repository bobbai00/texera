package server_test

import (
	"net/http"
	"strings"
	"testing"
)

// Deleting has one rule, by whichever route: what lives only under a resource goes with it (a
// workflow's executions, each with its tables), what it merely holds stays in the way (a project's
// resources), and nothing goes while an execution is still going or something still names it.
func TestWhatLivesUnderAResourceGoesWithIt(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	spec := map[string]any{
		"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "viewResult": true, "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/iris.csv"}}},
		"links":     []any{},
	}
	wf := h.create("alice", "workflows", "run twice", spec)
	run := func(name string) envelope {
		var exec envelope
		h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": name}, &exec)
		return exec
	}
	execPath := func(e envelope) string { return p + "/workflows/" + rid(wf) + "/executions/" + rid(e) }
	remove := func(who string, r envelope) (int, string) {
		status, body := h.do(who, "DELETE", p+"/resources/"+rid(r), nil)
		return status, string(body)
	}
	there := func(path string) bool {
		status, _ := h.do("alice", "GET", path, nil)
		return status == http.StatusOK
	}

	first := run("first")
	h.mustJSON("alice", "POST", execPath(first)+"/cancel", map[string]any{}, nil)
	second := run("second")

	// An execution still going holds its workflow, and is itself refused by the route of any
	// resource as by its own; nothing has gone.
	if status, body := remove("alice", wf); status != http.StatusConflict || !strings.Contains(body, `"running"`) || !strings.Contains(body, "second") {
		t.Fatalf("a workflow with an execution still going: %d %s", status, body)
	}
	if status, body := remove("alice", second); status != http.StatusConflict || !strings.Contains(body, `"running"`) {
		t.Fatalf("an execution still going, as any resource: %d %s", status, body)
	}
	if !there(p+"/workflows/"+rid(wf)) || !there(execPath(first)) || !there(execPath(second)) {
		t.Fatal("a refused delete leaves the workflow and its executions")
	}
	if len(h.lake.Dropped) != 0 {
		t.Fatalf("a refused delete drops no tables: %v", h.lake.Dropped)
	}

	// The dataset the workflow reads stays while it does.
	if status, body := remove("alice", ds); status != http.StatusConflict || !strings.Contains(body, `"referenced"`) {
		t.Fatalf("a dataset a workflow reads: %d %s", status, body)
	}

	// Once nothing is going, the workflow goes with its executions and their tables; only who may
	// delete the workflow does.
	h.mustJSON("alice", "POST", execPath(second)+"/cancel", map[string]any{}, nil)
	if status, body := remove("bob", wf); status != http.StatusForbidden && status != http.StatusNotFound {
		t.Fatalf("bob may not delete alice's workflow: %d %s", status, body)
	}
	if status, body := remove("alice", wf); status != http.StatusNoContent {
		t.Fatalf("a workflow with finished executions: %d %s", status, body)
	}
	if there(p+"/workflows/"+rid(wf)) || there(p+"/resources/"+rid(first)) || there(p+"/resources/"+rid(second)) {
		t.Fatal("the workflow and its executions are gone")
	}
	for _, e := range []envelope{first, second} {
		namespace := "texera/e_" + strings.ReplaceAll(rid(e), "-", "")
		dropped := false
		for _, ns := range h.lake.Dropped {
			dropped = dropped || ns == namespace
		}
		if !dropped {
			t.Fatalf("an execution's tables go with it: %s not in %v", namespace, h.lake.Dropped)
		}
	}
	// Nothing reads the dataset any more.
	if status, body := remove("alice", ds); status != http.StatusNoContent {
		t.Fatalf("a dataset nothing reads: %d %s", status, body)
	}

	// What a project holds are resources of their own: they go or move first.
	lab := h.create("alice", "projects", "lab", map[string]any{})
	kept := createIn(h, "alice", "datasets", "kept", lab.Metadata.Rid, map[string]any{"format": "csv"})
	if status, body := remove("alice", lab); status != http.StatusConflict || !strings.Contains(body, `"has_children"`) {
		t.Fatalf("a project that holds a dataset: %d %s", status, body)
	}
	if status, body := remove("alice", kept); status != http.StatusNoContent {
		t.Fatalf("the dataset: %d %s", status, body)
	}
	if status, body := remove("alice", lab); status != http.StatusNoContent {
		t.Fatalf("an empty project: %d %s", status, body)
	}
}
