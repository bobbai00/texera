package server_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/kinds"
)

// An execution gets a namespace of its own in its warehouse (the platform's, when nothing
// names another), opened for the unit's identity, and the engine is told to write there; the
// catalog reads rows back naming the same place; deleting the execution drops it.
func TestRunOpensTheLakeForTheUnit(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	spec := map[string]any{
		"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "viewResult": true, "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/iris.csv"}}},
		"links":     []any{},
	}
	wf := h.create("alice", "workflows", "lake run", spec)

	// The seeded unit runs as the dev stack's client: its subject is what the grant names.
	var units []envelope
	h.mustJSON("alice", "GET", p+"/computing-units/available", nil, &units)
	var unit *envelope
	for i := range units {
		if units[i].Metadata.Name == "test unit" {
			unit = &units[i]
		}
	}
	if unit == nil {
		t.Fatal("the seeded unit")
	}
	var status api.ComputingUnitStatus
	mustDecode(t, unit.Status, &status)
	if status.Identity == nil || status.Identity.ClientId != "texera-unit" || status.Identity.Subject != "sa:texera-unit" {
		t.Fatalf("the seeded unit's identity: %+v", status.Identity)
	}

	var exec envelope
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "first"}, &exec)
	namespace := "e_" + strings.ReplaceAll(rid(exec), "-", "")
	if got := h.lake.OpenedFor("texera", namespace); got != "sa:texera-unit" {
		t.Fatalf("the namespace is opened for the unit's subject: %q", got)
	}
	deadline := time.Now().Add(10 * time.Second)
	for len(h.unit.starts()) == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	starts := h.unit.starts()
	if len(starts) != 1 {
		t.Fatalf("unit starts: %d", len(starts))
	}
	if rs, _ := starts[0]["resultStore"].(map[string]any); rs["namespace"] != namespace || rs["warehouse"] != "texera" || len(rs) != 3 {
		t.Fatalf("the engine is told the warehouse, the namespace and the tables: %v", starts[0]["resultStore"])
	}
	// A read names the place too, for a unit that no longer holds the execution.
	var page api.RowPage
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/executions/"+rid(exec)+"/operators/scan/ports/output-0/rows", nil, &page)
	if h.unit.lastResultPlace() != "texera/"+namespace {
		t.Fatalf("the rows request names the warehouse and the namespace: %q", h.unit.lastResultPlace())
	}

	// Deleting the execution drops its namespace.
	caller := callerOf(t, h, "alice")
	k, _ := kinds.ByName("execution")
	if err := h.svc.Delete(context.Background(), caller, &k, uuid.MustParse(rid(exec))); err != nil {
		t.Fatalf("delete execution: %v", err)
	}
	if h.lake.OpenedFor("texera", namespace) != "" || len(h.lake.Dropped) != 1 || h.lake.Dropped[0] != "texera/"+namespace {
		t.Fatalf("the namespace is dropped with the execution: %v", h.lake.Dropped)
	}
}

// A unit the catalog provisions gets an identity of its own at creation: a client in the
// identity provider, its secret in the secret store, its subject in the status. Deleting the
// unit deletes both.
func TestProvisionedUnitGetsAnIdentity(t *testing.T) {
	h := newHarness(t)
	unit := h.create("alice", "computing-units", "alice's cluster unit", map[string]any{"provider": "kubernetes", "computingNodes": []any{map[string]any{"name": "master", "role": "master", "memory": "2Gi"}}})
	var status api.ComputingUnitStatus
	mustDecode(t, unit.Status, &status)
	clientID := "unit-" + rid(unit)
	if status.Identity == nil || status.Identity.ClientId != clientID || status.Identity.Subject != "sa:"+clientID {
		t.Fatalf("the unit's identity: %+v", status.Identity)
	}
	if !h.workloads.Has(clientID) {
		t.Fatal("the client exists in the identity provider")
	}
	fields, err := h.secrets.Get(context.Background(), "units/"+rid(unit))
	if err != nil || fields["secret"] != "secret-"+clientID {
		t.Fatalf("the secret store holds the credential: %v %v", fields, err)
	}
	// The identity survives a status probe.
	var again envelope
	h.mustJSON("alice", "GET", p+"/computing-units/"+rid(unit), nil, &again)
	mustDecode(t, again.Status, &status)
	if status.Identity == nil || status.Identity.ClientId != clientID {
		t.Fatalf("the identity after a probe: %+v", status.Identity)
	}
	if code, body := h.do("alice", "DELETE", p+"/computing-units/"+rid(unit), nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", code, body)
	}
	if h.workloads.Has(clientID) {
		t.Fatal("the client is deleted with the unit")
	}
	if _, err := h.secrets.Get(context.Background(), "units/"+rid(unit)); err == nil {
		t.Fatal("the credential is deleted with the unit")
	}

	// A static unit naming an unknown client is refused; without a client it has no identity.
	if code, body := h.do("alice", "POST", p+"/computing-units", map[string]any{"name": "ghost", "spec": map[string]any{"provider": "static", "endpoint": h.unit.URL, "clientId": "nobody"}}); code != http.StatusBadRequest {
		t.Fatalf("an unknown client: %d %s", code, body)
	}
	plain := h.create("alice", "computing-units", "plain", map[string]any{"provider": "static", "endpoint": h.unit.URL})
	var plainStatus api.ComputingUnitStatus
	mustDecode(t, plain.Status, &plainStatus)
	if plainStatus.Identity != nil {
		t.Fatalf("a static unit without a client has no identity: %+v", plainStatus.Identity)
	}
}

func callerOf(t *testing.T, h *harness, user string) *auth.Caller {
	t.Helper()
	principal, _, err := h.svc.Store.EnsureUser(context.Background(), "sub:"+user, user, user+"@example.org", false)
	if err != nil {
		t.Fatal(err)
	}
	return &auth.Caller{Principal: principal}
}
