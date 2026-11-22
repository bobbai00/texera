package server_test

import (
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// A result is saved as the next version of a dataset: one CSV file of the port's rows. Its
// lineage is recorded with it, so the graph draws an arrow from the execution to the version,
// joining the port to the file, and the execution stays while the version derives from it.
// Where it goes is settled before a row is read.
func TestASavedResultIsAVersionThatDerivesFromItsPort(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "cohort", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/cohort.csv", "patient_id,glucose\nP-1,64\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	var wf envelope
	h.mustJSON("alice", "POST", p+"/workflows", map[string]any{"name": "screen", "spec": map[string]any{
		"operators": []any{
			map[string]any{"operatorID": "c", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": "texera://datasets/" + rid(ds) + "@1/files/cohort.csv"}},
			map[string]any{"operatorID": "lows", "operatorType": "filter", "customDisplayName": "Low readings", "operatorProperties": map[string]any{"where": "glucose < 70"}},
		},
		"links": []any{map[string]any{"linkID": "cl", "source": map[string]any{"operatorID": "c", "portID": "output-0"}, "target": map[string]any{"operatorID": "lows", "portID": "input-0"}}},
	}}, &wf)
	exec, _ := runOnUnit(t, h, "alice", rid(wf), map[string]any{})
	at := p + "/workflows/" + rid(wf) + "/executions/" + rid(exec)
	port := at + "/operators/lows/ports/output-0"

	wantError(t, h, "POST", port+"/save", map[string]any{}, http.StatusConflict, "not_completed", "only a completed execution's results are saved")
	report(t, h, exec, "lows", map[string]any{"opid": "lows", "state": "Completed", "rowsOut": 3},
		map[string]map[string]any{"output-0": {"table": "e_" + strings.ReplaceAll(rid(exec), "-", "") + ".lows_output_0", "tupleCount": 3}})
	finish(t, h, exec, "completed")
	// The scan is read by the filter: the plan keeps no table of its rows.
	wantError(t, h, "POST", at+"/operators/c/ports/output-0/save", map[string]any{}, http.StatusNotFound, "not_found", "the result of c/output-0")

	// Someone who may read the workflow, but write neither the dataset nor the project, saves nothing.
	var bob api.Me
	h.mustJSON("bob", "GET", p+"/me", nil, &bob)
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(wf)+"/grants/"+string(bob.Principal.Pid), map[string]any{"relation": "viewer"}, nil)
	if status, body := h.do("bob", "POST", port+"/save", map[string]any{"name": "bobs"}); status != http.StatusForbidden {
		t.Fatalf("bob saves a result in alice's project: %d %s", status, body)
	}

	// Saved as a new dataset of the execution's project, named after the operator and the execution.
	var first api.Version
	if status := h.json("alice", "POST", port+"/save", map[string]any{}, &first); status != http.StatusCreated {
		t.Fatalf("save: %d", status)
	}
	var kept envelope
	h.mustJSON("alice", "GET", p+"/datasets/"+string(first.Rid), nil, &kept)
	if first.Vno != 1 || kept.Metadata.Name != "Low readings of "+exec.Metadata.Name {
		t.Fatalf("the new dataset: v%d %q", first.Vno, kept.Metadata.Name)
	}
	status, rows := h.do("alice", "GET", p+"/datasets/"+string(first.Rid)+"/versions/1/files/lows.csv", nil)
	if status != http.StatusOK || string(rows) != "Species,avg\nsetosa,1.46\nversicolor,4.26\nvirginica,5.55\n" {
		t.Fatalf("the file holds the rows, the columns first: %d %q", status, rows)
	}
	// Saved again into the same dataset, at another path: the next version has both files.
	var second api.Version
	if status := h.json("alice", "POST", port+"/save", map[string]any{"dataset": kept.Metadata.Uri, "path": "again.csv"}, &second); status != http.StatusCreated || second.Vno != 2 {
		t.Fatalf("save again: %d v%d", status, second.Vno)
	}
	var files api.Manifest
	h.mustJSON("alice", "GET", p+"/datasets/"+string(first.Rid)+"/versions/2/files", nil, &files)
	if got := filePaths(files); strings.Join(got, " ") != "again.csv lows.csv" {
		t.Fatalf("the second version's files: %v", got)
	}

	// The execution's graph: what it read, and the versions that keep its result.
	keeps := []string{
		exec.Metadata.Name + " keeps " + kept.Metadata.Name + "@1 executed: operators/lows/ports/output-0 -> files/lows.csv (Low readings)",
		exec.Metadata.Name + " keeps " + kept.Metadata.Name + "@2 executed: operators/lows/ports/output-0 -> files/again.csv (Low readings)",
	}
	var graph api.ResourceGraph
	h.mustJSON("alice", "GET", p+"/resources/"+rid(exec)+"/graph", nil, &graph)
	want := append([]string{"cohort@1 reads screen@1 executed: files/cohort.csv -> operators/c (CSVFileScan)"}, keeps...)
	sort.Strings(want)
	if got := partsSaid(graph); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("the execution's graph:\n got %q\nwant %q", got, want)
	}
	// The saved dataset's page: where its versions came from.
	h.mustJSON("alice", "GET", p+"/resources/"+string(first.Rid)+"/graph", nil, &graph)
	if got := partsSaid(graph); strings.Join(got, "\n") != strings.Join(want, "\n") || len(graph.Executions) != 1 || graph.Executions[0].Uri != exec.Metadata.Uri {
		t.Fatalf("the saved dataset's graph:\n got %q\nwant %q\nexecutions %+v", got, want, graph.Executions)
	}

	// The execution, and the workflow it is of, stay while a version derives from it.
	wantError(t, h, "DELETE", at, nil, http.StatusConflict, "referenced", "referenced by 2")
	wantError(t, h, "DELETE", p+"/workflows/"+rid(wf), nil, http.StatusConflict, "referenced", "referenced by 2")
	h.mustJSON("alice", "DELETE", p+"/datasets/"+string(first.Rid), nil, nil)
	h.mustJSON("alice", "DELETE", at, nil, nil)
}

