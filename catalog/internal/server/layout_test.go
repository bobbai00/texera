package server_test

import (
	"testing"
)

// Where a workflow's operators sit is kept in its versions, beside what runs, and is the app's.
// A spec written without places (as the agent writes one) keeps the places of the operators it
// kept; a place of an operator the spec does not have is not kept.

func layoutOf(t *testing.T, e envelope) map[string]any {
	t.Helper()
	var spec map[string]any
	mustDecode(t, e.Spec, &spec)
	layout, _ := spec["layout"].(map[string]any)
	return layout
}

func TestAWorkflowsPlacesGoFromVersionToVersion(t *testing.T) {
	h := newHarness(t)
	op := func(id, kind string) map[string]any {
		return map[string]any{"operatorID": id, "operatorType": kind, "operatorProperties": map[string]any{}}
	}
	link := func(id, from, to string) map[string]any {
		return map[string]any{"linkID": id, "source": map[string]any{"operatorID": from, "portID": "output-0"}, "target": map[string]any{"operatorID": to, "portID": "input-0"}}
	}
	at := func(x, y float64) map[string]any { return map[string]any{"x": x, "y": y} }
	wf := h.create("alice", "workflows", "laid out", map[string]any{
		"operators": []any{op("scan", "CSVFileScan"), op("avg", "Aggregate")},
		"links":     []any{link("l1", "scan", "avg")},
		"layout":    map[string]any{"scan": at(40, 40), "avg": at(360, 40), "gone": at(1, 1)},
	})
	if got := layoutOf(t, wf); len(got) != 2 || got["gone"] != nil || got["avg"] == nil {
		t.Fatalf("the places kept are those of the spec's operators: %v", got)
	}
	path := p + "/workflows/" + rid(wf)

	// A whole spec without places: the operators it kept keep theirs; the new one has none yet.
	var v2 envelope
	h.mustJSON("alice", "PUT", path, map[string]any{"spec": map[string]any{
		"operators": []any{op("scan", "CSVFileScan"), op("avg", "Aggregate"), op("limit", "Limit")},
		"links":     []any{link("l1", "scan", "avg"), link("l2", "avg", "limit")},
	}}, &v2)
	if got := layoutOf(t, v2); len(got) != 2 || got["avg"].(map[string]any)["x"] != float64(360) || got["limit"] != nil {
		t.Fatalf("a spec without places keeps those it had: %v", got)
	}

	// A patch that removes an operator takes its place with it.
	h.mustJSON("alice", "POST", path+"/edit", map[string]any{"patch": []any{
		map[string]any{"op": "remove", "path": "/links/1"},
		map[string]any{"op": "remove", "path": "/links/0"},
		map[string]any{"op": "remove", "path": "/operators/1"},
	}}, nil)
	var v3 envelope
	h.mustJSON("alice", "GET", path, nil, &v3)
	if got := layoutOf(t, v3); len(got) != 1 || got["scan"] == nil {
		t.Fatalf("the place of a removed operator goes with it: %v", got)
	}

	// Places that say where operators sit are written as they are.
	var v4 envelope
	h.mustJSON("alice", "PUT", path, map[string]any{"spec": map[string]any{
		"operators": []any{op("scan", "CSVFileScan")}, "links": []any{}, "layout": map[string]any{"scan": at(500, 600)},
	}}, &v4)
	if got := layoutOf(t, v4); got["scan"].(map[string]any)["y"] != float64(600) {
		t.Fatalf("places written: %v", got)
	}
}
