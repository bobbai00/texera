package server_test

import (
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/adapters/staticunit"
	"github.com/apache/texera/catalog/internal/adapters/unitmux"
	"github.com/apache/texera/catalog/internal/api"
)

// The graph beside a chat is what it read, made and ran, and how they connect: the data a
// workflow reads, the function and the unit it uses and runs on, the tables each execution
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

	var graph api.ResourceGraph
	h.mustJSON("alice", "GET", p+"/conversations/"+rid(conv)+"/graph", nil, &graph)
	if got, want := nodesSaid(graph), []string{"data labs v1", "data readings v1", "function count lows v1 made", "workflow lows v1 made"}; strings.Join(got, "; ") != strings.Join(want, "; ") {
		t.Fatalf("the nodes, each with its versions:\n got %q\nwant %q", got, want)
	}
	// What the version ran read and the function it called, solid.
	if got, want := edgesSaid(graph), []string{"count lows@1 uses lows@1 executed", "labs@1 reads lows@1 executed", "readings@1 reads lows@1 executed"}; strings.Join(got, "; ") != strings.Join(want, "; ") {
		t.Fatalf("the edges:\n got %q\nwant %q", got, want)
	}
	// The execution hangs off the version it ran, says the unit it ran on, and keeps its result.
	if len(graph.Executions) != 1 {
		t.Fatalf("the executions: %+v", graph.Executions)
	}
	x := graph.Executions[0]
	if x.Uri != exec.Metadata.Uri || x.Version != 1 || x.Phase != "completed" || x.Steps != 4 || !x.Made || x.Unit == nil || x.Unit.Name != unitOf(h).Name {
		t.Fatalf("the execution: %+v", x)
	}
	if len(graph.Results) != 1 || graph.Results[0].Execution != exec.Metadata.Uri || graph.Results[0].Operator != "tir" || graph.Results[0].OperatorType != string(fn.Metadata.Uri)+"@1" {
		t.Fatalf("the result: %+v", graph.Results)
	}
	if len(graph.Planned) != 1 || graph.Planned[0].Name != "Overnight risk" || graph.Planned[0].Turn != turn.Turn {
		t.Fatalf("what the plan said and was not made: %+v", graph.Planned)
	}

	// A later execution keeps its results, and the earlier one keeps its own; each hangs off
	// the version of the workflow it ran.
	again, _ := runOnUnit(t, h, "alice", rid(wf), map[string]any{}, inChat...)
	report(t, h, again, "tir", map[string]any{"opid": "tir", "state": "Completed", "rowsOut": 1}, map[string]map[string]any{"output-0": {"table": "e_" + strings.ReplaceAll(rid(again), "-", "") + ".tir_output_0", "tupleCount": 1}})
	finish(t, h, again, "completed")
	h.mustJSON("alice", "GET", p+"/conversations/"+rid(conv)+"/graph", nil, &graph)
	if len(graph.Executions) != 2 || graph.Executions[0].Uri != again.Metadata.Uri {
		t.Fatalf("the executions, the newest first: %+v", graph.Executions)
	}
	for _, x := range graph.Executions {
		if x.Version != 1 {
			t.Errorf("the version an execution ran: %d", x.Version)
		}
	}
	tables := map[string]bool{}
	for _, r := range graph.Results {
		tables[string(r.Execution)] = true
	}
	if !tables[string(exec.Metadata.Uri)] || !tables[string(again.Metadata.Uri)] {
		t.Fatalf("each execution's results, by execution: %v", tables)
	}
	if v := nodeNamed(graph, "lows").Versions[0]; v.Executions == nil || *v.Executions != 2 {
		t.Fatalf("the version counts its executions: %+v", v)
	}
}

