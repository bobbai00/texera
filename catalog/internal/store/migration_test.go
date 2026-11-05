package store_test

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/apache/texera/catalog/internal/store"
)

// A built-in is a resource in the platform's project and nothing on the resource says so. What
// an earlier release seeded there, public and labelled one by one, ends as a fresh seed leaves
// it; what is anywhere else is not touched.
func TestBuiltinsSeededByAnEarlierReleaseEndAsAFreshSeedLeavesThem(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	platform, alice := user(t, st, "platform"), user(t, st, "alice")
	create := func(in store.NewResource) *store.Resource {
		t.Helper()
		r, _, err := st.CreateResource(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	marked := func(more map[string]string) map[string]string {
		labels := map[string]string{"texera.builtin": "true"}
		for k, v := range more {
			labels[k] = v
		}
		return labels
	}
	system := create(store.NewResource{Kind: "project", Name: "Texera", OwnerPID: platform.PID, CreatedByPID: platform.PID, Visibility: "public", Labels: map[string]string{"texera.system": "true"}})
	inSystem := func(kind, name string, labels map[string]string, status string) *store.Resource {
		in := store.NewResource{Kind: kind, Name: name, ParentRID: &system.RID, ProjectRID: &system.RID, OwnerPID: platform.PID, CreatedByPID: platform.PID, Visibility: "public", Labels: labels}
		if status != "" {
			in.Status = json.RawMessage(status)
		}
		return create(in)
	}
	skill := inSystem("skill", "a-skill", marked(map[string]string{"kept": "yes"}), "")
	operator := inSystem("operator", "CSVFileScan", marked(nil), `{"builtin": true, "engine": "e1"}`)
	home := project(t, st, alice, "alice's home")
	hers := create(store.NewResource{Kind: "skill", Name: "hers", ParentRID: &home.RID, ProjectRID: &home.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID, Visibility: "public", Labels: marked(nil)})

	// What made them public so far has been relayed; the migration's own entries are what is left.
	relayed, err := st.PendingOutbox(ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]int64, 0, len(relayed))
	for _, e := range relayed {
		ids = append(ids, e.ID)
	}
	if err := st.MarkOutboxProcessed(ctx, ids); err != nil {
		t.Fatal(err)
	}
	apply(t, "migrations/0004_builtins_by_project.sql")

	get := func(r *store.Resource) *store.Resource {
		t.Helper()
		got, err := st.GetResource(ctx, r.RID)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := get(skill); got.Visibility != "private" || len(got.Labels) != 1 || got.Labels["kept"] != "yes" {
		t.Errorf("the skill: %s, %v", got.Visibility, got.Labels)
	}
	if got := get(operator); got.Visibility != "private" || len(got.Labels) != 0 || string(compact(t, got.Status)) != `{"engine":"e1"}` {
		t.Errorf("the operator: %s, %v, %s", got.Visibility, got.Labels, got.Status)
	}
	// The project is what makes them everyone's, and stays as it was; so does what is alice's.
	if got := get(system); got.Visibility != "public" || got.Labels["texera.system"] != "true" {
		t.Errorf("the platform's project: %s, %v", got.Visibility, got.Labels)
	}
	if got := get(hers); got.Visibility != "public" || got.Labels["texera.builtin"] != "true" {
		t.Errorf("alice's skill: %s, %v", got.Visibility, got.Labels)
	}
	pending, err := st.PendingOutbox(ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	var tuples []string
	for _, e := range pending {
		tuples = append(tuples, e.Op+" "+e.Object+" "+e.Relation+" "+e.Subject)
	}
	want := []string{"delete resource:" + skill.RID.String() + " viewer user:*", "delete resource:" + operator.RID.String() + " viewer user:*"}
	sort.Strings(tuples)
	sort.Strings(want)
	if len(tuples) != 2 || tuples[0] != want[0] || tuples[1] != want[1] {
		t.Errorf("tuples to relay: %v", tuples)
	}
	// Applied again it finds nothing to do.
	if err := st.MarkOutboxProcessed(ctx, []int64{pending[0].ID, pending[1].ID}); err != nil {
		t.Fatal(err)
	}
	apply(t, "migrations/0004_builtins_by_project.sql")
	if again, _ := st.PendingOutbox(ctx, 1000); len(again) != 0 {
		t.Errorf("a second run enqueued %d tuples", len(again))
	}
}

// apply runs a migration file against the test database, as Migrate does once.
func apply(t *testing.T, file string) {
	t.Helper()
	sql, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	url := os.Getenv("TEXERA_TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://texera:texera@localhost:15432/catalog_test?sslmode=disable"
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, string(sql)); err != nil {
		t.Fatalf("%s: %v", file, err)
	}
}

func compact(t *testing.T, raw json.RawMessage) json.RawMessage {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(v)
	return out
}
