package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/store"
)

// open connects to the test database the dev stack provides, or skips.
func open(t *testing.T) *store.Store {
	t.Helper()
	url := os.Getenv("TEXERA_TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://texera:texera@localhost:15432/catalog_test?sslmode=disable"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := store.Open(ctx, url)
	if err != nil {
		if os.Getenv("TEXERA_TEST_REQUIRE_DB") != "" {
			t.Fatalf("postgres: %v", err)
		}
		t.Skipf("postgres not available: %v", err)
	}
	t.Cleanup(st.Close)
	if err := st.Reset(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	return st
}

func user(t *testing.T, st *store.Store, name string) *store.Principal {
	t.Helper()
	p, _, err := st.EnsureUser(context.Background(), "sub:"+name, name, name+"@example.org", false)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func project(t *testing.T, st *store.Store, owner *store.Principal, name string) *store.Resource {
	t.Helper()
	r, _, err := st.CreateResource(context.Background(), store.NewResource{Kind: "project", Name: name, OwnerPID: owner.PID, CreatedByPID: owner.PID})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestResourcesVersionsAndGrants(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	alice, bob := user(t, st, "alice"), user(t, st, "bob")
	lab := project(t, st, alice, "lab")
	if lab.ProjectRID == nil || *lab.ProjectRID != lab.RID {
		t.Fatalf("a project is its own project: %+v", lab.ProjectRID)
	}

	spec := json.RawMessage(`{"operators":[],"links":[]}`)
	wf, v1, err := st.CreateResource(ctx, store.NewResource{
		Kind: "workflow", Name: "iris", ParentRID: &lab.RID, ProjectRID: &lab.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID,
		Spec: spec, Versioned: true, ContentKind: "spec", Content: spec,
	})
	if err != nil {
		t.Fatal(err)
	}
	if wf.HeadVno != 1 || v1 == nil || v1.Vno != 1 || v1.Digest[:7] != "sha256:" {
		t.Fatalf("first version: head %d, %+v", wf.HeadVno, v1)
	}
	// A second workflow with the same name in the same project is refused.
	if _, _, err := st.CreateResource(ctx, store.NewResource{Kind: "workflow", Name: "Iris", ParentRID: &lab.RID, ProjectRID: &lab.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID, Versioned: true, ContentKind: "spec", Content: spec}); !store.IsConflict(err) {
		t.Fatalf("duplicate name: %v", err)
	}

	// A spec write makes version 2; the stale head is refused; the etag moves.
	spec2 := json.RawMessage(`{"operators":[{"operatorID":"scan"}],"links":[]}`)
	one := 1
	wf2, v2, err := st.UpdateSpec(ctx, store.SpecUpdate{RID: wf.RID, Spec: spec2, ExpectedHead: &one, Versioned: true, ContentKind: "spec", Content: spec2, CreatedByPID: alice.PID})
	if err != nil || wf2.HeadVno != 2 || v2.Vno != 2 || wf2.Etag == wf.Etag {
		t.Fatalf("update: %v head=%d", err, wf2.HeadVno)
	}
	if _, _, err := st.UpdateSpec(ctx, store.SpecUpdate{RID: wf.RID, Spec: spec2, ExpectedHead: &one, Versioned: true, ContentKind: "spec", Content: spec2, CreatedByPID: alice.PID}); !store.IsConflict(err) {
		t.Fatalf("stale head: %v", err)
	}
	if _, _, err := st.UpdateSpec(ctx, store.SpecUpdate{RID: wf.RID, Spec: spec2, IfMatch: "stale", Versioned: true, ContentKind: "spec", Content: spec2, CreatedByPID: alice.PID}); !errors.Is(err, store.ErrPrecondition) {
		t.Fatalf("stale etag: %v", err)
	}
	head, err := st.GetVersion(ctx, wf.RID, 0)
	if err != nil || head.Vno != 2 || !sameJSON(head.Content, spec2) {
		t.Fatalf("head: %+v %v", head, err)
	}
	versions, err := st.ListVersions(ctx, wf.RID, 10, 0)
	if err != nil || len(versions) != 2 || versions[0].Vno != 2 || versions[0].Content != nil {
		t.Fatalf("versions: %+v %v", versions, err)
	}

	// Bob sees nothing private until shared; public is visible to all.
	seen := func(p *store.Principal) int {
		rs, err := st.ListResources(ctx, store.ResourceFilter{Kind: "workflow", ReadableBy: &p.PID})
		if err != nil {
			t.Fatal(err)
		}
		return len(rs)
	}
	if seen(bob) != 0 || seen(alice) != 1 {
		t.Fatalf("visibility: bob %d alice %d", seen(bob), seen(alice))
	}
	if _, err := st.Grant(ctx, lab.RID, bob.PID, "viewer"); err != nil {
		t.Fatal(err)
	}
	if seen(bob) != 1 {
		t.Fatal("a project grant should reach the workflow")
	}
	grants, _ := st.ListGrants(ctx, lab.RID)
	if len(grants) != 2 {
		t.Fatalf("grants: %+v", grants)
	}
	if err := st.Revoke(ctx, lab.RID, bob.PID); err != nil {
		t.Fatal(err)
	}
	if seen(bob) != 0 {
		t.Fatal("revoked")
	}
	public := "public"
	if _, err := st.UpdateMetadata(ctx, store.MetadataUpdate{RID: wf.RID, Visibility: &public}); err != nil {
		t.Fatal(err)
	}
	if seen(bob) != 1 {
		t.Fatal("public")
	}
	pending, _ := st.PendingOutbox(ctx, 100)
	var ops []string
	for _, e := range pending {
		ops = append(ops, e.Op+" "+e.Relation+" "+e.Subject)
	}
	if len(pending) < 6 {
		t.Fatalf("outbox: %v", ops)
	}

	// A filter on a status field, and the origin filter.
	if _, err := st.UpdateStatus(ctx, wf.RID, json.RawMessage(`{"phase":"ready"}`)); err != nil {
		t.Fatal(err)
	}
	rs, err := st.ListResources(ctx, store.ResourceFilter{Fields: map[string]string{"/status/phase": "ready"}})
	if err != nil || len(rs) != 1 {
		t.Fatalf("field filter: %d %v", len(rs), err)
	}

	// Delete, then it is gone and its versions stay readable through nothing.
	if err := st.DeleteResource(ctx, wf.RID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetResource(ctx, wf.RID); !store.IsNotFound(err) {
		t.Fatalf("deleted: %v", err)
	}
}

func TestEdgesAndWalk(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	alice := user(t, st, "alice")
	lab := project(t, st, alice, "lab")
	mk := func(kind, name string) *store.Resource {
		r, _, err := st.CreateResource(ctx, store.NewResource{Kind: kind, Name: name, ParentRID: &lab.RID, ProjectRID: &lab.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID, Versioned: kind != "execution", ContentKind: "spec"})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	ds, wf, out := mk("dataset", "iris"), mk("workflow", "analysis"), mk("dataset", "result")
	ex, _, err := st.CreateResource(ctx, store.NewResource{Kind: "execution", Name: "run 1", ParentRID: &wf.RID, ProjectRID: &lab.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID})
	if err != nil {
		t.Fatal(err)
	}
	dsURI := "texera://datasets/" + ds.RID.String()
	wfURI := "texera://workflows/" + wf.RID.String()
	exURI := wfURI + "/executions/" + ex.RID.String()
	port := exURI + "/operators/agg/ports/output-0"
	outURI := "texera://datasets/" + out.RID.String()
	field := "/operators/0/operatorProperties/fileName"
	if err := st.ReplaceReferences(ctx, []store.Edge{{From: wfURI + "@1", Relation: "references", To: dsURI + "@1/files/iris.csv", FromRID: wf.RID, ToRID: &ds.RID, Field: &field}}); err != nil {
		t.Fatal(err)
	}
	if err := st.AddEdges(ctx, []store.Edge{
		{From: exURI, Relation: "used", To: dsURI + "@1/files/iris.csv", FromRID: ex.RID, ToRID: &ds.RID, ExecutionRID: &ex.RID},
		{From: port, Relation: "produced", To: "iceberg://e_1/agg_output_0@5566", FromRID: ex.RID, ExecutionRID: &ex.RID, Attrs: json.RawMessage(`{"rows":150}`)},
		{From: outURI + "@1", Relation: "derivedFrom", To: port, FromRID: out.RID, ToRID: &ex.RID, ExecutionRID: &ex.RID},
	}); err != nil {
		t.Fatal(err)
	}
	// Upstream of the saved dataset reaches the execution and then iris.csv.
	up, err := st.Walk(ctx, outURI+"@1", true, false, 5)
	if err != nil {
		t.Fatal(err)
	}
	if !hasEdge(up, "derivedFrom", outURI+"@1", port) || !hasEdge(up, "produced", port, "") || !hasEdge(up, "used", exURI, dsURI+"@1/files/iris.csv") {
		t.Fatalf("upstream: %v", names(up))
	}
	// Downstream of the dataset (no version) reaches the execution, the port and the saved dataset.
	down, err := st.Walk(ctx, dsURI, false, true, 5)
	if err != nil {
		t.Fatal(err)
	}
	if !hasEdge(down, "used", exURI, "") || !hasEdge(down, "produced", port, "") || !hasEdge(down, "derivedFrom", outURI+"@1", port) {
		t.Fatalf("downstream: %v", names(down))
	}
	deps, err := st.Dependents(ctx, ds.RID, 0)
	if err != nil || len(deps) != 1 || deps[0].FromRID != wf.RID {
		t.Fatalf("dependents: %+v %v", deps, err)
	}
	if deps, _ := st.Dependents(ctx, ds.RID, 2); len(deps) != 0 {
		t.Fatalf("dependents of v2: %+v", deps)
	}
	// Replacing the workflow's references drops the old arrow.
	if err := st.ReplaceReferences(ctx, []store.Edge{{From: wfURI + "@1", Relation: "references", To: outURI, FromRID: wf.RID, ToRID: &out.RID}}); err != nil {
		t.Fatal(err)
	}
	if deps, _ := st.Dependents(ctx, ds.RID, 0); len(deps) != 0 {
		t.Fatalf("stale reference kept: %+v", deps)
	}
}

func sameJSON(a, b json.RawMessage) bool {
	ca, err1 := store.Canonical(a)
	cb, err2 := store.Canonical(b)
	return err1 == nil && err2 == nil && string(ca) == string(cb)
}

func hasEdge(edges []store.Edge, relation, from, to string) bool {
	for _, e := range edges {
		if e.Relation == relation && (from == "" || e.From == from) && (to == "" || e.To == to) {
			return true
		}
	}
	return false
}

func names(edges []store.Edge) []string {
	var out []string
	for _, e := range edges {
		out = append(out, e.Relation+": "+e.From+" -> "+e.To)
	}
	return out
}

func TestMessagesAndTurns(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	alice := user(t, st, "alice")
	lab := project(t, st, alice, "lab")
	conv, _, err := st.CreateResource(ctx, store.NewResource{Kind: "conversation", Name: "chat", ParentRID: &lab.RID, ProjectRID: &lab.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID, Spec: json.RawMessage(`{"template":"texera://agent-templates/x"}`)})
	if err != nil {
		t.Fatal(err)
	}
	turn := uuid.NewString()
	if err := st.StartTurn(ctx, conv.RID, turn, &alice.PID); err != nil {
		t.Fatal(err)
	}
	if err := st.StartTurn(ctx, conv.RID, uuid.NewString(), nil); !store.IsConflict(err) {
		t.Fatalf("second turn: %v", err)
	}
	// The lock names its holder, for the others in the chat.
	locked, _ := st.GetResource(ctx, conv.RID)
	var lockedStatus map[string]any
	_ = json.Unmarshal(locked.Status, &lockedStatus)
	if lockedStatus["activeTurn"] != turn || lockedStatus["activeTurnBy"] != alice.PID.String() {
		t.Fatalf("turn lock: %v", lockedStatus)
	}
	m1, err := st.AppendMessage(ctx, store.NewMessage{ConversationRID: conv.RID, Turn: &turn, Role: "user", AuthorPID: alice.PID, Parts: json.RawMessage(`[{"type":"text","text":"hi"}]`)})
	if err != nil || m1.Seq != 1 {
		t.Fatalf("first: %+v %v", m1, err)
	}
	tpl := "texera://agent-templates/x@1"
	m2, err := st.AppendMessage(ctx, store.NewMessage{ConversationRID: conv.RID, Turn: &turn, Role: "assistant", AuthorPID: alice.PID, Template: &tpl})
	if err != nil || m2.Seq != 2 || m2.Template == nil {
		t.Fatalf("second: %+v %v", m2, err)
	}
	if _, err := st.ReplaceMessage(ctx, conv.RID, 2, json.RawMessage(`[{"type":"text","text":"hello"}]`), nil); err != nil {
		t.Fatal(err)
	}
	msgs, err := st.ListMessages(ctx, conv.RID, 0, 10)
	if err != nil || len(msgs) != 2 || !sameJSON(msgs[1].Parts, json.RawMessage(`[{"type":"text","text":"hello"}]`)) {
		t.Fatalf("list: %v %v", err, string(msgs[1].Parts))
	}
	if err := st.EndTurn(ctx, conv.RID, turn); err != nil {
		t.Fatal(err)
	}
	c, _ := st.GetResource(ctx, conv.RID)
	var status map[string]any
	_ = json.Unmarshal(c.Status, &status)
	if status["activeTurn"] != nil || status["activeTurnBy"] != nil || status["messages"] != float64(2) {
		t.Fatalf("status: %v", status)
	}
	if err := st.StartTurn(ctx, conv.RID, uuid.NewString(), nil); err != nil {
		t.Fatalf("after end: %v", err)
	}
}

func TestBlobsStagingAndLeases(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	alice := user(t, st, "alice")
	lab := project(t, st, alice, "lab")
	ds, _, err := st.CreateResource(ctx, store.NewResource{Kind: "dataset", Name: "iris", ParentRID: &lab.RID, ProjectRID: &lab.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID, Versioned: true, ContentKind: "manifest", Content: json.RawMessage(`{"files":[]}`)})
	if err != nil {
		t.Fatal(err)
	}
	created, err := st.EnsureBlob(ctx, store.Blob{SHA256: "sha256:abc", Size: 3})
	if err != nil || !created {
		t.Fatalf("blob: %v %v", created, err)
	}
	if created, _ := st.EnsureBlob(ctx, store.Blob{SHA256: "sha256:abc", Size: 3}); created {
		t.Fatal("the same bytes are stored once")
	}
	if err := st.Stage(ctx, store.StagedFile{RID: ds.RID, Path: "iris.csv", SHA256: "sha256:abc", Size: 3}); err != nil {
		t.Fatal(err)
	}
	staged, _ := st.ListStaged(ctx, ds.RID)
	if len(staged) != 1 {
		t.Fatalf("staged: %+v", staged)
	}
	v, err := st.CreateVersion(ctx, store.NewVersion{RID: ds.RID, ContentKind: "manifest", Content: json.RawMessage(`{"files":[{"path":"iris.csv","size":3,"sha256":"sha256:abc"}]}`), CreatedByPID: alice.PID, ClearStaging: true})
	if err != nil || v.Vno != 2 {
		t.Fatalf("commit: %+v %v", v, err)
	}
	if staged, _ := st.ListStaged(ctx, ds.RID); len(staged) != 0 {
		t.Fatal("staging should be cleared by the commit")
	}
	cred, _, err := st.CreateResource(ctx, store.NewResource{Kind: "credential", Name: "key", ParentRID: &lab.RID, ProjectRID: &lab.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID})
	if err != nil {
		t.Fatal(err)
	}
	l, err := st.CreateLease(ctx, cred.RID, alice.PID, "texera://conversations/x", time.Hour)
	if err != nil || l.ExpiresAt.Before(time.Now().Add(50*time.Minute)) {
		t.Fatalf("lease: %+v %v", l, err)
	}
	leases, _ := st.ListLeases(ctx, cred.RID, 10)
	if len(leases) != 1 {
		t.Fatalf("leases: %+v", leases)
	}
	found, err := st.SearchPrincipals(ctx, "ali", "", 10)
	if err != nil || len(found) != 1 || found[0].PID != alice.PID {
		t.Fatalf("search principals: %+v %v", found, err)
	}
}
