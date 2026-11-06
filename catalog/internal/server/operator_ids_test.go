package server_test

import (
	"net/http"
	"strings"
	"testing"
)

// An operatorID with '_' is refused before anything runs, in words that say what to use: the
// engine cannot keep a port's results under such a name, and an execution of it would start and
// never end.
func TestAnOperatorIDWithAnUnderscoreIsRefusedBeforeItRuns(t *testing.T) {
	h := newHarness(t)
	wf := h.create("alice", "workflows", "underscores", map[string]any{
		"operators": []any{map[string]any{"operatorID": "join_geo", "operatorType": "Limit", "operatorProperties": map[string]any{"limit": 5}}},
		"links":     []any{},
	})
	for _, path := range []string{"/validate", "/run"} {
		status, body := h.do("alice", "POST", p+"/workflows/"+rid(wf)+path, map[string]any{})
		if status != http.StatusBadRequest || !strings.Contains(string(body), "join_geo") || !strings.Contains(string(body), "join-geo") {
			t.Fatalf("%s: %d %s", path, status, body)
		}
	}
}
