package server_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
)

// The demo's shape over a dataset file: a scan, an aggregate the run keeps though nothing shows
// it, and a filter that shows the rows.
func overnightSpec(file string) map[string]any {
	op := func(id, typ string, props map[string]any) map[string]any {
		return map[string]any{"operatorID": id, "operatorType": typ, "operatorProperties": props}
	}
	link := func(from, to string) map[string]any {
		return map[string]any{"linkID": from + "-" + to, "source": map[string]any{"operatorID": from, "portID": "output-0"}, "target": map[string]any{"operatorID": to, "portID": "input-0"}}
	}
	return map[string]any{
		"operators": []any{
			op("readings", "scan", map[string]any{"file": file}),
			op("lows", "aggregate", map[string]any{"by": []any{"Species"}, "outputs": []any{"n = count(*)"}}),
			op("many", "filter", map[string]any{"where": "n > 1"}),
		},
		"links": []any{link("readings", "lows"), link("lows", "many")},
	}
}

// runOnUnit runs a workflow and returns the execution once the unit has it, with the request the unit got.
func runOnUnit(t *testing.T, h *harness, who, workflow string, body map[string]any) (envelope, map[string]any) {
	t.Helper()
	before := len(h.unit.starts())
	var exec envelope
	h.mustJSON(who, "POST", p+"/workflows/"+workflow+"/run", body, &exec)
	deadline := time.Now().Add(10 * time.Second)
	for len(h.unit.starts()) == before && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	starts := h.unit.starts()
	if len(starts) != before+1 {
		t.Fatalf("the unit got no start for %s", workflow)
	}
	path := p + "/workflows/" + workflow + "/executions/" + rid(exec)
	for field(exec, "phase") != "running" && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		h.mustJSON(who, "GET", path, nil, &exec)
	}
	return exec, starts[len(starts)-1]
}

func planned(t *testing.T, exec envelope) api.ExecutionSpec {
	t.Helper()
	var spec api.ExecutionSpec
	mustDecode(t, exec.Spec, &spec)
	return spec
}

func operatorsOf(start map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, op := range start["logicalPlan"].(map[string]any)["operators"].([]any) {
		m := op.(map[string]any)
		out[m["operatorID"].(string)] = m
	}
	return out
}

// A run reads what an earlier run of the same work stored instead of making it again: the same
// work on the same data in another workflow of the project, found by its fingerprint. What fed
// only the reused result does not run, the reuse is recorded and in lineage, a fresh run makes
// everything, and someone who cannot read the earlier run makes the rows again.
func TestARunReadsWhatAnEarlierRunOfTheSameWorkStored(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	file := string(ds.Metadata.Uri) + "@1/files/iris.csv"

	// The first run makes everything, keeps the aggregate though nothing shows it, and says what
	// work each kept port is.
	first := h.create("alice", "workflows", "first", overnightSpec(file))
	exec1, start1 := runOnUnit(t, h, "alice", rid(first), map[string]any{})
	outputs := map[string]api.PortTable{}
	for _, o := range planned(t, exec1).Plan.Outputs {
		outputs[o.OperatorID] = o
	}
	if len(outputs) != 2 || outputs["lows"].Fingerprint == nil || outputs["many"].Fingerprint == nil || len(operatorsOf(start1)) != 3 {
		t.Fatalf("the first run's plan: %+v", outputs)
	}
	ns1 := "e_" + strings.ReplaceAll(rid(exec1), "-", "")
	report(t, h, exec1, "lows", map[string]any{"opid": "lows", "state": "Completed", "rowsOut": 1}, map[string]map[string]any{"output-0": {"table": ns1 + ".lows_output_0", "tupleCount": 1}})
	report(t, h, exec1, "many", map[string]any{"opid": "many", "state": "Completed", "rowsOut": 0}, map[string]map[string]any{"output-0": {"table": ns1 + ".many_output_0", "tupleCount": 0}})
	finish(t, h, exec1, "completed")

	// Another workflow of the project does the same work and changes the last step: the
	// aggregate's rows are read from the first run, and the scan does not run.
	spec := overnightSpec(file)
	spec["operators"].([]any)[2].(map[string]any)["operatorProperties"] = map[string]any{"where": "n > 2"}
	second := h.create("alice", "workflows", "second", spec)
	exec2, start2 := runOnUnit(t, h, "alice", rid(second), map[string]any{})
	ops := operatorsOf(start2)
	lows := ops["lows"]
	if len(ops) != 2 || lows["operatorType"] != "stored" || lows["namespace"] != ns1 || lows["table"] != "lows_output_0" || ops["many"]["operatorType"] != "filter" {
		t.Fatalf("the second run's plan: %v", ops)
	}
	if columns, _ := json.Marshal(lows["columns"]); string(columns) != `[{"attributeName":"Species","attributeType":"string"},{"attributeName":"avg","attributeType":"double"}]` {
		t.Fatalf("the stored columns, as the unit read them: %s", columns)
	}
	if _, read := start2["inputs"]; read {
		t.Fatalf("the file was bound for a scan that does not run: %v", start2["inputs"])
	}
	firstPort := string(exec1.Metadata.Uri) + "/operators/lows/ports/output-0"
	spec2 := planned(t, exec2)
	if spec2.Reused == nil || len(*spec2.Reused) != 1 || string((*spec2.Reused)[0].From) != firstPort || spec2.Skipped == nil || strings.Join(*spec2.Skipped, " ") != "readings" {
		t.Fatalf("what the second run reused and skipped: %+v %+v", spec2.Reused, spec2.Skipped)
	}
	var up api.LineageGraph
	h.mustJSON("alice", "GET", p+"/resources/"+rid(exec2)+"/lineage?direction=upstream", nil, &up)
	if !hasEdge(up.Edges, "reused", "", firstPort) {
		t.Fatalf("lineage says the second run read the first's rows: %+v", up.Edges)
	}
	finish(t, h, exec2, "completed")

	// Fresh makes everything again.
	exec3, fresh := runOnUnit(t, h, "alice", rid(second), map[string]any{"fresh": true})
	if ops := operatorsOf(fresh); len(ops) != 3 || ops["lows"]["operatorType"] != "aggregate" {
		t.Fatalf("a fresh run: %v", ops)
	}
	finish(t, h, exec3, "completed")

	// Bob may run the second workflow, not read the first: he makes the rows again.
	bob := string(me(h, "bob").Principal.Pid)
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(second)+"/grants/"+bob, map[string]any{"relation": "editor"}, nil)
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(ds)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	if status, _ := h.do("bob", "GET", p+"/workflows/"+rid(first)+"/executions/"+rid(exec1), nil); status != http.StatusNotFound && status != http.StatusForbidden {
		t.Fatalf("bob reads the first run: %d", status)
	}
	_, bobs := runOnUnit(t, h, "bob", rid(second), map[string]any{})
	if ops := operatorsOf(bobs); len(ops) != 3 || ops["lows"]["operatorType"] != "aggregate" {
		t.Fatalf("bob's run read what he may not: %v", ops)
	}
}
