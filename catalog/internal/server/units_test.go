package server_test

import (
	"net/http"
	"testing"

	"github.com/apache/texera/catalog/internal/server"
)

// A private unit: whoever is granted `user` on it may run there without reading its spec; a
// viewer of the workflow alone may not.
func TestUnitUseWithoutRead(t *testing.T) {
	h := newHarness(t)
	unit := h.create("alice", "computing-units", "alice's engine", map[string]any{"provider": "static", "endpoint": h.unit.URL})
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	spec := map[string]any{
		"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "viewResult": true, "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/iris.csv"}}},
		"links":     []any{},
	}
	wf := h.create("alice", "workflows", "on alice's engine", spec)
	bob := principalOf(h, "bob")
	for _, r := range []envelope{wf, ds} {
		h.mustJSON("alice", "PUT", p+"/resources/"+rid(r)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	}
	run := map[string]any{"name": "bob's try", "computingUnit": string(unit.Metadata.Uri)}
	if status, body := h.do("bob", "POST", p+"/workflows/"+rid(wf)+"/run", run); status != http.StatusForbidden {
		t.Fatalf("without use of the unit: %d %s", status, body)
	}
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(unit)+"/grants/"+bob, map[string]any{"relation": "user"}, nil)
	if status, body := h.do("bob", "GET", p+"/computing-units/"+rid(unit), nil); status != http.StatusForbidden {
		t.Fatalf("use does not read the unit's spec: %d %s", status, body)
	}
	if status, body := h.do("bob", "POST", p+"/workflows/"+rid(wf)+"/validate", map[string]any{"computingUnit": string(unit.Metadata.Uri)}); status != http.StatusOK {
		t.Fatalf("a user compiles on the unit: %d %s", status, body)
	}
	var exec envelope
	h.mustJSON("bob", "POST", p+"/workflows/"+rid(wf)+"/run", run, &exec)
	if exec.Kind != "execution" {
		t.Fatalf("a user runs on the unit: %+v", exec)
	}
	_ = server.Prefix
}

// Updating a unit: a changed spec is taken and reconciled, the provider cannot change, and a
// unit with a run on it waits until the run is over.
func TestUnitUpdate(t *testing.T) {
	h := newHarness(t)
	cluster := h.create("alice", "computing-units", "alice's cluster unit", map[string]any{"provider": "kubernetes", "computingNodes": []any{map[string]any{"name": "master", "role": "master", "memory": "2Gi"}}})
	bigger := map[string]any{"provider": "kubernetes", "computingNodes": []any{map[string]any{"name": "master", "role": "master", "memory": "3Gi"}}}
	var updated envelope
	h.mustJSON("alice", "PUT", p+"/computing-units/"+rid(cluster), map[string]any{"spec": bigger}, &updated)
	var spec map[string]any
	mustDecode(t, updated.Spec, &spec)
	if nodes, _ := spec["computingNodes"].([]any); len(nodes) != 1 || nodes[0].(map[string]any)["memory"] != "3Gi" {
		t.Fatalf("the spec changed: %v", spec)
	}
	var status map[string]any
	mustDecode(t, updated.Status, &status)
	if status["identity"] == nil {
		t.Fatalf("the identity survives an update: %v", status)
	}
	if code, body := h.do("alice", "PUT", p+"/computing-units/"+rid(cluster), map[string]any{"spec": map[string]any{"provider": "static", "endpoint": h.unit.URL}}); code != http.StatusBadRequest {
		t.Fatalf("the provider cannot change: %d %s", code, body)
	}

	engine := h.create("alice", "computing-units", "alice's engine", map[string]any{"provider": "static", "endpoint": h.unit.URL})
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	wf := h.create("alice", "workflows", "on alice's engine", map[string]any{
		"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "viewResult": true, "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/iris.csv"}}},
		"links":     []any{},
	})
	var exec envelope
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "busy", "computingUnit": string(engine.Metadata.Uri)}, &exec)
	described := map[string]any{"provider": "static", "endpoint": h.unit.URL, "computingNodes": []any{map[string]any{"name": "master", "role": "master", "memory": "8Gi"}}}
	if code, body := h.do("alice", "PUT", p+"/computing-units/"+rid(engine), map[string]any{"spec": described}); code != http.StatusConflict {
		t.Fatalf("a unit with a run on it waits: %d %s", code, body)
	}
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/executions/"+rid(exec)+"/cancel", map[string]any{}, nil)
	h.mustJSON("alice", "PUT", p+"/computing-units/"+rid(engine), map[string]any{"spec": described}, &updated)
}
