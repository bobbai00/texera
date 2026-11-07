package server_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
)

// A property holding a credential URI reaches the engine as the secret, leased for the execution,
// while every stored document keeps the URI; a function gets it as its Credential setting; and
// someone who may run the workflow but not use the credential is refused.
func TestCredentialsInOperatorProperties(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	fileURI := string(ds.Metadata.Uri) + "@1/files/iris.csv"
	cred := h.create("alice", "credentials", "api key", map[string]any{"kind": "api_key"})
	h.mustJSON("alice", "PUT", p+"/credentials/"+rid(cred)+"/secret", map[string]any{"fields": map[string]any{"value": "s3cret-token"}}, nil)
	ranker := "@returns(Species=str, rank=int)\ndef rank(rows, *, apiKey: Credential, label: str = \"\"):\n    return rows\n"
	op := h.create("alice", "operators", "ranker", map[string]any{
		"implementation": map[string]any{"python": map[string]any{"code": ranker, "function": "rank"}},
	})
	var opSpec api.OperatorSpec
	mustDecode(t, op.Spec, &opSpec)
	if schema, _ := json.Marshal(opSpec.PropertiesSchema); !strings.Contains(string(schema), `"apiKey":{"format":"credential"`) {
		t.Fatalf("a Credential setting is a credential property: %s", schema)
	}
	spec := map[string]any{
		"operators": []any{
			map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": fileURI}},
			map[string]any{"operatorID": "rank", "operatorType": string(op.Metadata.Uri) + "@1", "viewResult": true, "operatorProperties": map[string]any{"apiKey": string(cred.Metadata.Uri), "label": "x"}},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "rank", "portID": "input-0"}}},
	}
	wf := h.create("alice", "workflows", "secret run", spec)

	// Validation compiles with the URI in place: no lease for a compile.
	var compiled api.WorkflowValidation
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/validate", map[string]any{}, &compiled)
	if !compiled.Ok {
		t.Fatalf("compile: %+v", compiled)
	}

	var exec envelope
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "with the key"}, &exec)
	deadline := time.Now().Add(10 * time.Second)
	for len(h.unit.starts()) == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	starts := h.unit.starts()
	if len(starts) != 1 {
		t.Fatalf("unit starts: %d", len(starts))
	}
	rank := starts[0]["logicalPlan"].(map[string]any)["operators"].([]any)[1].(map[string]any)
	args, _ := rank["args"].(map[string]any)
	if rank["operatorType"] != "function" || rank["function"] != "rank" || args["apiKey"] != "s3cret-token" || args["label"] != "x" {
		t.Fatalf("the function should get the secret and the label as its arguments: %v", rank)
	}
	if code, _ := rank["code"].(string); strings.Contains(code, "s3cret-token") {
		t.Fatalf("the secret is an argument, not code: %v", code)
	}
	// The stored documents keep the URI and never the secret: the version names the credential,
	// the execution names its inputs, and the lease records the use.
	_, version := h.do("alice", "GET", p+"/workflows/"+rid(wf)+"/versions/1", nil)
	if strings.Contains(string(version), "s3cret-token") || !strings.Contains(string(version), string(cred.Metadata.Uri)) {
		t.Fatalf("the version must hold the credential URI, never the secret: %s", version)
	}
	if _, body := h.do("alice", "GET", p+"/workflows/"+rid(wf)+"/executions/"+rid(exec), nil); strings.Contains(string(body), "s3cret-token") {
		t.Fatalf("the execution must not hold the secret: %s", body)
	}

	// Alice's execution must be over before another may start on the unit.
	execPath := p + "/workflows/" + rid(wf) + "/executions/" + rid(exec)
	for time.Now().Before(deadline) {
		var current envelope
		h.mustJSON("alice", "GET", execPath, nil, &current)
		if phase := field(current, "phase"); phase == "completed" || phase == "failed" || phase == "cancelled" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	h.json("alice", "POST", execPath+"/cancel", nil, nil)

	// Bob may run the workflow and read the dataset, but may not use alice's credential.
	bob := principalOf(h, "bob")
	for _, r := range []envelope{wf, ds} {
		h.mustJSON("alice", "PUT", p+"/resources/"+rid(r)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	}
	if status, body := h.do("bob", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "without the key"}); status != http.StatusForbidden {
		t.Fatalf("bob's run: %d %s", status, body)
	}
	if len(h.unit.starts()) != 1 {
		t.Fatal("a refused run must not reach the engine")
	}
}

func principalOf(h *harness, token string) string {
	h.t.Helper()
	var me struct {
		Principal struct {
			Pid string `json:"pid"`
		} `json:"principal"`
	}
	h.mustJSON(token, "GET", p+"/me", nil, &me)
	return me.Principal.Pid
}
