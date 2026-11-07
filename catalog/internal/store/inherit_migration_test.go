package store_test

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apache/texera/catalog/internal/store"
)

// execSQL runs statements on the test database outside the store.
func execSQL(t *testing.T, sql string, args ...any) {
	t.Helper()
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
	if _, err := conn.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("%s: %v", strings.SplitN(strings.TrimSpace(sql), "\n", 2)[0], err)
	}
}

// A catalog of the release before projects inherited: the platform's project marked as the
// system one, the deployment's settings a resource of their own, a project's defaults at the top
// of its spec, and an administrator a flag on the person. The migration makes the platform's
// project Texera, gives every other project Texera as its base, moves a project's defaults under
// `defaults`, drops the settings, and makes the administrator one of Texera's admins.
func TestTheMigrationMakesEveryProjectInheritFromTexera(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	platform, alice, admin := user(t, st, "platform"), user(t, st, "alice"), user(t, st, "admin")
	// The schema as the release before left it.
	execSQL(t, `DROP TABLE shipped;
		DROP INDEX resource_base_idx;
		ALTER TABLE resource DROP COLUMN base_rid;
		ALTER TABLE principal ADD COLUMN admin boolean NOT NULL DEFAULT false`)
	execSQL(t, `UPDATE principal SET admin = true WHERE pid = ANY($1)`, []uuid.UUID{admin.PID, platform.PID})
	system, lab, unit, settings := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	unitURI, serverURI := "texera://computing-units/"+unit.String(), "texera://mcp-servers/"+uuid.NewString()
	insert := `INSERT INTO resource (rid, kind, name, parent_rid, project_rid, owner_pid, created_by_pid, visibility, labels, spec, etag)
		VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, 'e')`
	execSQL(t, insert, system, "project", "Built-in", nil, system, platform.PID, "public", `{"texera.system": "true"}`, `{}`)
	execSQL(t, `INSERT INTO access_index (rid, pid, relation) VALUES ($1, $2, 'owner')`, system, platform.PID)
	execSQL(t, insert, unit, "computing-unit", "local unit", system, system, platform.PID, "private", `{}`, `{"provider": "static"}`)
	execSQL(t, insert, lab, "project", "lab", nil, lab, alice.PID, "private", `{}`,
		`{"defaultComputingUnit": "`+unitURI+`", "mcpServers": ["`+serverURI+`"], "defaultWorkMode": "manual"}`)
	execSQL(t, insert, settings, "settings", "settings", nil, nil, platform.PID, "public", `{}`, `{"branding": {"name": "Old"}}`)
	execSQL(t, `INSERT INTO edge (from_uri, relation, to_uri, from_rid, to_rid, field) VALUES
		($1, 'references', $2, $3, $4, '/defaultComputingUnit'), ($1, 'references', $5, $3, NULL, '/mcpServers/0'),
		('texera://settings', 'references', $2, $6, $4, '/defaults/computingUnit')`,
		"texera://projects/"+lab.String(), unitURI, lab, unit, serverURI, settings)

	apply(t, "migrations/0012_projects_inherit.sql")

	root, err := st.GetResource(ctx, system)
	if err != nil {
		t.Fatal(err)
	}
	if root.Name != "Texera" || root.Labels["texera.root"] != "true" || root.Labels["texera.system"] != "" || root.BaseRID != nil || root.Visibility != "public" {
		t.Fatalf("Texera: %s %v base %v %s", root.Name, root.Labels, root.BaseRID, root.Visibility)
	}
	got, err := st.GetResource(ctx, lab)
	if err != nil {
		t.Fatal(err)
	}
	if got.BaseRID == nil || *got.BaseRID != system {
		t.Fatalf("the lab inherits from %v", got.BaseRID)
	}
	want := `{"defaults":{"computingUnit":"` + unitURI + `","mcpServers":["` + serverURI + `"],"workMode":"manual"}}`
	if string(compact(t, got.Spec)) != want {
		t.Fatalf("the lab's settings: %s", compact(t, got.Spec))
	}
	deps, err := st.Dependents(ctx, unit, 0)
	if err != nil || len(deps) != 1 || deps[0].Field == nil || *deps[0].Field != "/defaults/computingUnit" || deps[0].From != "texera://projects/"+lab.String() {
		t.Fatalf("what names the unit: %+v %v", deps, err)
	}
	if _, err := st.GetResource(ctx, settings); !store.IsNotFound(err) {
		t.Fatalf("the settings are gone: %v", err)
	}
	if held, err := st.DirectRelation(ctx, system, admin.PID); err != nil || held != "owner" {
		t.Fatalf("the administrator holds %q on Texera: %v", held, err)
	}
	pending, err := st.PendingOutbox(ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	granted := false
	for _, e := range pending {
		granted = granted || (e.Op == "write" && e.Object == "resource:"+system.String() && e.Relation == "owner" && e.Subject == "user:"+admin.PID.String())
	}
	if !granted {
		t.Fatalf("the administrator's grant is not relayed: %+v", pending)
	}
	if _, err := st.GetShipped(ctx, "skill", "anything"); !store.IsNotFound(err) {
		t.Fatalf("the ledger starts empty: %v", err)
	}
	// What a person is, and nothing more: the flag is gone.
	if p, err := st.GetPrincipal(ctx, admin.PID); err != nil || p.DisplayName != "admin" {
		t.Fatalf("the administrator: %+v %v", p, err)
	}
}
