package server_test

import (
	"net/http"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// Where an execution runs is not a chat's to choose. An agent's run in a chat goes where any run
// goes: to the unit the call names, else the workflow's default unit, the project's, the
// platform's; a compile goes there too. A unit asked for by name must be the caller's to use.
func TestARunInAChatGoesWhereAnyRunGoes(t *testing.T) {
	h := newHarness(t)
	other := newFakeUnit(t)
	mine := h.create("alice", "computing-units", "alice's unit", map[string]any{"provider": "static", "endpoint": other.URL})
	theirs := h.create("alice", "computing-units", "a third unit", map[string]any{"provider": "static", "endpoint": other.URL})
	agent := theAgent(t, h)

	workflowOf := func(who, name string, defaults map[string]any) string {
		t.Helper()
		ds := h.create(who, "datasets", name, map[string]any{"format": "csv"})
		h.mustJSON(who, "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
		h.mustJSON(who, "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
		spec := map[string]any{
			"operators": []any{
				map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/iris.csv"}},
				map[string]any{"operatorID": "avg", "operatorType": "Aggregate", "viewResult": true, "operatorProperties": map[string]any{}},
			},
			"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "avg", "portID": "input-0"}}},
		}
		for field, value := range defaults {
			spec[field] = value
		}
		return rid(h.create(who, "workflows", name, spec))
	}
	conv := h.create("alice", "conversations", "the work", map[string]any{"template": string(agent.Metadata.Uri)})
	var turn api.Turn
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/turns", map[string]any{}, &turn)
	inChat := []string{"X-Texera-Origin", "conversation=" + rid(conv) + ";turn=" + turn.Turn + ";template=" + string(turn.Template), "X-Texera-Service-Token", "service"}
	unitOf := func(wf string, body map[string]any, headers ...string) string {
		t.Helper()
		var exec envelope
		h.mustJSON("alice", "POST", p+"/workflows/"+wf+"/run", body, &exec, headers...)
		unit, _ := exec.Spec["computingUnit"].(string)
		return unit
	}
	var settings envelope
	h.mustJSON("alice", "GET", p+"/settings", nil, &settings)
	platform, _ := settings.Spec["defaults"].(map[string]any)["computingUnit"].(string)
	if platform == "" || platform == uriOf(mine) {
		t.Fatalf("the platform's default unit: %q", platform)
	}

	// With nothing said, in the chat as outside it: the platform's unit.
	if got := unitOf(workflowOf("alice", "plain", nil), map[string]any{}, inChat...); got != platform {
		t.Fatalf("a run in the chat went to %s", got)
	}
	// The workflow's own default: a unit made for it is where its runs go, the agent's and a
	// person's alike.
	ownUnit := map[string]any{"defaultComputingUnit": uriOf(mine)}
	if got := unitOf(workflowOf("alice", "with its unit", ownUnit), map[string]any{}, inChat...); got != uriOf(mine) {
		t.Fatalf("a run of a workflow with a unit of its own went to %s", got)
	}
	if got := unitOf(workflowOf("alice", "run by hand", ownUnit), map[string]any{}); got != uriOf(mine) {
		t.Fatalf("the same run outside the chat went to %s", got)
	}
	// A compile in the chat goes there too.
	before := other.compiles()
	h.mustJSON("alice", "POST", p+"/workflows/"+workflowOf("alice", "compiled", ownUnit)+"/validate", map[string]any{}, nil, inChat...)
	if other.compiles() != before+1 {
		t.Fatalf("compiles on the workflow's unit: %d, then %d", before, other.compiles())
	}
	// A unit the call names wins: the person asked for another one.
	if got := unitOf(workflowOf("alice", "named", ownUnit), map[string]any{"computingUnit": uriOf(theirs)}, inChat...); got != uriOf(theirs) {
		t.Fatalf("a named unit: %s", got)
	}
	// Naming a unit gives no right to it: a unit asked for by name must be the caller's to use.
	if status, data := h.do("bob", "POST", p+"/workflows/"+workflowOf("bob", "bob's", nil)+"/run", map[string]any{"computingUnit": uriOf(mine)}); status != http.StatusForbidden {
		t.Fatalf("bob names alice's unit: %d %s", status, data)
	}
}
