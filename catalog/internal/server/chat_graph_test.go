package server_test

import (
	"sort"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// The graph beside a chat is what it read, made and ran, and how they connect: the data a
// workflow reads, the function and the unit it uses and runs on, the table its newest run
// kept; and what its plan said it would make that it has not made yet. Nothing else: not a
// dataset it never touched, not the chat itself.
func TestAChatsGraphIsWhatItReadMadeAndRan(t *testing.T) {
	h := newHarness(t)
	agent := theAgent(t, h)
	dataset := func(name string) envelope {
		t.Helper()
		ds := h.create("alice", "datasets", name, map[string]any{"format": "csv"})
		h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/"+name+".csv", "patient_id,glucose\nP-1,64\n", nil)
		h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
		return ds
	}
	readings, labs := dataset("readings"), dataset("labs")
	dataset("never touched")

	conv := h.create("alice", "conversations", "the work", map[string]any{"template": string(agent.Metadata.Uri)})
	var turn api.Turn
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/turns", map[string]any{}, &turn)
	inChat := []string{"X-Texera-Origin", "conversation=" + rid(conv) + ";turn=" + turn.Turn + ";template=" + string(turn.Template), "X-Texera-Service-Token", "service"}

	// The plan: a function and a workflow it makes, and a dataset it has not made yet.
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/messages", map[string]any{"turn": turn.Turn, "role": "assistant", "parts": []any{
		map[string]any{"type": "tool_call", "toolName": "start_work", "toolCallId": "c1", "args": map[string]any{
			"goal": "Overnight lows per patient",
			"makes": []any{
				map[string]any{"kind": "workflow", "name": "lows"},
				map[string]any{"kind": "dataset", "name": "Overnight risk", "detail": "one row per patient"},
			},
		}},
	}}, nil, inChat...)

	var fn envelope
	h.mustJSON("alice", "POST", p+"/operators", map[string]any{"name": "count lows", "spec": map[string]any{
		"implementation": map[string]any{"python": map[string]any{"code": tirCode, "function": "time_in_range"}},
	}}, &fn, inChat...)
	op := func(id, typ string, props map[string]any) map[string]any {
		return map[string]any{"operatorID": id, "operatorType": typ, "operatorProperties": props}
	}
	link := func(from, to, port string) map[string]any {
		return map[string]any{"linkID": from + to, "source": map[string]any{"operatorID": from, "portID": "output-0"}, "target": map[string]any{"operatorID": to, "portID": port}}
	}
	var wf envelope
	h.mustJSON("alice", "POST", p+"/workflows", map[string]any{"name": "lows", "spec": map[string]any{
		"operators": []any{
			op("r", "CSVFileScan", map[string]any{"fileName": string(readings.Metadata.Uri) + "@1/files/readings.csv"}),
			op("l", "CSVFileScan", map[string]any{"fileName": string(labs.Metadata.Uri) + "@1/files/labs.csv"}),
			op("both", "HashJoin", map[string]any{}),
			op("tir", string(fn.Metadata.Uri)+"@1", map[string]any{"by": []any{"patient_id"}}),
		},
		"links": []any{link("r", "both", "input-0"), link("l", "both", "input-1"), link("both", "tir", "input-0")},
	}}, &wf, inChat...)
	exec, _ := runOnUnit(t, h, "alice", rid(wf), map[string]any{}, inChat...)
	ns := "e_" + strings.ReplaceAll(rid(exec), "-", "")
	report(t, h, exec, "tir", map[string]any{"opid": "tir", "state": "Completed", "rowsOut": 1}, map[string]map[string]any{"output-0": {"table": ns + ".tir_output_0", "tupleCount": 1}})
	finish(t, h, exec, "completed")

	var graph api.ConversationGraph
	h.mustJSON("alice", "GET", p+"/conversations/"+rid(conv)+"/graph", nil, &graph)
	var nodes []string
	for _, n := range graph.Nodes {
		said := string(n.Role) + " " + n.Name
		if n.Made {
			said += " made"
		}
		if n.Runs != nil {
			run := (*n.Runs)[0]
			said += " " + run.Phase
			if run.Steps != 4 {
				t.Errorf("the run's steps: %d", run.Steps)
			}
		}
		nodes = append(nodes, said)
	}
	sort.Strings(nodes)
	want := []string{"data labs", "data readings", "data tir made", "function count lows made", "unit " + unitOf(h).Name, "workflow lows made completed"}
	if strings.Join(nodes, "; ") != strings.Join(want, "; ") {
		t.Fatalf("the nodes:\n got %q\nwant %q", nodes, want)
	}
	name := map[string]string{}
	for _, n := range graph.Nodes {
		name[string(n.Uri)] = n.Name
	}
	var edges []string
	for _, e := range graph.Edges {
		edges = append(edges, name[string(e.From)]+" "+string(e.Relation)+" "+name[string(e.To)])
	}
	sort.Strings(edges)
	wantEdges := []string{"count lows uses lows", "labs reads lows", "lows makes tir", "lows runsOn " + unitOf(h).Name, "readings reads lows"}
	if strings.Join(edges, "; ") != strings.Join(wantEdges, "; ") {
		t.Fatalf("the edges:\n got %q\nwant %q", edges, wantEdges)
	}
	if len(graph.Planned) != 1 || graph.Planned[0].Name != "Overnight risk" || graph.Planned[0].Turn != turn.Turn {
		t.Fatalf("what the plan said and was not made: %+v", graph.Planned)
	}
}
