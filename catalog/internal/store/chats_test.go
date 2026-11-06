package store_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/store"
)

// What a chat made is found by the chat: the resources it created and those it made a version
// of, those versions, what they name, and what people attached to their messages.
func TestWhatAChatMadeIsFoundByTheChat(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	alice := user(t, st, "alice")
	lab := project(t, st, alice, "lab")
	chat, _, err := st.CreateResource(ctx, store.NewResource{Kind: "conversation", Name: "chat", ParentRID: &lab.RID, ProjectRID: &lab.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID})
	if err != nil {
		t.Fatal(err)
	}
	in := &store.Origin{Conversation: chat.RID, Turn: uuid.NewString()}
	workflow := func(name string, origin *store.Origin) *store.Resource {
		t.Helper()
		r, _, err := st.CreateResource(ctx, store.NewResource{Kind: "workflow", Name: name, ParentRID: &lab.RID, ProjectRID: &lab.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID,
			Origin: origin, Versioned: true, ContentKind: "spec"})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	made, changed, untouched := workflow("made here", in), workflow("changed here", nil), workflow("untouched", nil)
	spec := json.RawMessage(`{"operators":[]}`)
	if _, _, err := st.UpdateSpec(ctx, store.SpecUpdate{RID: changed.RID, Spec: spec, Versioned: true, ContentKind: "spec", Content: spec, CreatedByPID: alice.PID, Origin: in}); err != nil {
		t.Fatal(err)
	}

	// The chat's resources: the one it created and the one it made a version of.
	rs, err := st.ListResources(ctx, store.ResourceFilter{OriginConversation: &chat.RID})
	if err != nil || !sameRIDs(rs, made.RID, changed.RID) {
		t.Fatalf("made in the chat: %v %v", rids(rs), err)
	}
	// Its versions: v1 of the one it created, v2 of the one it changed, without their content.
	vs, err := st.VersionsMadeIn(ctx, chat.RID)
	if err != nil || len(vs) != 2 || !hasVersion(vs, made.RID, 1) || !hasVersion(vs, changed.RID, 2) || vs[0].Content != nil {
		t.Fatalf("versions made in the chat: %+v %v", vs, err)
	}
	// Versions by name: one that is there, one that is not.
	vs, err = st.VersionSummaries(ctx, []store.VersionKey{{RID: changed.RID, Vno: 1}, {RID: untouched.RID, Vno: 9}})
	if err != nil || len(vs) != 1 || !hasVersion(vs, changed.RID, 1) {
		t.Fatalf("versions by name: %+v %v", vs, err)
	}
	if rs, err := st.ListResources(ctx, store.ResourceFilter{RIDs: []uuid.UUID{untouched.RID}}); err != nil || !sameRIDs(rs, untouched.RID) {
		t.Fatalf("by rid: %v %v", rids(rs), err)
	}

	// What a version names, by its exact name only.
	madeURI, untouchedURI := "texera://workflows/"+made.RID.String(), "texera://workflows/"+untouched.RID.String()
	if err := st.ReplaceReferences(ctx, []store.Edge{{From: madeURI + "@1", Relation: "references", To: untouchedURI + "@1", FromRID: made.RID, ToRID: &untouched.RID}}); err != nil {
		t.Fatal(err)
	}
	if edges, err := st.ReferencesFrom(ctx, []string{madeURI + "@1"}); err != nil || len(edges) != 1 || edges[0].To != untouchedURI+"@1" {
		t.Fatalf("references of v1: %v %v", names(edges), err)
	}
	if edges, _ := st.ReferencesFrom(ctx, []string{madeURI}); len(edges) != 0 {
		t.Fatalf("the resource's name is not its version's: %v", names(edges))
	}

	// What a person attached; what the assistant named is not theirs.
	if _, err := st.AppendMessage(ctx, store.NewMessage{ConversationRID: chat.RID, Role: "user", AuthorPID: alice.PID,
		Parts: json.RawMessage(`[{"type":"text","text":"use this"},{"type":"resource","resource":"texera://datasets/x@1","text":"iris.csv"}]`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendMessage(ctx, store.NewMessage{ConversationRID: chat.RID, Role: "assistant", AuthorPID: alice.PID,
		Parts: json.RawMessage(`[{"type":"resource","resource":"texera://workflows/y"}]`)}); err != nil {
		t.Fatal(err)
	}
	if attached, err := st.Attached(ctx, chat.RID); err != nil || !slices.Equal(attached, []string{"texera://datasets/x@1"}) {
		t.Fatalf("attached: %v %v", attached, err)
	}

	// A deleted resource leaves, its versions with it.
	if err := st.DeleteResource(ctx, made.RID); err != nil {
		t.Fatal(err)
	}
	if vs, _ := st.VersionsMadeIn(ctx, chat.RID); len(vs) != 1 || !hasVersion(vs, changed.RID, 2) {
		t.Fatalf("after a delete: %+v", vs)
	}
	if rs, _ := st.ListResources(ctx, store.ResourceFilter{OriginConversation: &chat.RID}); !sameRIDs(rs, changed.RID) {
		t.Fatalf("after a delete: %v", rids(rs))
	}
}

func rids(rs []store.Resource) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.RID)
	}
	return out
}

func sameRIDs(rs []store.Resource, want ...uuid.UUID) bool {
	got := rids(rs)
	return len(got) == len(want) && !slices.ContainsFunc(want, func(id uuid.UUID) bool { return !slices.Contains(got, id) })
}

func hasVersion(vs []store.Version, rid uuid.UUID, vno int) bool {
	return slices.ContainsFunc(vs, func(v store.Version) bool { return v.RID == rid && v.Vno == vno })
}
