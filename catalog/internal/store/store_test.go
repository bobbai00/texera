package store_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/apache/texera/catalog/internal/store"
)

// testStore connects to TEXERA_TEST_DATABASE_URL (default: the dev stack's catalog_test
// database), resets the schema and applies migrations. Tests skip when Postgres is absent.
func testStore(t *testing.T) *store.Store {
	t.Helper()
	url := os.Getenv("TEXERA_TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://texera:texera@localhost:15432/catalog_test?sslmode=disable"
	}
	ctx := context.Background()
	st, err := store.Open(ctx, url)
	if err != nil {
		if os.Getenv("TEXERA_TEST_REQUIRE_DB") != "" {
			t.Fatalf("postgres not available: %v", err)
		}
		t.Skipf("postgres not available: %v", err)
	}
	t.Cleanup(st.Close)
	require.NoError(t, st.Reset(ctx))
	require.NoError(t, st.Migrate(ctx))
	return st
}

func user(t *testing.T, st *store.Store, name string) *store.Principal {
	t.Helper()
	subject := "sub-" + name + "-" + uuid.NewString()
	p, created, err := st.EnsureUser(context.Background(), subject, name, nil)
	require.NoError(t, err)
	require.True(t, created)
	return p
}

func TestEnsureUserIsIdempotent(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	a, created, err := st.EnsureUser(ctx, "sub-1", "Alice", nil)
	require.NoError(t, err)
	require.True(t, created)
	b, created, err := st.EnsureUser(ctx, "sub-1", "Alice again", nil)
	require.NoError(t, err)
	require.False(t, created)
	require.Equal(t, a.PID, b.PID)
}

func TestResourceVersionsAndGrants(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	alice := user(t, st, "alice")
	bob := user(t, st, "bob")

	project, _, err := st.CreateResource(ctx, store.NewResource{Kind: "project", Name: "home", OwnerPID: alice.PID, CreatedByPID: alice.PID})
	require.NoError(t, err)
	require.Equal(t, int32(0), project.HeadVno)

	wf, v1, err := st.CreateResource(ctx, store.NewResource{
		Kind: "workflow", Name: "wf", ParentRID: &project.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID,
		Content: json.RawMessage(`{"operators":[],"links":[]}`),
	})
	require.NoError(t, err)
	require.Equal(t, int32(1), wf.HeadVno)
	require.Equal(t, int32(1), v1.Vno)

	// A second version with an optimistic head check.
	head := int32(1)
	v2, err := st.CreateVersion(ctx, store.NewVersion{RID: wf.RID, Content: json.RawMessage(`{"operators":[{"operatorID":"a"}],"links":[]}`), CreatedByPID: alice.PID, ExpectedHead: &head})
	require.NoError(t, err)
	require.Equal(t, int32(2), v2.Vno)
	_, err = st.CreateVersion(ctx, store.NewVersion{RID: wf.RID, Content: json.RawMessage(`{}`), CreatedByPID: alice.PID, ExpectedHead: &head})
	require.ErrorIs(t, err, store.ErrConflict)

	got, err := st.GetVersion(ctx, wf.RID, 0)
	require.NoError(t, err)
	require.Equal(t, int32(2), got.Vno)
	versions, err := st.ListVersions(ctx, wf.RID, 10, 0)
	require.NoError(t, err)
	require.Len(t, versions, 2)
	require.Equal(t, int32(2), versions[0].Vno)

	// Owner and project inheritance.
	ok, err := st.HasRelation(ctx, wf.RID, alice.PID, "owner")
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = st.HasRelation(ctx, wf.RID, bob.PID, "viewer")
	require.NoError(t, err)
	require.False(t, ok)
	_, err = st.PutGrant(ctx, project.RID, bob.PID, "viewer")
	require.NoError(t, err)
	ok, err = st.HasRelation(ctx, wf.RID, bob.PID, "viewer")
	require.NoError(t, err)
	require.True(t, ok, "a grant on the project applies to the workflow below it")
	ok, err = st.HasRelation(ctx, wf.RID, bob.PID, "editor")
	require.NoError(t, err)
	require.False(t, ok)

	// Outbox has tuples for the owner grants, the parent edge and bob's viewer grant.
	pending, err := st.PendingOutbox(ctx, 100)
	require.NoError(t, err)
	var objects []string
	for _, e := range pending {
		objects = append(objects, e.Op+" "+e.Object+"#"+e.Relation+"@"+e.Subject)
	}
	require.Contains(t, objects, "write resource:"+wf.RID.String()+"#parent@resource:"+project.RID.String())
	require.Contains(t, objects, "write resource:"+project.RID.String()+"#viewer@user:"+bob.PID.String())

	// Listing is pre-filtered by readability.
	rs, err := st.SearchResources(ctx, store.ResourceFilter{Kind: "workflow", ReadableBy: &bob.PID})
	require.NoError(t, err)
	require.Len(t, rs, 1)
	rs, err = st.SearchResources(ctx, store.ResourceFilter{Query: "wf", ReadableBy: &alice.PID})
	require.NoError(t, err)
	require.Len(t, rs, 1)

	require.NoError(t, st.SoftDeleteResource(ctx, wf.RID))
	_, err = st.GetResource(ctx, wf.RID)
	require.ErrorIs(t, err, store.ErrNotFound)
}

