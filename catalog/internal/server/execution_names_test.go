package server_test

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"
)

// runToItsEnd starts an execution of a workflow, waits until it runs, and reports its end as
// the unit does: the workflow is free to be run again.
func runToItsEnd(t *testing.T, h *harness, workflow string, body map[string]any) envelope {
	t.Helper()
	var exec envelope
	h.mustJSON("alice", "POST", workflow+"/run", body, &exec)
	path := workflow + "/executions/" + rid(exec)
	for deadline := time.Now().Add(10 * time.Second); field(exec, "phase") != "running" && time.Now().Before(deadline); {
		time.Sleep(20 * time.Millisecond)
		h.mustJSON("alice", "GET", path, nil, &exec)
	}
	if field(exec, "phase") != "running" {
		t.Fatalf("phase: %v", exec.Status)
	}
	finish(t, h, exec, "completed")
	return exec
}

// A workflow is run again and again, the same version on the same unit. An execution nobody
// named is named by the catalog, and the name is its own: two that start within one second
// do not collide.
func TestExecutionsNobodyNamedEachGetANameOfTheirOwn(t *testing.T) {
	h := newHarness(t)
	execPath, first := anExecution(t, h)
	finish(t, h, first, "completed")
	workflow := strings.SplitN(execPath, "/executions/", 2)[0]
	names := map[string]bool{first.Metadata.Name: true}
	said := regexp.MustCompile(`^execution \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}( \(\d+\))?$`)
	numbered := 0
	// Five more, faster than a second apart.
	for i := 0; i < 5; i++ {
		next := runToItsEnd(t, h, workflow, map[string]any{})
		if !said.MatchString(next.Metadata.Name) {
			t.Fatalf("its name: %q", next.Metadata.Name)
		}
		if names[next.Metadata.Name] {
			t.Fatalf("the name %q was given twice", next.Metadata.Name)
		}
		names[next.Metadata.Name] = true
		if strings.HasSuffix(next.Metadata.Name, ")") {
			numbered++
		}
	}
	// Six executions in less than five seconds: at least one shared its second with another.
	if numbered == 0 {
		t.Fatalf("none was numbered: %v", names)
	}
}

// A name the caller chose is the caller's to keep free: when another execution of the
// workflow has it, the refusal says so in words, not in the name of an index.
func TestAnExecutionNamedLikeAnotherIsRefusedInWords(t *testing.T) {
	h := newHarness(t)
	execPath, first := anExecution(t, h)
	finish(t, h, first, "completed")
	workflow := strings.SplitN(execPath, "/executions/", 2)[0]
	runToItsEnd(t, h, workflow, map[string]any{"name": "nightly"})
	wantError(t, h, "POST", workflow+"/run", map[string]any{"name": "nightly"}, http.StatusConflict, "name_taken", "another execution here already has this name")
	// The same for anything made under a name: two workflows of one project.
	h.create("alice", "workflows", "twice", map[string]any{"operators": []any{}, "links": []any{}})
	wantError(t, h, "POST", p+"/workflows", map[string]any{"name": "twice", "spec": map[string]any{"operators": []any{}, "links": []any{}}}, http.StatusConflict, "name_taken", "another workflow here already has this name")
}
