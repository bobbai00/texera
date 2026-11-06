package server_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// limitOf is a workflow of one operator, whose one property tells two versions apart.
func limitOf(n int) map[string]any {
	return map[string]any{
		"operators": []any{map[string]any{"operatorID": "limit", "operatorType": "Limit", "operatorProperties": map[string]any{"limit": n}}},
		"links":     []any{},
	}
}

// A workflow several people edit at once is saved by the platform's live service, which holds
// their edits. The version names the people: the first as its creator, all of them as its
// contributors. Nobody else writes in someone's name.
func TestAVersionSavedForThePeopleWhoEditedItNamesThem(t *testing.T) {
	h := newHarness(t)
	alice, bob := principalOf(h, "alice"), principalOf(h, "bob")
	wf := h.create("alice", "workflows", "edited together", limitOf(1))
	edit := p + "/workflows/" + rid(wf) + "/edit"

	var together api.Version
	h.mustJSON("service", "POST", edit, map[string]any{"spec": limitOf(2), "expectedHead": 1, "onBehalfOf": []string{bob, alice}}, &together)
	if together.Vno != 2 || string(together.CreatedBy) != bob {
		t.Fatalf("v%d by %s", together.Vno, together.CreatedBy)
	}
	if together.Contributors == nil || len(*together.Contributors) != 2 || string((*together.Contributors)[0]) != bob || string((*together.Contributors)[1]) != alice {
		t.Fatalf("contributors: %v", together.Contributors)
	}

	// One person's edits: the creator says it all.
	var alone api.Version
	h.mustJSON("service", "POST", edit, map[string]any{"spec": limitOf(3), "expectedHead": 2, "onBehalfOf": []string{alice}}, &alone)
	if string(alone.CreatedBy) != alice || alone.Contributors != nil {
		t.Fatalf("by %s with %v", alone.CreatedBy, alone.Contributors)
	}

	// The history says the same, to anyone who may read it.
	var history api.WorkflowVersionPage
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/versions", nil, &history)
	if len(history.Items) != 3 || string(history.Items[1].CreatedBy) != bob || history.Items[1].Contributors == nil || len(*history.Items[1].Contributors) != 2 {
		t.Fatalf("history: %+v", history.Items)
	}
	var read api.Version
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/versions/2", nil, &read)
	if read.Contributors == nil || len(*read.Contributors) != 2 {
		t.Fatalf("version 2 read back: %v", read.Contributors)
	}

	// A person cannot write in another's name, their own included; a name must be someone's.
	for _, names := range [][]string{{bob}, {alice}} {
		if status, data := h.do("alice", "POST", edit, map[string]any{"spec": limitOf(4), "onBehalfOf": names}); status != http.StatusForbidden {
			t.Errorf("alice writes for %v: %d %s", names, status, data)
		}
	}
	if status, data := h.do("service", "POST", edit, map[string]any{"spec": limitOf(4), "onBehalfOf": []string{"00000000-0000-4000-8000-000000000000"}}); status != http.StatusNotFound {
		t.Errorf("a version for nobody: %d %s", status, data)
	}
	var head api.Version
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/versions/3", nil, &head)
	var wfNow envelope
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf), nil, &wfNow)
	if wfNow.Metadata.Head != 3 {
		t.Fatalf("a refused write made version %d", wfNow.Metadata.Head)
	}
}

// What people are editing right now is the live service's to keep between sessions, beside the
// resource: the catalog stores it as it is given and hands it to nobody else.
func TestTheLiveDocumentIsTheLiveServicesToKeep(t *testing.T) {
	h := newHarness(t)
	wf := h.create("alice", "workflows", "live", limitOf(1))
	live := p + "/resources/" + rid(wf) + "/live"

	if status, data := h.do("service", "GET", live, nil); status != http.StatusNotFound {
		t.Fatalf("before any session: %d %s", status, data)
	}
	h.mustJSON("service", "PUT", live, api.LiveState{BasedOn: vnoPtr(1), State: []byte{0, 1, 2, 250}}, nil)
	var kept api.LiveState
	h.mustJSON("service", "GET", live, nil, &kept)
	if kept.BasedOn == nil || *kept.BasedOn != 1 || string(kept.State) != string([]byte{0, 1, 2, 250}) {
		t.Fatalf("kept: %+v", kept)
	}
	// The next save replaces it.
	h.mustJSON("service", "PUT", live, api.LiveState{BasedOn: vnoPtr(2), State: []byte("later")}, nil)
	h.mustJSON("service", "GET", live, nil, &kept)
	if *kept.BasedOn != 2 || string(kept.State) != "later" {
		t.Fatalf("after the next save: %+v", kept)
	}

	// Its owner goes through the live service like everyone else.
	if status, _ := h.do("alice", "GET", live, nil); status != http.StatusForbidden {
		t.Errorf("alice reads the live document: %d", status)
	}
	if status, _ := h.do("alice", "PUT", live, api.LiveState{State: []byte("mine")}); status != http.StatusForbidden {
		t.Errorf("alice writes the live document: %d", status)
	}
	// A resource that is gone has none.
	h.mustJSON("alice", "DELETE", p+"/workflows/"+rid(wf), nil, nil)
	if status, _ := h.do("service", "GET", live, nil); status != http.StatusNotFound {
		t.Errorf("after the workflow is deleted: %d", status)
	}
}

func vnoPtr(n int) *api.Vno {
	v := api.Vno(n)
	return &v
}

// An agent edits a workflow by a patch whose paths name operators by their place in the spec
// it read. People may change the workflow in the editor meanwhile, so the edit names the head
// its writer saw: when the head moved the edit is refused as a conflict before the patch is
// tried on a spec the writer never read, whether or not it would have applied there.
func TestAPatchAgainstAHeadThatMovedIsAConflictNotABadPatch(t *testing.T) {
	h := newHarness(t)
	wf := h.create("alice", "workflows", "edited by two", limitOf(1))
	edit := p + "/workflows/" + rid(wf) + "/edit"
	// Someone takes the operator out: the head is version 2.
	h.mustJSON("alice", "POST", edit, map[string]any{"spec": map[string]any{"operators": []any{}, "links": []any{}}}, nil)

	moved := func(patch map[string]any) {
		t.Helper()
		status, data := h.do("alice", "POST", edit, map[string]any{"patch": []any{patch}, "expectedHead": 1})
		if status != http.StatusConflict || !strings.Contains(string(data), "head is 2, expected 1") {
			t.Errorf("a patch written against version 1: %d %s", status, data)
		}
	}
	// It no longer applies to the head: what is said is that the workflow changed.
	moved(map[string]any{"op": "replace", "path": "/operators/0/operatorProperties/limit", "value": 9})
	// And one that would apply is not applied to what its writer did not read.
	moved(map[string]any{"op": "add", "path": "/operators/-", "value": map[string]any{"operatorID": "late", "operatorType": "Limit", "operatorProperties": map[string]any{"limit": 3}}})

	// Naming the head that is there, the same patch is the next version.
	var v api.Version
	h.mustJSON("alice", "POST", edit, map[string]any{"expectedHead": 2, "patch": []any{
		map[string]any{"op": "add", "path": "/operators/-", "value": map[string]any{"operatorID": "late", "operatorType": "Limit", "operatorProperties": map[string]any{"limit": 3}}},
	}}, &v)
	if v.Vno != 3 {
		t.Errorf("the patch on the head it names: v%d", v.Vno)
	}
}
