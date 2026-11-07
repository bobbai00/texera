package server_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
)

func riskContract() map[string]any {
	return map[string]any{
		"framework": "sklearn", "entry": "model.joblib",
		"inputs":  []any{map[string]any{"attributeName": "Glucose", "attributeType": "double"}, map[string]any{"attributeName": "BMI", "attributeType": "double"}},
		"outputs": []any{map[string]any{"attributeName": "predicted", "attributeType": "long"}, map[string]any{"attributeName": "risk", "attributeType": "double"}},
	}
}

// A model version says what it reads and puts out. Its contract is committed with it and checked
// against its files, carries over to a version that changes only files, and can change alone; a
// dataset has none. A workflow's predict is pinned to a version: the engine gets its contract and
// its files, presigned for the run, and the execution records that it used them.
func TestAModelVersionsContractIsWhatPredictRunsWith(t *testing.T) {
	h := newHarness(t)
	model := h.create("alice", "models", "diabetes risk", map[string]any{"framework": "sklearn", "task": "classification"})
	models := p + "/models/" + rid(model)
	h.mustJSON("alice", "PUT", models+"/files/model.joblib", "fitted bytes", nil)

	bad := riskContract()
	bad["entry"] = "missing.joblib"
	if status, body := h.do("alice", "POST", models+"/commit", map[string]any{"contract": bad}); status != http.StatusBadRequest ||
		!strings.Contains(string(body), `the contract: entry \"missing.joblib\" is not a file of the version: model.joblib`) {
		t.Fatalf("a contract naming no file: %d %s", status, body)
	}
	bad = riskContract()
	bad["outputs"] = []any{map[string]any{"attributeName": "risk", "attributeType": "float"}}
	if status, body := h.do("alice", "POST", models+"/commit", map[string]any{"contract": bad}); status != http.StatusBadRequest ||
		!strings.Contains(string(body), `outputs: risk is of type \"float\"`) {
		t.Fatalf("a contract with a wrong type: %d %s", status, body)
	}
	var v1 api.ModelVersion
	h.mustJSON("alice", "POST", models+"/commit", map[string]any{"message": "fitted", "contract": riskContract()}, &v1)
	if v1.Content.Contract == nil || v1.Content.Contract.Framework != "sklearn" || len(v1.Content.Contract.Outputs) != 2 {
		t.Fatalf("version 1: %+v", v1.Content)
	}
	// New files keep the contract; a new contract alone makes a version over the same files.
	h.mustJSON("alice", "PUT", models+"/files/README.md", "how it was fitted", nil)
	var v2, v3 api.ModelVersion
	h.mustJSON("alice", "POST", models+"/commit", map[string]any{"message": "notes"}, &v2)
	if v2.Content.Contract == nil || len(v2.Content.Files) != 2 {
		t.Fatalf("version 2: %+v", v2.Content)
	}
	needs := riskContract()
	needs["needs"] = "nothing special"
	h.mustJSON("alice", "POST", models+"/commit", map[string]any{"contract": needs}, &v3)
	if v3.Vno != 3 || v3.Content.Contract.Needs == nil || len(v3.Content.Files) != 2 {
		t.Fatalf("version 3: %+v", v3.Content)
	}
	ds := h.create("alice", "datasets", "pima", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/pima.csv", "Glucose,BMI\n148,33.6\n", nil)
	if status, body := h.do("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{"contract": riskContract()}); status != http.StatusBadRequest ||
		!strings.Contains(string(body), "only a model version has a contract") {
		t.Fatalf("a dataset with a contract: %d %s", status, body)
	}
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)

	// predict, pinned to version 1.
	fileURI := string(ds.Metadata.Uri) + "@1/files/pima.csv"
	wf := h.create("alice", "workflows", "scored", map[string]any{
		"operators": []any{
			map[string]any{"operatorID": "cohort", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": fileURI}},
			map[string]any{"operatorID": "scored", "operatorType": "predict", "operatorProperties": map[string]any{"model": string(model.Metadata.Uri) + "@1"}},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "cohort", "portID": "output-0"}, "target": map[string]any{"operatorID": "scored", "portID": "input-0"}}},
	})
	var exec envelope
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "scored"}, &exec)
	deadline := time.Now().Add(10 * time.Second)
	for len(h.unit.starts()) == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	starts := h.unit.starts()
	if len(starts) != 1 {
		t.Fatalf("unit starts: %d", len(starts))
	}
	scored := starts[0]["logicalPlan"].(map[string]any)["operators"].([]any)[1].(map[string]any)
	contract, _ := json.Marshal(scored["contract"])
	if scored["model"] != string(model.Metadata.Uri)+"@1" || !strings.Contains(string(contract), `"entry":"model.joblib"`) {
		t.Fatalf("predict's model and contract: %v %s", scored["model"], contract)
	}
	files, _ := scored["files"].(map[string]any)
	if url, _ := files["model.joblib"].(string); len(files) != 1 || url == "" || strings.HasPrefix(url, "texera://") {
		t.Fatalf("the model's files, presigned: %v", files)
	}
	modelFile := string(model.Metadata.Uri) + "@1/files/model.joblib"
	var up api.LineageGraph
	h.mustJSON("alice", "GET", p+"/resources/"+rid(exec)+"/lineage?direction=upstream", nil, &up)
	if !hasEdge(up.Edges, "used", "", modelFile) || !hasEdge(up.Edges, "used", "", fileURI) {
		t.Fatalf("the execution used the model and the data: %+v", up.Edges)
	}

	// A version without a contract cannot be predicted with, and says so before anything runs.
	bare := h.create("alice", "models", "bare", map[string]any{})
	h.mustJSON("alice", "PUT", p+"/models/"+rid(bare)+"/files/model.joblib", "x", nil)
	h.mustJSON("alice", "POST", p+"/models/"+rid(bare)+"/commit", map[string]any{}, nil)
	status, body := h.do("alice", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": map[string]any{
		"operators": []any{
			map[string]any{"operatorID": "cohort", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": fileURI}},
			map[string]any{"operatorID": "scored", "operatorType": "predict", "operatorProperties": map[string]any{"model": string(bare.Metadata.Uri)}},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "cohort", "portID": "output-0"}, "target": map[string]any{"operatorID": "scored", "portID": "input-0"}}},
	}})
	if status != http.StatusOK {
		t.Fatalf("saving: %d %s", status, body)
	}
	status, body = h.do("alice", "POST", p+"/workflows/"+rid(wf)+"/validate", map[string]any{})
	if status != http.StatusBadRequest || !strings.Contains(string(body), "operator scored: model: version 1 of bare has no contract") {
		t.Fatalf("a model without a contract: %d %s", status, body)
	}
}
