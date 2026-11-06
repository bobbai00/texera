package server_test

import (
	"testing"
)

// What others shared with a person is one list, whatever its kind and wherever it lives: a
// project, a chat, a workflow, a dataset. It holds what they were given, not what they own,
// and a thing leaves it when the grant is taken back.
func TestWhatOthersSharedWithAPersonIsOneList(t *testing.T) {
	h := newHarness(t)
	bob := principalOf(h, "bob")
	empty := map[string]any{"operators": []any{}, "links": []any{}}
	lab := h.create("alice", "projects", "lab", map[string]any{})
	inLab := createIn(h, "alice", "workflows", "in the lab", lab.Metadata.Rid, empty)
	shared := map[string]envelope{
		"the lab":    lab,
		"a workflow": h.create("alice", "workflows", "a workflow", empty),
		"a dataset":  h.create("alice", "datasets", "a dataset", map[string]any{"format": "csv"}),
		"a chat":     h.create("alice", "conversations", "a chat", map[string]any{}),
	}
	kept := h.create("alice", "workflows", "kept to herself", empty)
	bobs := h.create("bob", "workflows", "bob's own", empty)

	if names := list(h, "bob", "/resources?shared=true"); len(names) != 0 {
		t.Fatalf("before anything is shared: %v", names)
	}
	for name, r := range shared {
		relation := "viewer"
		if name == "a chat" {
			relation = "editor"
		}
		h.mustJSON("alice", "PUT", p+"/resources/"+rid(r)+"/grants/"+bob, map[string]any{"relation": relation}, nil)
	}

	// Bob's list holds the four he was given: not what is inside the lab (he gets to that
	// through the lab), not what alice kept, not his own.
	names := list(h, "bob", "/resources?shared=true&limit=200")
	if len(names) != len(shared) {
		t.Fatalf("shared with bob: %v", names)
	}
	for name := range shared {
		if !names[name] && !(name == "the lab" && names["lab"]) {
			t.Errorf("%s is missing from %v", name, names)
		}
	}
	for _, not := range []envelope{inLab, kept, bobs} {
		if names[not.Metadata.Name] {
			t.Errorf("%q is in bob's shared list", not.Metadata.Name)
		}
	}
	// By kind, like any list.
	if got := list(h, "bob", "/resources?shared=true&kind=workflow"); len(got) != 1 || !got["a workflow"] {
		t.Errorf("shared workflows: %v", got)
	}
	// Alice shared; nothing was shared with her.
	if got := list(h, "alice", "/resources?shared=true"); len(got) != 0 {
		t.Errorf("shared with alice: %v", got)
	}
	// And he can open each of them.
	for name, r := range shared {
		if status, _ := h.do("bob", "GET", p+"/resources/"+rid(r), nil); status != 200 {
			t.Errorf("bob opens %s: %d", name, status)
		}
	}

	// A grant taken back takes the thing off the list.
	h.mustJSON("alice", "DELETE", p+"/resources/"+rid(shared["a dataset"])+"/grants/"+bob, nil, nil)
	if got := list(h, "bob", "/resources?shared=true"); got["a dataset"] || len(got) != len(shared)-1 {
		t.Errorf("after the dataset is taken back: %v", got)
	}
}