func TestConversationMessagesAndAgents(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	alice := user(t, st, "alice")
	tpl, _, err := st.CreateResource(ctx, store.NewResource{Kind: "agent_template", Name: "analyst", OwnerPID: alice.PID, CreatedByPID: alice.PID, Spec: json.RawMessage(`{"card":{"name":"analyst","description":"x"}}`)})
	require.NoError(t, err)
	conv, _, err := st.CreateResource(ctx, store.NewResource{Kind: "conversation", Name: "chat", OwnerPID: alice.PID, CreatedByPID: alice.PID})
	require.NoError(t, err)

	agent, err := st.SpawnAgent(ctx, store.NewAgent{DisplayName: "analyst", SponsorPID: alice.PID, TemplateRID: tpl.RID, TemplateVno: 1, ConversationRID: &conv.RID})
	require.NoError(t, err)
	ok, err := st.HasRelation(ctx, conv.RID, agent.PID, "editor")
	require.NoError(t, err)
	require.True(t, ok, "the agent may post to its conversation")

	m1, err := st.AppendMessage(ctx, conv.RID, "user", alice.PID, nil, json.RawMessage(`[{"type":"text","text":"hi"}]`))
	require.NoError(t, err)
	require.Equal(t, int64(1), m1.Seq)
	m2, err := st.AppendMessage(ctx, conv.RID, "assistant", agent.PID, &alice.PID, json.RawMessage(`[{"type":"text","text":"hello"}]`))
	require.NoError(t, err)
	require.Equal(t, int64(2), m2.Seq)
	msgs, err := st.ListMessages(ctx, conv.RID, 1, 10)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	require.Equal(t, "assistant", msgs[0].Role)

	// Resources created in the chat carry its origin.
	wf, _, err := st.CreateResource(ctx, store.NewResource{Kind: "workflow", Name: "built", OwnerPID: alice.PID, CreatedByPID: agent.PID, OnBehalfOfPID: &alice.PID,
		Origin: &store.Origin{Conversation: conv.RID, Seq: 2}, Content: json.RawMessage(`{}`)})
	require.NoError(t, err)
	rs, err := st.SearchResources(ctx, store.ResourceFilter{Origin: &conv.RID})
	require.NoError(t, err)
	require.Len(t, rs, 1)
	require.Equal(t, wf.RID, rs[0].RID)
	require.NotNil(t, rs[0].Origin)
}

func TestExecutionLineage(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	alice := user(t, st, "alice")
	ds, dsv, err := st.CreateResource(ctx, store.NewResource{Kind: "dataset", Name: "iris", OwnerPID: alice.PID, CreatedByPID: alice.PID, ContentKind: "manifest", Content: json.RawMessage(`{"files":[]}`)})
	require.NoError(t, err)
	wf, wfv, err := st.CreateResource(ctx, store.NewResource{Kind: "workflow", Name: "wf", OwnerPID: alice.PID, CreatedByPID: alice.PID, Content: json.RawMessage(`{}`)})
	require.NoError(t, err)
	cu, _, err := st.CreateResource(ctx, store.NewResource{Kind: "computing_unit", Name: "local", OwnerPID: alice.PID, CreatedByPID: alice.PID})
	require.NoError(t, err)

	ex, err := st.CreateExecution(ctx, store.NewExecution{WorkflowRID: wf.RID, WorkflowVno: wfv.Vno, CuRID: cu.RID, ActorPID: alice.PID,
		Inputs: []store.VersionRef{{RID: ds.RID, Vno: dsv.Vno}}})
	require.NoError(t, err)
	require.Equal(t, "pending", ex.Status)

	_, err = st.SetExecutionStatus(ctx, ex.EID, "running", nil)
	require.NoError(t, err)
	require.NoError(t, st.MergeOperatorState(ctx, ex.EID, "scan", json.RawMessage(`{"state":"Completed","tuples":150}`)))
	n := int64(150)
	tbl := "t1"
	require.NoError(t, st.UpsertPortResult(ctx, store.PortResult{EID: ex.EID, Opid: "scan", Port: "output-0", TableID: &tbl, TupleCount: &n}))
	require.NoError(t, st.AddPortInput(ctx, store.PortInput{EID: ex.EID, Opid: "scan", Port: "output-0", RID: ds.RID, Vno: dsv.Vno, Path: "iris.csv"}))
	done, err := st.SetExecutionStatus(ctx, ex.EID, "completed", nil)
	require.NoError(t, err)
	require.NotNil(t, done.FinishedAt)

	results, err := st.ListPortResults(ctx, ex.EID)
	require.NoError(t, err)
	require.Len(t, results, 1)

	up, down, err := st.Lineage(ctx, wf.RID, wfv.Vno)
	require.NoError(t, err)
	require.Len(t, up, 1, "the workflow version read the dataset version")
	require.Equal(t, ds.RID, up[0].From.RID)
	require.Equal(t, "read", up[0].Kind)
	require.Empty(t, down)
	_, down, err = st.Lineage(ctx, ds.RID, dsv.Vno)
	require.NoError(t, err)
	require.Len(t, down, 1)
}
