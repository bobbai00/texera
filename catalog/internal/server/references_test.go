package server_test

import (
	"net/http"
	"testing"
)

// What a spec names cannot be deleted while it is named. When a resource without versions
// stops naming something (a project its default unit, a chat its model), that thing is free
// again; a version of a versioned resource keeps naming what it named, for as long as it exists.
func TestWhatASpecStopsNamingIsFreeAgain(t *testing.T) {
	h := newHarness(t)
	remove := func(what string, r envelope, want int) {
		t.Helper()
		if status, data := h.do("alice", "DELETE", p+"/resources/"+rid(r), nil); status != want {
			t.Fatalf("delete %s: %d %s", what, status, data)
		}
	}
	unit := h.create("alice", "computing-units", "a unit", map[string]any{"provider": "static", "endpoint": h.unit.URL})
	model := h.create("alice", "model-endpoints", "a model", map[string]any{"provider": "anthropic", "model": "m"})
	server := h.create("alice", "mcp-servers", "a server", map[string]any{"url": "http://a.test/mcp"})

	// A project's defaults.
	lab := h.create("alice", "projects", "lab", map[string]any{"defaultComputingUnit": uriOf(unit), "mcpServers": []string{uriOf(server)}})
	remove("a unit a project names", unit, http.StatusConflict)
	remove("a server a project names", server, http.StatusConflict)
	h.mustJSON("alice", "PUT", p+"/projects/"+rid(lab), map[string]any{"spec": map[string]any{"mcpServers": []string{uriOf(server)}}}, nil)
	remove("a unit the project no longer names", unit, http.StatusNoContent)
	remove("a server the project still names", server, http.StatusConflict)
	h.mustJSON("alice", "PUT", p+"/projects/"+rid(lab), map[string]any{"spec": map[string]any{}}, nil)
	remove("a server no project names", server, http.StatusNoContent)

	// A chat's choices.
	conv := h.create("alice", "conversations", "a chat", map[string]any{"modelEndpoint": uriOf(model)})
	remove("a model a chat chose", model, http.StatusConflict)
	choose(h, "alice", conv, map[string]any{})
	remove("a model no chat chooses", model, http.StatusNoContent)

	// A workflow's versions: the first one names the dataset for as long as it exists.
	ds := h.create("alice", "datasets", "flowers", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/a.csv", "x\n1\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	reading := map[string]any{
		"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": uriOf(ds) + "@1/files/a.csv"}}},
		"links":     []any{},
	}
	wf := h.create("alice", "workflows", "reads flowers", reading)
	h.mustJSON("alice", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": map[string]any{"operators": []any{}, "links": []any{}}}, nil)
	remove("a dataset an earlier version reads", ds, http.StatusConflict)
	remove("the workflow", wf, http.StatusNoContent)
	remove("the dataset once nothing reads it", ds, http.StatusNoContent)
}
