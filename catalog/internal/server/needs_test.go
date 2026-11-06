package server_test

import (
	"net/http"
	"sort"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// Sharing a workflow says what the person it is shared with cannot open of what it uses: the
// datasets it reads, each marked by whether the sharer may open it to them too. The unit it
// names is where it runs, not something it uses. Only someone who may share the workflow asks.
func TestSharingSaysWhatThePersonCannotOpenOfWhatItUses(t *testing.T) {
	h := newHarness(t)
	dataset := func(who, name string) envelope {
		t.Helper()
		ds := h.create(who, "datasets", name, map[string]any{"format": "csv"})
		h.mustJSON(who, "PUT", p+"/datasets/"+rid(ds)+"/files/data.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
		h.mustJSON(who, "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
		return ds
	}
	alice, bob := string(me(h, "alice").Principal.Pid), string(me(h, "bob").Principal.Pid)
	iris, theirs := dataset("alice", "iris"), dataset("carol", "carol's")
	h.mustJSON("carol", "PUT", p+"/resources/"+rid(theirs)+"/grants/"+alice, map[string]any{"relation": "viewer"}, nil)
	unit := h.create("alice", "computing-units", "alice's unit", map[string]any{"provider": "static", "endpoint": h.unit.URL})
	scan := func(id string, ds envelope) map[string]any {
		return map[string]any{"operatorID": id, "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": uriOf(ds) + "@1/files/data.csv"}}
	}
	wf := h.create("alice", "workflows", "two scans", map[string]any{
		"operators": []any{scan("mine", iris), scan("carol's", theirs)}, "links": []any{}, "defaultComputingUnit": uriOf(unit),
	})
	needs := func() []string {
		t.Helper()
		var got []api.Needed
		h.mustJSON("alice", "GET", p+"/resources/"+rid(wf)+"/needs?principal="+bob, nil, &got)
		var out []string
		for _, n := range got {
			said := n.Resource.Metadata.Name
			if n.Shareable {
				said += ", shareable"
			}
			out = append(out, said)
		}
		sort.Strings(out)
		return out
	}

	// Bob can open neither dataset; alice may open hers to him, not carol's.
	if got := needs(); len(got) != 2 || got[0] != "carol's" || got[1] != "iris, shareable" {
		t.Fatalf("what bob cannot open: %q", got)
	}
	// Once alice shares iris with him, carol's is all that is left.
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(iris)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	if got := needs(); len(got) != 1 || got[0] != "carol's" {
		t.Fatalf("after sharing iris: %q", got)
	}
	// Someone who may not share the workflow does not ask, a viewer of it included.
	if status, _ := h.do("bob", "GET", p+"/resources/"+rid(wf)+"/needs?principal="+alice, nil); status != http.StatusForbidden {
		t.Fatalf("bob asks about alice's workflow: %d", status)
	}
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(wf)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	if status, _ := h.do("bob", "GET", p+"/resources/"+rid(wf)+"/needs?principal="+alice, nil); status != http.StatusForbidden {
		t.Fatalf("a viewer asks: %d", status)
	}
}
