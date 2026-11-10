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

// Results live in the warehouse: when the unit that made them has gone, the unit the project runs
// on reads them, let into the execution's namespace, and nothing fails for want of a client.
func TestAnExecutionsResultsOutliveItsUnit(t *testing.T) {
	h := newHarness(t)
	own := newFakeUnit(t)
	mine := h.create("alice", "computing-units", "alice's unit", map[string]any{"provider": "static", "endpoint": own.URL})
	spec := map[string]any{
		"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "viewResult": true, "operatorProperties": map[string]any{"fileName": datasetFile(t, h)}}},
		"links":     []any{},
	}
	wf := h.create("alice", "workflows", "outlived", spec)
	var exec envelope
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "first", "computingUnit": string(mine.Metadata.Uri)}, &exec)
	deadline := time.Now().Add(10 * time.Second)
	for len(own.starts()) == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	h.mustJSON("alice", "POST", p+"/computing-units/"+rid(mine)+"/terminate", map[string]any{}, nil)
	namespace := "e_" + strings.ReplaceAll(rid(exec), "-", "")

	var page api.RowPage
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/executions/"+rid(exec)+"/operators/scan/ports/output-0/rows", nil, &page)
	if h.unit.lastResultPlace() != "texera/"+namespace {
		t.Fatalf("the project's unit reads the place: %q", h.unit.lastResultPlace())
	}
	if got := h.lake.OpenedFor("texera", namespace); got != "sa:texera-unit" {
		t.Fatalf("the namespace is opened for the reader: %q", got)
	}
	// A unit deleted altogether leaves them readable too.
	if status, body := h.do("alice", "DELETE", p+"/resources/"+rid(mine), nil); status != http.StatusNoContent {
		t.Fatalf("delete the unit: %d %s", status, body)
	}
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/executions/"+rid(exec)+"/operators/scan/ports/output-0/rows", nil, &page)
}

func datasetFile(t *testing.T, h *harness) string {
	t.Helper()
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	return string(ds.Metadata.Uri) + "@1/files/iris.csv"
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
	principal, _, err := h.svc.Store.EnsureUser(context.Background(), "sub:"+user, user, user+"@example.org")
	if err != nil {
		t.Fatal(err)
	}
	return &auth.Caller{Principal: principal}
}

// A file attached to a chat is read like any dataset version, by its URI, and is in no list: the
// chat's until someone keeps it, when it is the project's like any other. It goes with the chat
// unless something still uses it.
func TestAFileAttachedToAChatIsTheChatsUntilKept(t *testing.T) {
	h := newHarness(t)
	attach := func(chat envelope, name string) envelope {
		t.Helper()
		var ds envelope
		h.mustJSON("alice", "POST", p+"/datasets", map[string]any{"name": name, "spec": map[string]any{"format": "csv"}, "labels": map[string]string{"texera.attachment": rid(chat)}}, &ds)
		h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/"+name, "Species,PetalLengthCm\nsetosa,1.4\n", nil)
		h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
		return ds
	}
	listed := func() map[string]bool {
		t.Helper()
		var page struct{ Items []envelope }
		h.mustJSON("alice", "GET", p+"/datasets?limit=100", nil, &page)
		names := map[string]bool{}
		for _, d := range page.Items {
			names[d.Metadata.Name] = true
		}
		return names
	}
	chat := h.create("alice", "conversations", "a chat", map[string]any{})
	file := attach(chat, "cohort.csv")
	if listed()["cohort.csv"] {
		t.Fatal("an attached file is in no list")
	}
	if status, body := h.do("alice", "GET", p+"/datasets/"+rid(file)+"/versions/1/files/cohort.csv", nil); status != http.StatusOK || !strings.Contains(string(body), "setosa") {
		t.Fatalf("it is read by its URI: %d %s", status, body)
	}
	// Someone asks to keep it: a dataset of the project, named as they said.
	name, about := "Screening cohort", "Women screened at the clinic."
	var kept envelope
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(file)+"/keep", map[string]any{"name": name, "description": about}, &kept)
	if kept.Metadata.Name != name || kept.Metadata.Description == nil || *kept.Metadata.Description != about {
		t.Fatalf("kept: %+v", kept.Metadata)
	}
	if !listed()[name] {
		t.Fatal("a kept file is listed")
	}
	if status, body := h.do("alice", "POST", p+"/datasets/"+rid(file)+"/keep", map[string]any{}); status != http.StatusConflict {
		t.Fatalf("keeping what is kept: %d %s", status, body)
	}
	// The chat's other files go with it, the ones a workflow reads stay.
	loose := attach(chat, "loose.csv")
	used := attach(chat, "used.csv")
	h.create("alice", "workflows", "reads it", map[string]any{
		"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": string(used.Metadata.Uri) + "@1/files/used.csv"}}},
		"links":     []any{},
	})
	if status, body := h.do("alice", "DELETE", p+"/resources/"+rid(chat), nil); status != http.StatusNoContent {
		t.Fatalf("delete the chat: %d %s", status, body)
	}
	if status, _ := h.do("alice", "GET", p+"/datasets/"+rid(loose), nil); status != http.StatusNotFound {
		t.Fatalf("a file nothing uses goes with its chat: %d", status)
	}
	if status, _ := h.do("alice", "GET", p+"/datasets/"+rid(used), nil); status != http.StatusOK {
		t.Fatalf("a file a workflow reads stays: %d", status)
	}
	if status, _ := h.do("alice", "GET", p+"/datasets/"+rid(file), nil); status != http.StatusOK {
		t.Fatalf("a kept file stays: %d", status)
	}
}

// The deployment's warehouse is made in the configured place from the start: the lake, which
// lets no warehouse change its key prefix once made, is never asked to.
func TestTheDeploymentsWarehouseIsMadeInItsPlaceFromTheStart(t *testing.T) {
	h := newHarness(t)
	kept, ok := h.lake.Warehouses["texera"]
	if !ok || kept.Bucket != "texera" || kept.KeyPrefix != "warehouse" {
		t.Fatalf("the deployment's warehouse in the lake: %+v (%v)", kept, ok)
	}
}
