package server_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
)

// Running a workflow authorizes before anything is written, compiles once (the same plan a
// dry run returns) and stores the execution with its plan; a custom operator's pinned
// environment is honoured; a kept execution survives the retention policy.
func TestRunInThreePhases(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	fileURI := string(ds.Metadata.Uri) + "@1/files/iris.csv"
	bob := principalOf(h, "bob")

	// A credential bob may not use: his run is refused before any execution row exists.
	cred := h.create("alice", "credentials", "key", map[string]any{"kind": "api_key"})
	h.mustJSON("alice", "PUT", p+"/credentials/"+rid(cred)+"/secret", map[string]any{"fields": map[string]any{"value": "s3cret"}}, nil)
	op := h.create("alice", "operators", "tagger", map[string]any{
		"operatorType": "Tagger", "inputPorts": []any{map[string]any{"portID": "input-0"}}, "outputPorts": []any{map[string]any{"portID": "output-0"}},
		"propertiesSchema": map[string]any{"type": "object", "properties": map[string]any{"apiKey": map[string]any{"type": "string", "format": "credential"}}},
		"implementation":   map[string]any{"python": map[string]any{"code": "class Tagger:\n    pass\n"}},
	})
	spec := map[string]any{
		"operators": []any{
			map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": fileURI}},
			map[string]any{"operatorID": "tag", "operatorType": string(op.Metadata.Uri) + "@1", "viewResult": true, "operatorProperties": map[string]any{"apiKey": string(cred.Metadata.Uri)}},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "tag", "portID": "input-0"}}},
	}
	wf := h.create("alice", "workflows", "phased", spec)
	for _, r := range []envelope{wf, ds, op} {
		h.mustJSON("alice", "PUT", p+"/resources/"+rid(r)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	}
	if status, body := h.do("bob", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "bob's try"}); status != http.StatusForbidden {
		t.Fatalf("bob may not use the credential: %d %s", status, body)
	}
	var executions api.ExecutionPage
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/executions", nil, &executions)
	if len(executions.Items) != 0 {
		t.Fatalf("a refused run leaves no execution behind: %d", len(executions.Items))
	}

	// A dry run and an execution share the plan; the execution stores it, without the secret.
	var validation api.WorkflowValidation
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/validate", map[string]any{}, &validation)
	// scan feeds tag and shows no result: the plan names tag's table alone.
	if validation.Plan == nil || len(validation.Plan.Outputs) != 1 || validation.Plan.Outputs[0] != (api.PortTable{OperatorID: "tag", PortID: "output-0", Table: "tag_output_0"}) || validation.Plan.Credentials == nil || len(*validation.Plan.Credentials) != 1 {
		t.Fatalf("the dry run returns the plan: %+v", validation.Plan)
	}
	var exec envelope
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "alice's run"}, &exec)
	var execSpec api.ExecutionSpec
	mustDecode(t, exec.Spec, &execSpec)
	if execSpec.Plan == nil || execSpec.Plan.Namespace == nil || *execSpec.Plan.Namespace != "e_"+strings.ReplaceAll(rid(exec), "-", "") {
		t.Fatalf("the execution stores its plan with its namespace: %+v", execSpec.Plan)
	}
	if string(mustJSONBytes(execSpec.Plan.LogicalPlan)) != string(mustJSONBytes(validation.Plan.LogicalPlan)) || string(mustJSONBytes(execSpec.Plan.Outputs)) != string(mustJSONBytes(validation.Plan.Outputs)) {
		t.Fatal("validate and run produce the same plan")
	}
	if strings.Contains(string(mustJSONBytes(execSpec)), "s3cret") {
		t.Fatal("the stored plan holds no secret")
	}
	if !strings.Contains(string(mustJSONBytes(execSpec.Plan.LogicalPlan)), string(cred.Metadata.Uri)) || !strings.Contains(string(mustJSONBytes(execSpec.Plan.LogicalPlan)), fileURI) {
		t.Fatal("the stored plan names the credential and the file by URI")
	}
	deadline := time.Now().Add(10 * time.Second)
	for len(h.unit.starts()) == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	starts := h.unit.starts()
	if len(starts) == 0 {
		t.Fatal("the engine was not started")
	}
	engineSeen := string(mustJSONBytes(starts[len(starts)-1]["logicalPlan"]))
	if !strings.Contains(engineSeen, "s3cret") || strings.Contains(engineSeen, fileURI) {
		t.Fatal("the engine gets the bound copy: the secret in place, the file as a URL")
	}
	if len(execSpec.Plan.Outputs) != 1 || execSpec.Plan.Outputs[0].Table != "tag_output_0" {
		t.Fatalf("the catalog names the output tables: %+v", execSpec.Plan.Outputs)
	}

	// A custom operator pins an environment: an execution that names none takes it, one that names another is refused.
	env := h.create("alice", "environments", "pinned", map[string]any{"python": map[string]any{"packages": []string{"humanize"}}})
	other := h.create("alice", "environments", "other", map[string]any{"python": map[string]any{"packages": []string{"numpy"}}})
	pinned := h.create("alice", "operators", "pinned op", map[string]any{
		"operatorType": "Pinned", "inputPorts": []any{map[string]any{"portID": "input-0"}}, "outputPorts": []any{map[string]any{"portID": "output-0"}},
		"implementation": map[string]any{"python": map[string]any{"code": "class Pinned:\n    pass\n", "environment": string(env.Metadata.Uri)}},
	})
	spec2 := map[string]any{
		"operators": []any{
			map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": fileURI}},
			map[string]any{"operatorID": "pin", "operatorType": string(pinned.Metadata.Uri) + "@1", "viewResult": true, "operatorProperties": map[string]any{}},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "pin", "portID": "input-0"}}},
	}
	wf2 := h.create("alice", "workflows", "pinned run", spec2)
	var run2 envelope
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf2)+"/run", map[string]any{"name": "takes the pin"}, &run2)
	mustDecode(t, run2.Spec, &execSpec)
	if execSpec.Environment == nil || string(*execSpec.Environment) != string(env.Metadata.Uri)+"@1" {
		t.Fatalf("the execution takes the operator's environment: %v", execSpec.Environment)
	}
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf2)+"/executions/"+rid(run2)+"/cancel", map[string]any{}, nil)
	if status, body := h.do("alice", "POST", p+"/workflows/"+rid(wf2)+"/run", map[string]any{"name": "wrong env", "environment": string(other.Metadata.Uri)}); status != http.StatusConflict {
		t.Fatalf("an execution with another environment is refused: %d %s", status, body)
	}

	// A kept execution survives the retention policy.
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/executions/"+rid(exec)+"/cancel", map[string]any{}, nil)
	h.mustJSON("alice", "PATCH", p+"/resources/"+rid(exec), map[string]any{"labels": map[string]any{"texera.keep": "true"}}, nil)
	var settings envelope
	h.mustJSON("admin", "GET", p+"/settings", nil, &settings)
	s := map[string]any{}
	mustDecode(t, settings.Spec, &s)
	s["retention"] = map[string]any{"results": "PT0S"}
	h.mustJSON("admin", "PUT", p+"/settings", map[string]any{"spec": s}, nil)
	var sweep api.RetentionSweep
	h.mustJSON("admin", "POST", p+"/settings/retention/sweep", nil, &sweep)
	var kept envelope
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/executions/"+rid(exec), nil, &kept)
	var st api.ExecutionStatus
	mustDecode(t, kept.Status, &st)
	if st.ResultsExpiredAt != nil {
		t.Fatal("a kept execution is not expired")
	}
	delete(s, "retention")
	h.mustJSON("admin", "PUT", p+"/settings", map[string]any{"spec": s}, nil)
}
