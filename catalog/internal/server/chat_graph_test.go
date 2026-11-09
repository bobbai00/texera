package server_test

import (
	"sort"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/adapters/staticunit"
	"github.com/apache/texera/catalog/internal/adapters/unitmux"
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
	// A run says the unit it ran on, and a table the run that made it.
	for _, n := range graph.Nodes {
		if n.Runs != nil {
			if on := (*n.Runs)[0].Unit; on == nil || string(*on) != "texera://computing-units/"+unitOf(h).RID.String() {
				t.Errorf("the run's unit: %v", on)
			}
		}
		if n.Name == "tir" && (n.Run == nil || string(*n.Run) != string(exec.Metadata.Uri) || !strings.HasPrefix(string(n.Uri), string(*n.Run)+"/")) {
			t.Errorf("the table's run: %v, want %s (the table is %s)", n.Run, exec.Metadata.Uri, n.Uri)
		}
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

// A workflow's node carries the steps of the version it shows, and each table the step that
// made it. What a workflow names is drawn whoever touched it: the function a workflow the chat
// ran calls, though the chat never touched it, and for a workflow not run yet the data it will
// read and the default unit it will run on. Workflows come in the order the chat first made or
// ran them. Only the latest plan counts: an item is made by a thing of its kind and name, else
// by one of its kind made in or after the plan's turn, and a run by a run started then.
func TestAChatsGraphShowsStepsWhatWorkflowsNameAndTheLatestPlan(t *testing.T) {
	h := newHarness(t)
	agent := theAgent(t, h)
	ds := h.create("alice", "datasets", "cohort", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/cohort.csv", "patient_id,glucose\nP-1,64\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	file := string(ds.Metadata.Uri) + "@1/files/cohort.csv"
	op := func(id, typ string, props map[string]any) map[string]any {
		return map[string]any{"operatorID": id, "operatorType": typ, "operatorProperties": props}
	}
	link := func(from, to string) map[string]any {
		return map[string]any{"linkID": from + to, "source": map[string]any{"operatorID": from, "portID": "output-0"}, "target": map[string]any{"operatorID": to, "portID": "input-0"}}
	}
	// The team's function and a workflow that calls it, made outside any chat.
	var fn envelope
	h.mustJSON("alice", "POST", p+"/operators", map[string]any{"name": "time in range", "description": "Time in range per patient.", "spec": map[string]any{
		"implementation": map[string]any{"python": map[string]any{"code": tirCode, "function": "time_in_range"}},
	}}, &fn)
	calls := string(fn.Metadata.Uri) + "@1"
	var team envelope
	h.mustJSON("alice", "POST", p+"/workflows", map[string]any{"name": "team screen", "spec": map[string]any{
		"operators": []any{op("scan", "CSVFileScan", map[string]any{"fileName": file}), op("tir", calls, map[string]any{"by": []any{"patient_id"}})},
		"links":     []any{link("scan", "tir")},
	}}, &team)

	conv := h.create("alice", "conversations", "the work", map[string]any{"template": string(agent.Metadata.Uri)})
	turnIn := func() (string, []string) {
		var turn api.Turn
		h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/turns", map[string]any{}, &turn)
		return turn.Turn, []string{"X-Texera-Origin", "conversation=" + rid(conv) + ";turn=" + turn.Turn + ";template=" + string(turn.Template), "X-Texera-Service-Token", "service"}
	}
	plan := func(turn string, in []string, makes ...[2]string) {
		var items []any
		for _, m := range makes {
			items = append(items, map[string]any{"kind": m[0], "name": m[1]})
		}
		h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/messages", map[string]any{"turn": turn, "role": "assistant", "parts": []any{
			map[string]any{"type": "tool_call", "toolName": "start_work", "toolCallId": "w-" + turn, "args": map[string]any{"goal": "screen", "makes": items}},
		}}, nil, in...)
	}
	ran := func(workflow, step string, in []string) {
		exec, _ := runOnUnit(t, h, "alice", workflow, map[string]any{}, in...)
		ns := "e_" + strings.ReplaceAll(rid(exec), "-", "")
		report(t, h, exec, step, map[string]any{"opid": step, "state": "Completed", "rowsOut": 1}, map[string]map[string]any{"output-0": {"table": ns + "." + step + "_output_0", "tupleCount": 1}})
		finish(t, h, exec, "completed")
	}
	graphOf := func() (api.ConversationGraph, map[string]api.GraphNode, []string) {
		var graph api.ConversationGraph
		h.mustJSON("alice", "GET", p+"/conversations/"+rid(conv)+"/graph", nil, &graph)
		byName := map[string]api.GraphNode{}
		name := map[string]string{}
		var flows []string
		for _, n := range graph.Nodes {
			byName[string(n.Role)+" "+n.Name] = n
			name[string(n.Uri)] = n.Name
			if n.Role == api.GraphRoleWorkflow {
				flows = append(flows, n.Name)
			}
		}
		var edges []string
		for _, e := range graph.Edges {
			edges = append(edges, name[string(e.From)]+" "+string(e.Relation)+" "+name[string(e.To)])
		}
		sort.Strings(edges)
		return graph, byName, append(flows, edges...)
	}
	plannedNames := func(graph api.ConversationGraph) []string {
		var out []string
		for _, item := range graph.Planned {
			out = append(out, item.Name)
		}
		return out
	}

	// Turn one plans a draft name, a run and a dataset; it makes the workflow under another name
	// and runs it, then runs the team's.
	t1, in1 := turnIn()
	plan(t1, in1, [2]string{"workflow", "screen draft"}, [2]string{"run", "rerun team screen"}, [2]string{"dataset", "never made"})
	var mine envelope
	h.mustJSON("alice", "POST", p+"/workflows", map[string]any{"name": "my screen", "spec": map[string]any{
		"operators": []any{op("lows", "filter", map[string]any{"where": "glucose < 70"}), op("scan", "CSVFileScan", map[string]any{"fileName": file})},
		"links":     []any{link("scan", "lows")},
	}}, &mine, in1...)
	ran(rid(mine), "lows", in1)
	ran(rid(team), "tir", in1)
	h.mustJSON("alice", "DELETE", p+"/conversations/"+rid(conv)+"/turns/"+t1, nil, nil)

	graph, nodes, said := graphOf()
	screen := nodes["workflow my screen"]
	var steps []string
	for _, st := range stepsOf(screen) {
		steps = append(steps, st.Id+":"+st.Type)
	}
	if strings.Join(steps, " ") != "scan:CSVFileScan lows:filter" || screen.Turn == nil || *screen.Turn != t1 {
		t.Fatalf("my screen's steps, each after what it reads, and its turn: %v %v", steps, screen.Turn)
	}
	if lows := nodes["data lows"]; lows.Step == nil || *lows.Step != "lows" {
		t.Fatalf("a table says the step that made it: %+v", lows)
	}
	if fnNode := nodes["function time in range"]; fnNode.Version == nil || *fnNode.Version != 1 || fnNode.Description == nil || fnNode.Made || fnNode.Turn != nil {
		t.Fatalf("the team's function, which the chat never touched: %+v", fnNode)
	}
	want := []string{"my screen", "team screen", "cohort reads my screen", "cohort reads team screen", "my screen makes lows", "my screen runsOn " + unitOf(h).Name, "team screen makes tir", "team screen runsOn " + unitOf(h).Name, "time in range uses team screen"}
	if strings.Join(said, "; ") != strings.Join(want, "; ") {
		t.Fatalf("the workflows in the order the chat came to them, then the edges:\n got %q\nwant %q", said, want)
	}
	if got := plannedNames(graph); strings.Join(got, ",") != "never made" {
		t.Fatalf("a draft name is made by the workflow of its turn, a run by the run: %v", got)
	}

	// Turn two plans afresh, and makes a workflow it does not run: it reads the cohort, calls
	// the function and will run on its default unit. The first plan's leftover is given up.
	t2, in2 := turnIn()
	plan(t2, in2, [2]string{"workflow", "next"}, [2]string{"dataset", "Later"})
	h.mustJSON("alice", "POST", p+"/workflows", map[string]any{"name": "next", "spec": map[string]any{
		"defaultComputingUnit": "texera://computing-units/" + unitOf(h).RID.String(),
		"operators":            []any{op("scan", "CSVFileScan", map[string]any{"fileName": file}), op("tir", calls, map[string]any{"by": []any{"patient_id"}})},
		"links":                []any{link("scan", "tir")},
	}}, nil, in2...)
	graph, nodes, said = graphOf()
	want = []string{"my screen", "team screen", "next", "cohort reads my screen", "cohort reads next", "cohort reads team screen", "my screen makes lows", "my screen runsOn " + unitOf(h).Name, "next runsOn " + unitOf(h).Name, "team screen makes tir", "team screen runsOn " + unitOf(h).Name, "time in range uses next", "time in range uses team screen"}
	if strings.Join(said, "; ") != strings.Join(want, "; ") {
		t.Fatalf("a workflow not run yet, with what it will read, use and run on:\n got %q\nwant %q", said, want)
	}
	if next := nodes["workflow next"]; next.Runs != nil || len(stepsOf(next)) != 2 {
		t.Fatalf("next has not run, and shows its version's steps: %+v", next)
	}
	if got := plannedNames(graph); strings.Join(got, ",") != "Later" {
		t.Fatalf("only the latest plan counts: %v", got)
	}

	// A unit the chat makes says how it stands, as one it ran on does.
	h.svc.Units = unitmux.Mux{api.UnitProviderStatic: staticunit.Provider{}}
	h.svc.Config.ProfileUnits = api.UnitProviderStatic
	var profiles api.ResourcePage
	h.mustJSON("alice", "GET", p+"/profiles?limit=50", nil, &profiles)
	var small envelope
	for _, it := range profiles.Items {
		if it.Metadata.Name == "Small" {
			small = it
		}
	}
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "screening unit", "profile": small.Metadata.Uri, "waitSeconds": 5}, nil, in2...)
	_, nodes, _ = graphOf()
	if u := nodes["unit screening unit"]; !u.Made || u.Turn == nil || *u.Turn != t2 || u.State == nil || *u.State == "" {
		t.Fatalf("the unit the chat made, with how it stands: %+v", u)
	}
	if u := nodes["unit screening unit"]; u.Cpu == nil || *u.Cpu != "2" || u.Memory == nil || *u.Memory != "4Gi" {
		t.Fatalf("the unit says what it has: %+v", u)
	}
}

