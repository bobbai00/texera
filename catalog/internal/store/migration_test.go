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
// Where a workflow's operators sit is part of the workflow's live document, one layout for
// everyone. The places each person kept in their preferences are no longer read, and go; the
// rest of what a person prefers stays.
func TestThePlacesAPersonKeptForACanvasAreDropped(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	alice, bob := user(t, st, "alice"), user(t, st, "bob")
	if _, err := st.UpdatePreferences(ctx, alice.PID, json.RawMessage(`{"project": "p1", "canvas": {"w1": {"scan": {"x": 1, "y": 2}}}, "dock": {"r1": "c1"}}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpdatePreferences(ctx, bob.PID, json.RawMessage(`{"project": "p2"}`)); err != nil {
		t.Fatal(err)
	}
	apply(t, "migrations/0006_layout_in_the_document.sql")

	for who, want := range map[*store.Principal]string{alice: `{"dock": {"r1": "c1"}, "project": "p1"}`, bob: `{"project": "p2"}`} {
		p, err := st.GetPrincipal(ctx, who.PID)
		if err != nil {
			t.Fatal(err)
		}
		var got, expected any
		if err := json.Unmarshal(p.Preferences, &got); err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal([]byte(want), &expected)
		if g, e := mustMarshal(t, got), mustMarshal(t, expected); g != e {
			t.Errorf("%s prefers %s, want %s", who.DisplayName, g, e)
		}
	}
}

// An environment becomes a profile: its packages are the profile's, in every version; what
// named an environment (a default, a chat's choice, a custom operator's pin, the builds a unit
// kept) goes; a reference to it names the profile.
func TestAnEnvironmentBecomesAProfile(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	alice := user(t, st, "alice")
	home := project(t, st, alice, "alice's home")
	create := func(kind, spec, status string, versioned bool) *store.Resource {
		t.Helper()
		in := store.NewResource{Kind: kind, Name: kind, ParentRID: &home.RID, ProjectRID: &home.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID, Visibility: "private", Spec: json.RawMessage(spec)}
		if status != "" {
			in.Status = json.RawMessage(status)
		}
		if versioned {
			in.Versioned, in.ContentKind, in.Content = true, "spec", json.RawMessage(spec)
		}
		r, _, err := st.CreateResource(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	env := create("environment", `{"python": {"version": ">=3.12", "packages": ["pandas", "humanize"]}}`, `{"builds": 1}`, true)
	workflow := create("workflow", `{"operators": [], "links": [], "defaultEnvironment": "texera://environments/x", "defaultWarehouse": "texera://warehouses/y"}`, "", true)
	chat := create("conversation", `{"environment": "texera://environments/x", "computingUnit": "texera://computing-units/u"}`, "", false)
	operator := create("operator", `{"operatorType": "O", "implementation": {"python": {"code": "pass", "environment": "texera://environments/x"}}}`, "", true)
	unit := create("computing-unit", `{"provider": "local"}`, `{"phase": "running", "environments": {"x": "ready"}}`, false)
	from := "texera://workflows/" + workflow.RID.String()
	if err := st.AddEdges(ctx, []store.Edge{{From: from, Relation: "references", To: "texera://environments/" + env.RID.String(), FromRID: workflow.RID, ToRID: &env.RID}}); err != nil {
		t.Fatal(err)
	}
	apply(t, "migrations/0007_profiles.sql")

	get := func(r *store.Resource) *store.Resource {
		t.Helper()
		got, err := st.GetResource(ctx, r.RID)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	profile := get(env)
	if profile.Kind != "profile" || string(compact(t, profile.Spec)) != `{"packages":["pandas","humanize"]}` || profile.Status != nil {
		t.Errorf("the environment is a profile: %s %s %s", profile.Kind, profile.Spec, profile.Status)
	}
	if v, err := st.GetVersion(ctx, env.RID, 1); err != nil || string(compact(t, v.Content)) != `{"packages":["pandas","humanize"]}` {
		t.Errorf("its version: %v", err)
	}
	for r, want := range map[*store.Resource]string{
		workflow: `{"defaultWarehouse":"texera://warehouses/y","links":[],"operators":[]}`,
		chat:     `{"computingUnit":"texera://computing-units/u"}`,
		operator: `{"implementation":{"python":{"code":"pass"}},"operatorType":"O"}`,
	} {
		if got := string(compact(t, get(r).Spec)); got != want {
			t.Errorf("%s: %s, want %s", r.Kind, got, want)
		}
	}
	if got := string(compact(t, get(unit).Status)); got != `{"phase":"running"}` {
		t.Errorf("the unit keeps no builds: %s", got)
	}
	edges, err := st.EdgesFrom(ctx, from, nil)
	if err != nil || len(edges) != 1 || edges[0].To != "texera://profiles/"+env.RID.String() {
		t.Errorf("the reference names the profile: %+v %v", edges, err)
	}
}

// A chat no longer chooses a unit: the one it chose goes, and its other choices stay.
func TestAChatLetsGoOfTheUnitItChose(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	alice := user(t, st, "alice")
	home := project(t, st, alice, "alice's home")
	chat := func(spec string) *store.Resource {
		t.Helper()
		r, _, err := st.CreateResource(ctx, store.NewResource{Kind: "conversation", Name: spec, ParentRID: &home.RID, ProjectRID: &home.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID, Spec: json.RawMessage(spec)})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	chose := chat(`{"modelEndpoint": "texera://model-endpoints/m", "computingUnit": "texera://computing-units/u"}`)
	unit, _, err := st.CreateResource(ctx, store.NewResource{Kind: "computing-unit", Name: "u", ParentRID: &home.RID, ProjectRID: &home.RID, OwnerPID: alice.PID, CreatedByPID: alice.PID, Spec: json.RawMessage(`{"computingUnit": "kept"}`)})
	if err != nil {
		t.Fatal(err)
	}
	apply(t, "migrations/0009_chats_choose_no_unit.sql")

	for r, want := range map[*store.Resource]string{chose: `{"modelEndpoint":"texera://model-endpoints/m"}`, unit: `{"computingUnit":"kept"}`} {
		got, err := st.GetResource(ctx, r.RID)
		if err != nil {
			t.Fatal(err)
		}
		if string(compact(t, got.Spec)) != want {
			t.Errorf("%s: %s, want %s", r.Kind, got.Spec, want)
		}
	}
}

func mustMarshal(t *testing.T, v any) string {
	t.Helper()
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

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
