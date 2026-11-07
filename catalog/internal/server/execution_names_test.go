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
// named is named by its start; two that start within one second share the name, and both are
// made: the rid tells them apart.
func TestAWorkflowIsRunAgainAndAgainEachExecutionNamedByItsStart(t *testing.T) {
	h := newHarness(t)
	execPath, first := anExecution(t, h)
	finish(t, h, first, "completed")
	workflow := strings.SplitN(execPath, "/executions/", 2)[0]
	said := regexp.MustCompile(`^execution \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`)
	rids := map[string]bool{rid(first): true}
	// Five more, faster than a second apart.
	for i := 0; i < 5; i++ {
		next := runToItsEnd(t, h, workflow, map[string]any{})
		if !said.MatchString(next.Metadata.Name) {
			t.Fatalf("its name: %q", next.Metadata.Name)
		}
		if rids[rid(next)] {
			t.Fatalf("the rid %s was given twice", rid(next))
		}
		rids[rid(next)] = true
	}
}

// A name is a label people read, not an identity: two workflows of one project, two
// executions of one workflow, may have the same name, made so or renamed so; each keeps its
// own rid and URI, and a list shows both.
func TestNamesAreLabelsTwoResourcesInOnePlaceMayShareOne(t *testing.T) {
	h := newHarness(t)
	execPath, first := anExecution(t, h)
	finish(t, h, first, "completed")
	workflow := strings.SplitN(execPath, "/executions/", 2)[0]
	a := runToItsEnd(t, h, workflow, map[string]any{"name": "nightly"})
	b := runToItsEnd(t, h, workflow, map[string]any{"name": "nightly"})
	if rid(a) == rid(b) || a.Metadata.Name != "nightly" || b.Metadata.Name != "nightly" {
		t.Fatalf("two executions named nightly: %s %q, %s %q", rid(a), a.Metadata.Name, rid(b), b.Metadata.Name)
	}

	empty := map[string]any{"operators": []any{}, "links": []any{}}
	one := h.create("alice", "workflows", "twice", empty)
	two := h.create("alice", "workflows", "twice", empty)
	if rid(one) == rid(two) || one.Metadata.Uri == two.Metadata.Uri {
		t.Fatalf("the two share an identity: %s %s", one.Metadata.Uri, two.Metadata.Uri)
	}
	third := h.create("alice", "workflows", "another", empty)
	if status := h.json("alice", "PATCH", p+"/resources/"+rid(third), map[string]any{"name": "twice"}, nil); status != http.StatusOK {
		t.Fatalf("renaming to a name another has: %d", status)
	}
	var listed struct {
		Items []envelope `json:"items"`
	}
	h.mustJSON("alice", "GET", p+"/resources?kind=workflow&q=twice", nil, &listed)
	n := 0
	for _, w := range listed.Items {
		if w.Metadata.Name == "twice" {
			n++
		}
	}
	if n != 3 {
		t.Fatalf("workflows named twice in the list: %d of %d", n, len(listed.Items))
	}
}