// An arrow into a workflow version names each operator that reads or uses its source, with the
// file it reads; a function is used whole. A part is executed once an execution ran its operator.
func TestAnArrowNamesThePartsItJoins(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "clinic", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/cohort.csv", "patient_id,glucose\nP-1,64\n", nil)
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/labs.csv", "patient_id,a1c\nP-1,6.1\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	var fn envelope
	h.mustJSON("alice", "POST", p+"/operators", map[string]any{"name": "time in range", "spec": map[string]any{
		"implementation": map[string]any{"python": map[string]any{"code": tirCode, "function": "time_in_range"}},
	}}, &fn)
	scan := func(id, file string) map[string]any {
		return map[string]any{"operatorID": id, "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/" + file}}
	}
	link := func(from, to, port string) map[string]any {
		return map[string]any{"linkID": from + to, "source": map[string]any{"operatorID": from, "portID": "output-0"}, "target": map[string]any{"operatorID": to, "portID": port}}
	}
	var wf envelope
	h.mustJSON("alice", "POST", p+"/workflows", map[string]any{"name": "screen", "spec": map[string]any{
		"operators": []any{
			scan("c", "cohort.csv"), scan("l", "labs.csv"),
			map[string]any{"operatorID": "both", "operatorType": "HashJoin", "operatorProperties": map[string]any{}},
			map[string]any{"operatorID": "tir", "operatorType": string(fn.Metadata.Uri) + "@1", "customDisplayName": "In range", "operatorProperties": map[string]any{"by": []any{"patient_id"}}},
		},
		"links": []any{link("c", "both", "input-0"), link("l", "both", "input-1"), link("both", "tir", "input-0")},
	}}, &wf)

	var graph api.ResourceGraph
	h.mustJSON("alice", "GET", p+"/resources/"+rid(wf)+"/graph", nil, &graph)
	named := []string{
		"clinic@1 reads screen@1 named: files/cohort.csv -> operators/c (CSVFileScan)",
		"clinic@1 reads screen@1 named: files/labs.csv -> operators/l (CSVFileScan)",
		"time in range@1 uses screen@1 named: whole -> operators/tir (In range)",
	}
	if got := partsSaid(graph); strings.Join(got, "\n") != strings.Join(named, "\n") {
		t.Fatalf("what the version names, part by part:\n got %q\nwant %q", got, named)
	}
	exec, _ := runOnUnit(t, h, "alice", rid(wf), map[string]any{})
	finish(t, h, exec, "completed")
	h.mustJSON("alice", "GET", p+"/resources/"+rid(wf)+"/graph", nil, &graph)
	executed := make([]string, len(named))
	for i, s := range named {
		executed[i] = strings.Replace(s, " named:", " executed:", 1)
	}
	if got := partsSaid(graph); strings.Join(got, "\n") != strings.Join(executed, "\n") {
		t.Fatalf("once executed:\n got %q\nwant %q", got, executed)
	}
}

// partsSaid says each part of each arrow as "<from> <relation> <to> executed|named: <part in
// from> -> <part in to> (<the operator's name, else its type>)", sorted.
func partsSaid(g api.ResourceGraph) []string {
	at := endsOf(g)
	var out []string
	for _, e := range g.Edges {
		for _, part := range e.Parts {
			how := "named"
			if part.Executed {
				how = "executed"
			}
			from, to, op := "whole", "whole", ""
			if part.From != nil {
				from = *part.From
			}
			if part.To != nil {
				to = *part.To
			}
			if part.OperatorType != nil {
				op = *part.OperatorType
			}
			if part.DisplayName != nil {
				op = *part.DisplayName
			}
			out = append(out, at(e.From)+" "+string(e.Relation)+" "+at(e.To)+" "+how+": "+from+" -> "+to+" ("+op+")")
		}
	}
	sort.Strings(out)
	return out
}

func filePaths(m api.Manifest) []string {
	var out []string
	for _, f := range m.Files {
		out = append(out, f.Path)
	}
	sort.Strings(out)
	return out
}