// What a workflow version names is drawn whoever touched it: the function a workflow the chat
// ran calls, though the chat never touched it; and for a workflow not executed yet, the data it
// will read, dashed. Workflows come in the order the chat first made or ran them. Only the
// latest plan counts: an item is made by a thing of its kind and name, else by one of its kind
// made in or after the plan's turn, and an execution by one started then; a unit the chat makes
// counts, though no unit is drawn.
func TestAChatsGraphShowsWhatWorkflowsNameAndTheLatestPlan(t *testing.T) {
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
	graphOf := func() (api.ResourceGraph, []string) {
		var graph api.ResourceGraph
		h.mustJSON("alice", "GET", p+"/conversations/"+rid(conv)+"/graph", nil, &graph)
		var flows []string
		for _, n := range graph.Nodes {
			if n.Role == api.GraphRoleWorkflow {
				flows = append(flows, n.Name)
			}
		}
		return graph, append(flows, edgesSaid(graph)...)
	}
	plannedNames := func(graph api.ResourceGraph) []string {
		var out []string
		for _, item := range graph.Planned {
			out = append(out, item.Name)
		}
		return out
	}

	// Turn one plans a draft name, an execution and a dataset; it makes the workflow under
	// another name and runs it, then runs the team's.
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

	graph, said := graphOf()
	if screen := nodeNamed(graph, "my screen"); screen.Turn == nil || *screen.Turn != t1 || !screen.Made {
		t.Fatalf("my screen, made in turn one: %+v", screen)
	}
	if fnNode := nodeNamed(graph, "time in range"); len(fnNode.Versions) != 1 || fnNode.Versions[0].Vno != 1 || fnNode.Description == nil || fnNode.Made || fnNode.Turn != nil {
		t.Fatalf("the team's function, which the chat never touched: %+v", fnNode)
	}
	want := []string{"my screen", "team screen", "cohort@1 reads my screen@1 executed", "cohort@1 reads team screen@1 executed", "time in range@1 uses team screen@1 executed"}
	if strings.Join(said, "; ") != strings.Join(want, "; ") {
		t.Fatalf("the workflows in the order the chat came to them, then the edges:\n got %q\nwant %q", said, want)
	}
	if got := plannedNames(graph); strings.Join(got, ",") != "never made" {
		t.Fatalf("a draft name is made by the workflow of its turn, an execution by the execution: %v", got)
	}

	// Turn two plans afresh, and makes a workflow it does not run: it names the cohort and the
	// function, dashed. The first plan's leftover is given up.
	t2, in2 := turnIn()
	plan(t2, in2, [2]string{"workflow", "next"}, [2]string{"dataset", "Later"})
	h.mustJSON("alice", "POST", p+"/workflows", map[string]any{"name": "next", "spec": map[string]any{
		"defaultComputingUnit": "texera://computing-units/" + unitOf(h).RID.String(),
		"operators":            []any{op("scan", "CSVFileScan", map[string]any{"fileName": file}), op("tir", calls, map[string]any{"by": []any{"patient_id"}})},
		"links":                []any{link("scan", "tir")},
	}}, nil, in2...)
	graph, said = graphOf()
	want = []string{"my screen", "team screen", "next", "cohort@1 reads my screen@1 executed", "cohort@1 reads next@1 named", "cohort@1 reads team screen@1 executed", "time in range@1 uses next@1 named", "time in range@1 uses team screen@1 executed"}
	if strings.Join(said, "; ") != strings.Join(want, "; ") {
		t.Fatalf("a workflow not executed yet, with what it names:\n got %q\nwant %q", said, want)
	}
	if next := nodeNamed(graph, "next"); len(next.Versions) != 1 || next.Versions[0].Executions != nil || !next.Versions[0].Made {
		t.Fatalf("next has not been executed; its one version is the chat's: %+v", next)
	}
	if got := plannedNames(graph); strings.Join(got, ",") != "Later" {
		t.Fatalf("only the latest plan counts: %v", got)
	}

	// Turn three plans a unit and makes it: the plan is done, and no unit is drawn.
	h.mustJSON("alice", "DELETE", p+"/conversations/"+rid(conv)+"/turns/"+t2, nil, nil)
	t3, in3 := turnIn()
	plan(t3, in3, [2]string{"unit", "screening unit"})
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
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "screening unit", "profile": small.Metadata.Uri, "waitSeconds": 5}, nil, in3...)
	graph, _ = graphOf()
	if got := plannedNames(graph); len(got) != 0 {
		t.Fatalf("the unit the plan named is made: %v", got)
	}
	for _, n := range graph.Nodes {
		if n.Kind == "computing-unit" {
			t.Fatalf("a unit is said on an execution, never drawn: %+v", n)
		}
	}
	// Nothing ran on it yet: the graph has it as what the chat's next execution will run on.
	if len(graph.Units) != 1 || graph.Units[0].Name != "screening unit" || graph.Units[0].State == nil || graph.Units[0].Cpu == nil {
		t.Fatalf("the unit the chat made, with how it stands and what it has: %+v", graph.Units)
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

	var graph api.ResourceGraph
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

// nodesSaid says each node of a graph as "<role> <name> v<newest>[ made]", sorted.
func nodesSaid(g api.ResourceGraph) []string {
	var out []string
	for _, n := range g.Nodes {
		said := string(n.Role) + " " + n.Name
		for _, v := range n.Versions {
			said += " v" + strconv.Itoa(int(v.Vno))
		}
		if n.Made {
			said += " made"
		}
		out = append(out, said)
	}
	sort.Strings(out)
	return out
}

// edgesSaid says each edge as "<name>@<vno> <relation> <name>@<vno> executed|named", sorted.
func edgesSaid(g api.ResourceGraph) []string {
	name := map[string]string{}
	for _, n := range g.Nodes {
		name[string(n.Uri)] = n.Name
		if !n.Readable {
			name[string(n.Uri)] = "(not shared)"
		}
	}
	at := func(u api.Uri) string {
		base, vno, _ := strings.Cut(string(u), "@")
		return name[base] + "@" + vno
	}
	var out []string
	for _, e := range g.Edges {
		how := "named"
		if e.Executed {
			how = "executed"
		}
		out = append(out, at(e.From)+" "+string(e.Relation)+" "+at(e.To)+" "+how)
	}
	sort.Strings(out)
	return out
}

// nodeNamed is the node of a graph by its name; the zero node when it has none.
func nodeNamed(g api.ResourceGraph, name string) api.GraphNode {
	for _, n := range g.Nodes {
		if n.Name == name {
			return n
		}
	}
	return api.GraphNode{}
}
