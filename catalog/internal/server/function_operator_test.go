package server_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

const tirCode = `import pandas as pd

@returns(patient_id=str, time_in_range=float)
def time_in_range(readings: pd.DataFrame, *, low: int = 70, high: int = 180, token: str = "") -> pd.DataFrame:
    """The share of each patient's readings in range."""
    g = readings.groupby("patient_id")["glucose"]
    return g.apply(lambda s: s.between(low, high).mean()).rename("time_in_range").reset_index()
`

// A Python function is a custom operator: saving it reads its inputs, settings and columns from
// its code, a mistake in it is refused on its line, and a workflow that uses it hands the engine
// a function operator called with the instance's settings, a credential among them as its secret.
func TestAFunctionIsAnOperatorItsCodeDescribes(t *testing.T) {
	h := newHarness(t)
	op := h.create("alice", "operators", "time in range", map[string]any{
		"implementation": map[string]any{"python": map[string]any{"code": tirCode, "function": "time_in_range"}},
	})
	spec := op.Spec
	if spec["operatorType"] != "time_in_range" || spec["description"] != "The share of each patient's readings in range." {
		t.Fatalf("type and description: %v, %v", spec["operatorType"], spec["description"])
	}
	read, _ := json.Marshal(map[string]any{"in": spec["inputPorts"], "settings": spec["propertiesSchema"].(map[string]any)["properties"], "columns": spec["implementation"].(map[string]any)["python"].(map[string]any)["outputColumns"]})
	for _, want := range []string{`"in":[{"portID":"input-0"}]`, `"low":{"default":70,"propertyOrder":1,"type":"integer"}`, `"by":{`, `"columns":[{"attributeName":"patient_id","attributeType":"string"},{"attributeName":"time_in_range","attributeType":"double"}]`} {
		if !strings.Contains(string(read), want) {
			t.Errorf("the spec lacks %s: %s", want, read)
		}
	}

	// A function the catalog cannot read is refused, and says where.
	status, body := h.do("alice", "POST", p+"/operators", map[string]any{"name": "broken", "spec": map[string]any{
		"implementation": map[string]any{"python": map[string]any{"code": "@returns(x=decimal)\ndef broken(t):\n    return t\n", "function": "broken"}}}})
	if status != http.StatusBadRequest || !strings.Contains(string(body), `line 1: column x: \"decimal\" is not a column type`) {
		t.Fatalf("a broken function: %d %s", status, body)
	}

	// A workflow calls it with its settings; by groups its rows; a credential is leased for the run.
	cred := h.create("alice", "credentials", "token", map[string]any{"kind": "api_key"})
	h.mustJSON("alice", "PUT", p+"/credentials/"+rid(cred)+"/secret", map[string]any{"fields": map[string]any{"value": "t0ken"}}, nil)
	ds := h.create("alice", "datasets", "cgm", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/cgm.csv", "patient_id,glucose\nP-1,64\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	wf := h.create("alice", "workflows", "tir", map[string]any{
		"operators": []any{
			map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/cgm.csv"}},
			map[string]any{"operatorID": "tir", "operatorType": string(op.Metadata.Uri) + "@1", "operatorProperties": map[string]any{"by": []any{"patient_id"}, "low": 54, "token": string(cred.Metadata.Uri)}},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "tir", "portID": "input-0"}}},
	})
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "tir"}, nil)
	deadline := time.Now().Add(10 * time.Second)
	for len(h.unit.starts()) == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	starts := h.unit.starts()
	if len(starts) != 1 {
		t.Fatalf("unit starts: %d", len(starts))
	}
	tir := starts[0]["logicalPlan"].(map[string]any)["operators"].([]any)[1].(map[string]any)
	got, _ := json.Marshal(map[string]any{"type": tir["operatorType"], "function": tir["function"], "returns": tir["returns"], "by": tir["by"], "args": tir["args"], "inputs": tir["inputs"]})
	want := `{"args":{"low":54,"token":"t0ken"},"by":["patient_id"],"function":"time_in_range","inputs":[""],"returns":["patient_id string","time_in_range double"],"type":"function"}`
	if string(got) != want {
		t.Fatalf("the engine's operator:\n got  %s\n want %s", got, want)
	}
	if code, _ := tir["code"].(string); !strings.HasPrefix(code, "import pandas as pd") || strings.Contains(code, "PROPS") {
		t.Fatalf("a function's code goes as it is: %q", code)
	}
	if _, version := h.do("alice", "GET", p+"/workflows/"+rid(wf)+"/versions/1", nil); strings.Contains(string(version), "t0ken") {
		t.Fatalf("the version must keep the credential's URI: %s", version)
	}
}