// Above the graph, the outside sources the chat's agent consulted, each with what it asked of
// them; not the platform's own server, which every chat calls, and not the agent's own tools.
func TestAChatsGraphSaysWhatOutsideSourcesItConsulted(t *testing.T) {
	h := newHarness(t)
	agent := theAgent(t, h)
	servers := map[string]string{}
	for u, name := range namesByURI(t, h, "mcp-servers") {
		servers[name] = u
	}
	conv := h.create("alice", "conversations", "the reading", map[string]any{"template": string(agent.Metadata.Uri)})
	var turn api.Turn
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/turns", map[string]any{}, &turn)
	call := func(id, tool, server string, args any) map[string]any {
		part := map[string]any{"type": "tool_call", "toolName": tool, "toolCallId": id, "args": args}
		if server != "" {
			part["server"] = server
		}
		return part
	}
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/messages", map[string]any{"turn": turn.Turn, "role": "assistant", "parts": []any{
		call("c1", "search_resources", servers["catalog"], map[string]any{"q": "diabetes"}),
		call("c2", "search_pubmed", servers["biomcp"], map[string]any{"query": "HbA1c measurement and readmission"}),
		call("c3", "start_work", "", map[string]any{"goal": "Readmission by HbA1c"}),
		call("c4", "search_pubmed", servers["biomcp"], map[string]any{"query": "Strack 2014", "max_results": 5}),
	}}, nil)

	var graph api.ConversationGraph
	h.mustJSON("alice", "GET", p+"/conversations/"+rid(conv)+"/graph", nil, &graph)
	if len(graph.Sources) != 1 || graph.Sources[0].Name != "biomcp" || string(graph.Sources[0].Uri) != servers["biomcp"] {
		t.Fatalf("the sources: %+v", graph.Sources)
	}
	var calls []string
	for _, c := range graph.Sources[0].Calls {
		if c.Turn != turn.Turn {
			t.Errorf("the call's turn: %q", c.Turn)
		}
		calls = append(calls, c.Tool+" "+c.Asked)
	}
	want := []string{"search_pubmed HbA1c measurement and readmission", "search_pubmed query: Strack 2014, max_results: 5"}
	if strings.Join(calls, "; ") != strings.Join(want, "; ") {
		t.Fatalf("the calls:\n got %q\nwant %q", calls, want)
	}
}

func stepsOf(n api.GraphNode) []api.GraphStep {
	if n.Steps == nil {
		return nil
	}
	return *n.Steps
}
