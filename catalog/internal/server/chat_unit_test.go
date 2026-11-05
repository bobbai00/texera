package server_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
)

// A chat names the computing unit its runs use. An agent's tool call arrives with the chat as its
// origin, vouched for by the runtime, and the catalog applies the chat's unit itself: where a
// person's data runs is their choice, not something a model has to remember.
func TestARunInAChatUsesTheChatsUnit(t *testing.T) {
	h := newHarness(t)
	other := newFakeUnit(t)
	mine := h.create("alice", "computing-units", "alice's unit", map[string]any{"provider": "static", "endpoint": other.URL})
	theirs := h.create("alice", "computing-units", "a third unit", map[string]any{"provider": "static", "endpoint": other.URL})
	agent := theAgent(t, h)

	workflow := func(name string) string {
		t.Helper()
		ds := h.create("alice", "datasets", name, map[string]any{"format": "csv"})
		h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
		h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
		spec := map[string]any{
			"operators": []any{
				map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/iris.csv"}},
				map[string]any{"operatorID": "avg", "operatorType": "Aggregate", "viewResult": true, "operatorProperties": map[string]any{}},
			},
			"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "avg", "portID": "input-0"}}},
		}
		return rid(h.create("alice", "workflows", name, spec))
	}
	// chat makes a conversation and returns the headers of a tool call made in one of its turns.
	chat := func(name string, spec map[string]any) []string {
		t.Helper()
		spec["template"] = string(agent.Metadata.Uri)
		conv := h.create("alice", "conversations", name, spec)
		var turn api.Turn
		h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/turns", map[string]any{}, &turn)
		return []string{"X-Texera-Origin", "conversation=" + rid(conv) + ";turn=" + turn.Turn + ";template=" + string(turn.Template), "X-Texera-Service-Token", "service"}
	}
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
	if platform == "" || platform == string(mine.Metadata.Uri) {
		t.Fatalf("the platform's default unit: %q", platform)
	}
	inMyChat := chat("on my unit", map[string]any{"computingUnit": string(mine.Metadata.Uri)})

	// The chat's unit, with nothing said about units: the run is there, and that engine got it.
	if got := unitOf(workflow("in the chat"), map[string]any{}, inMyChat...); got != string(mine.Metadata.Uri) {
		t.Fatalf("a run in the chat went to %s", got)
	}
	// The start reaches the engine just after the call returns.
	for deadline := time.Now().Add(10 * time.Second); len(other.starts()) == 0 && time.Now().Before(deadline); {
		time.Sleep(20 * time.Millisecond)
	}
	if len(other.starts()) != 1 || len(h.unit.starts()) != 0 {
		t.Fatalf("starts: the chat's engine %d, the platform's %d", len(other.starts()), len(h.unit.starts()))
	}
	// Compiling in the chat happens there too.
	h.mustJSON("alice", "POST", p+"/workflows/"+workflow("compiled in the chat")+"/validate", map[string]any{}, nil, inMyChat...)
	if other.compiles() != 1 || h.unit.compiles() != 0 {
		t.Fatalf("compiles: the chat's engine %d, the platform's %d", other.compiles(), h.unit.compiles())
	}
	// A unit named in the call wins: the person asked for another one.
	if got := unitOf(workflow("named"), map[string]any{"computingUnit": string(theirs.Metadata.Uri)}, inMyChat...); got != string(theirs.Metadata.Uri) {
		t.Fatalf("a named unit: %s", got)
	}
	// The same run outside any chat, and in a chat that names no unit, falls back as before.
	if got := unitOf(workflow("outside"), map[string]any{}); got != platform {
		t.Fatalf("outside a chat: %s", got)
	}
	if got := unitOf(workflow("no unit"), map[string]any{}, chat("no unit", map[string]any{})...); got != platform {
		t.Fatalf("a chat without a unit: %s", got)
	}

	// The chat's unit gives no right to use it: bob may run the workflow, but not on alice's unit.
	var bob api.Me
	h.mustJSON("bob", "GET", p+"/me", nil, &bob)
	shared := workflow("shared")
	h.mustJSON("alice", "PUT", p+"/resources/"+shared+"/grants/"+string(bob.Principal.Pid), map[string]any{"relation": "viewer"}, nil)
	if status, data := h.do("bob", "POST", p+"/workflows/"+shared+"/run", map[string]any{}, inMyChat...); status != http.StatusForbidden {
		t.Fatalf("bob on alice's unit: %d %s", status, data)
	}
}
