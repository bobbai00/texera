package server_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
)

const classCode = `from pytexera import *


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        yield tuple_
`

// People and agents write a project's code as Python functions. The classes that run code,
// and the operators the catalog compiles a workflow into, are the engine's: the operator list
// does not offer them, no workflow names them, and an operator's code is refused as a class.
func TestTheEnginesOwnOperatorsAreNotWrittenByHand(t *testing.T) {
	h := newHarness(t)

	// An earlier catalog listed one; a sync drops it, and never lists what the engine keeps.
	sys, project := h.svc.System(), h.svc.SystemProject()
	k, _ := kinds.ByName("operator")
	caller := &auth.Caller{Principal: sys, Service: true}
	if _, _, err := h.svc.Create(t.Context(), caller, catalog.CreateInput{Kind: k, Name: "PythonUDFV2", Parent: &project.RID,
		Spec: json.RawMessage(`{"operatorType":"PythonUDFV2"}`), Owner: &sys.PID}); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.SyncOperators(t.Context(), unitOf(h)); err != nil {
		t.Fatal(err)
	}
	var listed api.ResourcePage
	h.mustJSON("alice", "GET", p+"/operators?limit=500", nil, &listed)
	types := []string{}
	for _, it := range listed.Items {
		types = append(types, it.Spec["operatorType"].(string))
	}
	if strings.Join(types, " ") == "" || strings.Contains(" "+strings.Join(types, " ")+" ", " PythonUDFV2 ") ||
		strings.Contains(" "+strings.Join(types, " ")+" ", " function ") || strings.Contains(" "+strings.Join(types, " ")+" ", " stored ") {
		t.Fatalf("the operators offered: %v", types)
	}

	// A workflow that names one is refused, saying what to write instead; so is an edit.
	scan := map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{}}
	for typ, want := range map[string]string{
		"PythonUDFV2": "operator udf: PythonUDFV2 is the engine's own; write the code as a Python function under @returns(...), saved as one of the project's operators, and call that",
		"function":    "operator udf: function is the engine's own; write the code as a Python function",
		"stored":      "operator udf: stored is the engine's own; a run reuses what an earlier run stored by itself",
	} {
		spec := map[string]any{"operators": []any{scan, map[string]any{"operatorID": "udf", "operatorType": typ, "operatorProperties": map[string]any{"code": classCode}}}, "links": []any{}}
		status, body := h.do("alice", "POST", p+"/workflows", map[string]any{"name": "by hand " + typ, "spec": spec})
		if status != http.StatusBadRequest || !strings.Contains(string(body), want) {
			t.Fatalf("a workflow naming %s: %d %s", typ, status, body)
		}
	}
	wf := h.create("alice", "workflows", "fine", map[string]any{"operators": []any{scan}, "links": []any{}})
	edit := map[string]any{"operators": []any{scan, map[string]any{"operatorID": "udf", "operatorType": "PythonUDFSourceV2", "operatorProperties": map[string]any{}}}, "links": []any{}}
	if status, body := h.do("alice", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": edit}); status != http.StatusBadRequest || !strings.Contains(string(body), "PythonUDFSourceV2 is the engine's own") {
		t.Fatalf("an edit naming PythonUDFSourceV2: %d %s", status, body)
	}

	// An operator's code is a function: a class is refused, before anything is saved.
	status, body := h.do("alice", "POST", p+"/operators", map[string]any{"name": "classy", "spec": map[string]any{
		"implementation": map[string]any{"python": map[string]any{"code": classCode}}}})
	if status != http.StatusBadRequest || !strings.Contains(string(body), "the code defines no function under @returns(...)") || !strings.Contains(string(body), "a class such as UDFOperatorV2 is the engine's own") {
		t.Fatalf("an operator written as a class: %d %s", status, body)
	}

	// One saved as a class before is not run: it says to save its code again as a function.
	op := h.create("alice", "operators", "tagger", map[string]any{
		"implementation": map[string]any{"python": map[string]any{"code": "@returns(Species=str)\ndef tag(rows):\n    return rows\n", "function": "tag"}},
	})
	old := json.RawMessage(`{"operatorType":"tag","inputPorts":[{"portID":"input-0"}],"outputPorts":[{"portID":"output-0"}],"implementation":{"python":{"code":` + mustQuote(classCode) + `}}}`)
	if _, _, err := h.svc.Store.UpdateSpec(t.Context(), store.SpecUpdate{RID: mustUUID(rid(op)), Spec: old, Versioned: true, ContentKind: "spec", Content: old, CreatedByPID: mustUUID(principalOf(h, "alice"))}); err != nil {
		t.Fatal(err)
	}
	legacy := h.create("alice", "workflows", "legacy", map[string]any{
		"operators": []any{scan, map[string]any{"operatorID": "tag", "operatorType": string(op.Metadata.Uri) + "@2", "operatorProperties": map[string]any{}}},
		"links":     []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "tag", "portID": "input-0"}}},
	})
	if status, body := h.do("alice", "POST", p+"/workflows/"+rid(legacy)+"/validate", map[string]any{}); !strings.Contains(string(body), "is not a function under @returns(...): save its code again as one") {
		t.Fatalf("a class saved before: %d %s", status, body)
	}
}

// A function that reads no table is a source: the engine calls it once, with its settings,
// and nothing links into it.
func TestAFunctionThatReadsNoTableIsASource(t *testing.T) {
	h := newHarness(t)
	code := "import pandas as pd\n\n@returns(n=int, square=int)\ndef squares(*, upto: int = 3):\n    \"\"\"The first squares.\"\"\"\n    for n in range(1, upto + 1):\n        yield pd.DataFrame({\"n\": [n], \"square\": [n * n]})\n"
	op := h.create("alice", "operators", "squares", map[string]any{
		"implementation": map[string]any{"python": map[string]any{"code": code, "function": "squares"}},
	})
	if in, _ := json.Marshal(op.Spec["inputPorts"]); string(in) != "[]" {
		t.Fatalf("a source has no input: %s", in)
	}
	wf := h.create("alice", "workflows", "squares", map[string]any{
		"operators": []any{map[string]any{"operatorID": "squares", "operatorType": string(op.Metadata.Uri) + "@1", "viewResult": true, "operatorProperties": map[string]any{"upto": 5}}},
		"links":     []any{},
	})
	before := len(h.unit.starts())
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "squares"}, nil)
	deadline := time.Now().Add(10 * time.Second)
	for len(h.unit.starts()) == before && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	starts := h.unit.starts()
	if len(starts) != before+1 {
		t.Fatal("the unit got no start")
	}
	got := operatorsOf(starts[len(starts)-1])["squares"]
	shape, _ := json.Marshal(map[string]any{"type": got["operatorType"], "inputs": got["inputs"], "in": got["inputPorts"], "args": got["args"]})
	if string(shape) != `{"args":{"upto":5},"in":[],"inputs":[],"type":"function"}` {
		t.Fatalf("the source as the engine gets it: %s", shape)
	}

	// Something linked into it is refused, on the operator.
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species\nsetosa\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	linked := h.create("alice", "workflows", "linked", map[string]any{
		"operators": []any{
			map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/iris.csv"}},
			map[string]any{"operatorID": "squares", "operatorType": string(op.Metadata.Uri) + "@1", "operatorProperties": map[string]any{}},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "squares", "portID": "input-0"}}},
	})
	if status, body := h.do("alice", "POST", p+"/workflows/"+rid(linked)+"/validate", map[string]any{}); !strings.Contains(string(body), "operator squares reads no table, so nothing links into it") {
		t.Fatalf("a link into a source: %d %s", status, body)
	}
}

func mustQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
