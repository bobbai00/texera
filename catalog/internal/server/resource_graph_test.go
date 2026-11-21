package server_test

import (
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// A resource's page draws the same lineage graph as a chat, around the resource. On a
// workflow's page each execution hangs off the version it ran, with the results it kept and
// what that version read; the newest version stands too, dashed for what it only names; a
// version saved on the way and never executed is not drawn. An execution's page draws the
// execution alone, and a dataset's the executions that read it and the newest versions that
// name it.
func TestEachExecutionHangsOffTheVersionItRan(t *testing.T) {
	h := newHarness(t)
	dataset := func(name string) string {
		t.Helper()
		ds := h.create("alice", "datasets", name, map[string]any{"format": "csv"})
		h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/"+name+".csv", "patient_id,glucose\nP-1,64\n", nil)
		h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
		return rid(ds)
	}
	cohort, labs := dataset("cohort"), dataset("labs")
	scan := func(id, ds, name string) map[string]any {
		return map[string]any{"operatorID": id, "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": "texera://datasets/" + ds + "@1/files/" + name + ".csv"}}
	}
	link := func(from, to, port string) map[string]any {
		return map[string]any{"linkID": from + to, "source": map[string]any{"operatorID": from, "portID": "output-0"}, "target": map[string]any{"operatorID": to, "portID": port}}
	}
	lows := map[string]any{"operatorID": "lows", "operatorType": "filter", "operatorProperties": map[string]any{"where": "glucose < 70"}}
	both := map[string]any{"operatorID": "both", "operatorType": "HashJoin", "operatorProperties": map[string]any{}, "customDisplayName": "Both tables"}
	v1 := map[string]any{"operators": []any{scan("c", cohort, "cohort"), lows}, "links": []any{link("c", "lows", "input-0")}}
	v2 := map[string]any{"operators": []any{scan("c", cohort, "cohort"), scan("l", labs, "labs"), both}, "links": []any{link("c", "both", "input-0"), link("l", "both", "input-1")}}
	var wf envelope
	h.mustJSON("alice", "POST", p+"/workflows", map[string]any{"name": "screen", "spec": v1}, &wf)
	executed := func(step string) envelope {
		t.Helper()
		exec, _ := runOnUnit(t, h, "alice", rid(wf), map[string]any{})
		report(t, h, exec, step, map[string]any{"opid": step, "state": "Completed", "rowsOut": 1}, map[string]map[string]any{"output-0": {"table": "e_" + strings.ReplaceAll(rid(exec), "-", "") + "." + step + "_output_0", "tupleCount": 1}})
		finish(t, h, exec, "completed")
		return exec
	}
	first := executed("lows")
	h.mustJSON("alice", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": v2}, nil)
	second := executed("both")
	// v3 is saved on the way and never executed; v4, the newest, is not executed yet.
	h.mustJSON("alice", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": v1}, nil)
	h.mustJSON("alice", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": v2}, nil)

	var graph api.ResourceGraph
	h.mustJSON("alice", "GET", p+"/resources/"+rid(wf)+"/graph", nil, &graph)
	if got, want := nodesSaid(graph), []string{"data cohort v1", "data labs v1", "workflow screen v4 v2 v1"}; strings.Join(got, "; ") != strings.Join(want, "; ") {
		t.Fatalf("the nodes, each with the versions that took part:\n got %q\nwant %q", got, want)
	}
	if got, want := edgesSaid(graph), []string{
		"cohort@1 reads screen@1 executed", "cohort@1 reads screen@2 executed", "cohort@1 reads screen@4 named", "labs@1 reads screen@2 executed", "labs@1 reads screen@4 named",
	}; strings.Join(got, "; ") != strings.Join(want, "; ") {
		t.Fatalf("what each version read, and what the newest names:\n got %q\nwant %q", got, want)
	}
	if len(graph.Executions) != 2 || graph.Executions[0].Uri != second.Metadata.Uri || graph.Executions[0].Version != 2 || graph.Executions[1].Uri != first.Metadata.Uri || graph.Executions[1].Version != 1 {
		t.Fatalf("each execution, the newest first, with the version it ran: %+v", graph.Executions)
	}
	results := map[api.Uri]string{}
	for _, r := range graph.Results {
		results[r.Execution] = r.Operator
		if r.Operator == "both" && (r.OperatorType != "HashJoin" || r.DisplayName == nil || *r.DisplayName != "Both tables") {
			t.Errorf("a result says its operator as the version that ran has it: %+v", r)
		}
	}
	if results[first.Metadata.Uri] != "lows" || results[second.Metadata.Uri] != "both" {
		t.Fatalf("each execution's results: %v", results)
	}

	// An execution's page: that execution, the version it ran and what that version read.
	h.mustJSON("alice", "GET", p+"/resources/"+rid(first)+"/graph", nil, &graph)
	if got, want := nodesSaid(graph), []string{"data cohort v1", "workflow screen v1"}; strings.Join(got, "; ") != strings.Join(want, "; ") || len(graph.Executions) != 1 || graph.Executions[0].Uri != first.Metadata.Uri {
		t.Fatalf("the first execution's graph: %q %+v", got, graph.Executions)
	}

	// The labs' page: the execution that read them, and the newest version, which names them.
	h.mustJSON("alice", "GET", p+"/resources/"+labs+"/graph", nil, &graph)
	if got, want := edgesSaid(graph), []string{"cohort@1 reads screen@2 executed", "cohort@1 reads screen@4 named", "labs@1 reads screen@2 executed", "labs@1 reads screen@4 named"}; strings.Join(got, "; ") != strings.Join(want, "; ") {
		t.Fatalf("the labs' graph:\n got %q\nwant %q", got, want)
	}
	if len(graph.Executions) != 1 || graph.Executions[0].Uri != second.Metadata.Uri {
		t.Fatalf("the execution that read the labs: %+v", graph.Executions)
	}

	// A kind outside the lineage has no graph.
	h.mustJSON("alice", "GET", p+"/resources/"+unitOf(h).RID.String()+"/graph", nil, &graph)
	if len(graph.Nodes)+len(graph.Executions)+len(graph.Edges) != 0 {
		t.Fatalf("a unit's graph: %+v", graph)
	}

	// Someone the workflow is shared with sees what it reads stand where it is, unnamed.
	var bob api.Me
	h.mustJSON("bob", "GET", p+"/me", nil, &bob)
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(wf)+"/grants/"+string(bob.Principal.Pid), map[string]any{"relation": "viewer"}, nil)
	h.mustJSON("bob", "GET", p+"/resources/"+rid(wf)+"/graph", nil, &graph)
	hidden := 0
	for _, n := range graph.Nodes {
		if !n.Readable {
			hidden++
			if n.Name != "" || n.Description != nil || n.Role != api.GraphRoleData {
				t.Errorf("an unshared dataset says nothing of itself: %+v", n)
			}
		}
	}
	if hidden != 2 || len(graph.Executions) != 2 {
		t.Fatalf("bob's graph of the workflow: %d unshared, %d executions", hidden, len(graph.Executions))
	}
}

// A function's page draws the executions of the workflow versions that call it, and the newest
// version of each workflow that calls it, dashed when it is not executed.
func TestAFunctionsGraphIsWhatCallsIt(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "cohort", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/cohort.csv", "patient_id,glucose\nP-1,64\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	var fn envelope
	h.mustJSON("alice", "POST", p+"/operators", map[string]any{"name": "time in range", "spec": map[string]any{
		"implementation": map[string]any{"python": map[string]any{"code": tirCode, "function": "time_in_range"}},
	}}, &fn)
	flow := func(name string) envelope {
		var wf envelope
		h.mustJSON("alice", "POST", p+"/workflows", map[string]any{"name": name, "spec": map[string]any{
			"operators": []any{
				map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/cohort.csv"}},
				map[string]any{"operatorID": "tir", "operatorType": string(fn.Metadata.Uri) + "@1", "operatorProperties": map[string]any{"by": []any{"patient_id"}}},
			},
			"links": []any{map[string]any{"linkID": "st", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "tir", "portID": "input-0"}}},
		}}, &wf)
		return wf
	}
	ran, waiting := flow("ran"), flow("waiting")
	exec, _ := runOnUnit(t, h, "alice", rid(ran), map[string]any{})
	finish(t, h, exec, "completed")
	_ = waiting

	var graph api.ResourceGraph
	h.mustJSON("alice", "GET", p+"/resources/"+rid(fn)+"/graph", nil, &graph)
	if got, want := edgesSaid(graph), []string{"cohort@1 reads ran@1 executed", "cohort@1 reads waiting@1 named", "time in range@1 uses ran@1 executed", "time in range@1 uses waiting@1 named"}; strings.Join(got, "; ") != strings.Join(want, "; ") {
		t.Fatalf("what calls the function:\n got %q\nwant %q", got, want)
	}
	if len(graph.Executions) != 1 || graph.Executions[0].Uri != exec.Metadata.Uri {
		t.Fatalf("the executions of what calls it: %+v", graph.Executions)
	}
}
