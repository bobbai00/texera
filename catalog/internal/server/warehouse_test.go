package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/ports"
	"github.com/apache/texera/catalog/internal/store"
)

// An execution runs on a computing unit and keeps its results in a warehouse. A warehouse is
// a resource like a unit: one is built in, a project can have its own, the one an execution
// uses is chosen the same way, and using one is a permission of its own.

// runs numbers the executions these tests start: an execution's name is its own under its workflow.
var runs int

// oneScan is a workflow of one operator whose result is kept.
func oneScan(h *harness, who string, project *envelope, name string, more map[string]any) envelope {
	h.t.Helper()
	spec := map[string]any{
		"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "viewResult": true, "operatorProperties": map[string]any{"fileName": "iris.csv"}}},
		"links":     []any{},
	}
	for k, v := range more {
		spec[k] = v
	}
	if project == nil {
		return h.create(who, "workflows", name, spec)
	}
	return createIn(h, who, "workflows", name, project.Metadata.Rid, spec)
}

// ran runs a workflow and returns the execution with the warehouse it names and its namespace.
// The execution is cancelled at once: a workflow runs one at a time on a unit, and these tests
// are about where the results go.
func ran(h *harness, who string, wf envelope, body map[string]any) (envelope, string, string) {
	h.t.Helper()
	runs++
	named := map[string]any{"name": fmt.Sprintf("run %d", runs)}
	for k, v := range body {
		named[k] = v
	}
	var exec envelope
	h.mustJSON(who, "POST", p+"/workflows/"+rid(wf)+"/run", named, &exec)
	h.mustJSON(who, "POST", p+"/workflows/"+rid(wf)+"/executions/"+rid(exec)+"/cancel", map[string]any{}, nil)
	var spec api.ExecutionSpec
	mustDecode(h.t, exec.Spec, &spec)
	return exec, string(spec.Warehouse), "e_" + strings.ReplaceAll(rid(exec), "-", "")
}

// lakeName is a warehouse's name in the lake, as its status says.
func lakeName(h *harness, who string, warehouse envelope) string {
	h.t.Helper()
	var fresh envelope
	h.mustJSON(who, "GET", p+"/warehouses/"+rid(warehouse), nil, &fresh)
	var status api.WarehouseStatus
	mustDecode(h.t, fresh.Status, &status)
	if status.Name == nil {
		return ""
	}
	return *status.Name
}

func builtInWarehouse(h *harness) envelope {
	h.t.Helper()
	var page struct{ Items []envelope }
	h.mustJSON("alice", "GET", p+"/warehouses?scope="+h.svc.SystemProject().RID.String(), nil, &page)
	for _, w := range page.Items {
		if w.Metadata.Name == "texera" {
			return w
		}
	}
	h.t.Fatalf("the platform's warehouse is not among %d", len(page.Items))
	return envelope{}
}

func TestThePlatformsWarehouseIsBuiltInAndIsWhereAnExecutionKeepsItsResults(t *testing.T) {
	h := newHarness(t)
	platform := builtInWarehouse(h)
	if string(platform.Metadata.Project) != h.svc.SystemProject().RID.String() {
		t.Fatalf("the platform's warehouse lives in the platform's project: %s", platform.Metadata.Project)
	}
	// It is the lake's warehouse of the same name, on the deployment's own store.
	if lakeName(h, "alice", platform) != "texera" {
		t.Fatalf("its name in the lake: %q", lakeName(h, "alice", platform))
	}
	storage, ok := h.lake.Storage("texera")
	if !ok || storage != (ports.WarehouseStorage{Endpoint: "http://store:9000", Region: "us-east-1", Bucket: "texera", KeyPrefix: "warehouse", AccessKey: "store-key", SecretKey: "store-secret"}) {
		t.Fatalf("the lake's warehouse: %v %+v", ok, storage)
	}
	// It is the platform's default, and nobody's to change.
	var settings envelope
	h.mustJSON("alice", "GET", p+"/settings", nil, &settings)
	var spec api.SettingsSpec
	mustDecode(t, settings.Spec, &spec)
	if spec.Defaults.Warehouse == nil || string(*spec.Defaults.Warehouse) != string(platform.Metadata.Uri) {
		t.Fatalf("the settings' default warehouse: %v", spec.Defaults.Warehouse)
	}
	if status, body := h.do("admin", "DELETE", p+"/warehouses/"+rid(platform), nil); status != http.StatusConflict || !strings.Contains(string(body), "builtin") {
		t.Fatalf("nobody deletes the platform's warehouse: %d %s", status, body)
	}

	// An execution that names none keeps its results there, and says so.
	exec, warehouse, namespace := ran(h, "alice", oneScan(h, "alice", nil, "plain", nil), map[string]any{})
	if warehouse != string(platform.Metadata.Uri) {
		t.Fatalf("the execution's warehouse: %s", warehouse)
	}
	if h.lake.OpenedFor("texera", namespace) != "sa:texera-unit" {
		t.Fatalf("its namespace is opened in the platform's warehouse: %v", h.lake.Opened)
	}
	_ = exec
}

func TestAProjectsOwnWarehouseIsChosenLikeAUnit(t *testing.T) {
	h := newHarness(t)
	platform := builtInWarehouse(h)
	lab := h.create("alice", "projects", "lab", map[string]any{})
	// A warehouse with no store of its own gets a place of its own on the deployment's store.
	own := createIn(h, "alice", "warehouses", "lab results", lab.Metadata.Rid, map[string]any{})
	name := lakeName(h, "alice", own)
	if name != "w_"+strings.ReplaceAll(rid(own), "-", "") {
		t.Fatalf("its name in the lake: %q", name)
	}
	storage, ok := h.lake.Storage(name)
	if !ok || storage.Bucket != "texera" || storage.KeyPrefix != "w/"+rid(own) || storage.Endpoint != "http://store:9000" || storage.AccessKey != "store-key" {
		t.Fatalf("its place: %v %+v", ok, storage)
	}

	// Nothing names it yet: an execution in the lab still goes to the platform's.
	wf := oneScan(h, "alice", &lab, "in the lab", nil)
	if _, warehouse, _ := ran(h, "alice", wf, map[string]any{}); warehouse != string(platform.Metadata.Uri) {
		t.Fatalf("with no default: %s", warehouse)
	}
	// The project's default.
	h.mustJSON("alice", "PUT", p+"/projects/"+rid(lab), map[string]any{"spec": map[string]any{"defaultWarehouse": own.Metadata.Uri}}, nil)
	exec, warehouse, namespace := ran(h, "alice", wf, map[string]any{})
	if warehouse != string(own.Metadata.Uri) || h.lake.OpenedFor(name, namespace) == "" || h.lake.OpenedFor("texera", namespace) != "" {
		t.Fatalf("the project's default: %s, opened %v", warehouse, h.lake.Opened)
	}
	// The engine is told the warehouse by its name in the lake, and so is a read.
	deadline := time.Now().Add(10 * time.Second)
	for len(h.unit.starts()) < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	starts := h.unit.starts()
	if rs, _ := starts[len(starts)-1]["resultStore"].(map[string]any); rs["warehouse"] != name || rs["namespace"] != namespace {
		t.Fatalf("the engine is told the warehouse: %v", starts[len(starts)-1]["resultStore"])
	}
	var page api.RowPage
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/executions/"+rid(exec)+"/operators/scan/ports/output-0/rows", nil, &page)
	if h.unit.lastResultPlace() != name+"/"+namespace {
		t.Fatalf("a read names the execution's warehouse: %q", h.unit.lastResultPlace())
	}
	// The workflow's default wins over the project's, and the request's over both.
	other := createIn(h, "alice", "warehouses", "another", lab.Metadata.Rid, map[string]any{})
	pinned := oneScan(h, "alice", &lab, "pinned", map[string]any{"defaultWarehouse": other.Metadata.Uri})
	if _, warehouse, _ := ran(h, "alice", pinned, map[string]any{}); warehouse != string(other.Metadata.Uri) {
		t.Fatalf("the workflow's default: %s", warehouse)
	}
	if _, warehouse, _ := ran(h, "alice", pinned, map[string]any{"warehouse": platform.Metadata.Uri}); warehouse != string(platform.Metadata.Uri) {
		t.Fatalf("the request's choice: %s", warehouse)
	}
	// What is named must be a warehouse.
	if status, body := h.do("alice", "POST", p+"/workflows/"+rid(pinned)+"/run", map[string]any{"warehouse": lab.Metadata.Uri}); status != http.StatusBadRequest {
		t.Fatalf("a project is not a warehouse: %d %s", status, body)
	}
}

func TestUsingAWarehouseIsNotImpliedByViewing(t *testing.T) {
	h := newHarness(t)
	bob := principalOf(h, "bob")
	lab := h.create("alice", "projects", "lab", map[string]any{})
	own := createIn(h, "alice", "warehouses", "lab results", lab.Metadata.Rid, map[string]any{})
	wf := oneScan(h, "alice", &lab, "in the lab", nil)
	run := p + "/workflows/" + rid(wf) + "/run"
	// A viewer of the lab reads and runs its workflows, and the platform's warehouse is everyone's.
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(lab)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	if _, warehouse, _ := ran(h, "bob", wf, map[string]any{}); warehouse != string(builtInWarehouse(h).Metadata.Uri) {
		t.Fatalf("bob's execution: %s", warehouse)
	}
	// The lab's own warehouse is not his to fill: named in the request, or as the lab's default.
	if status, body := h.do("bob", "POST", run, map[string]any{"warehouse": own.Metadata.Uri}); status != http.StatusForbidden {
		t.Fatalf("a viewer may not use the lab's warehouse: %d %s", status, body)
	}
	h.mustJSON("alice", "PUT", p+"/projects/"+rid(lab), map[string]any{"spec": map[string]any{"defaultWarehouse": own.Metadata.Uri}}, nil)
	if status, body := h.do("bob", "POST", run, map[string]any{}); status != http.StatusForbidden {
		t.Fatalf("nor through the lab's default: %d %s", status, body)
	}
	// Granted the use of it, he may.
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(own)+"/grants/"+bob, map[string]any{"relation": "user"}, nil)
	if _, warehouse, _ := ran(h, "bob", wf, map[string]any{}); warehouse != string(own.Metadata.Uri) {
		t.Fatalf("with the use of it: %s", warehouse)
	}
}

func TestAWarehouseOnAStoreOfItsOwn(t *testing.T) {
	h := newHarness(t)
	bob := principalOf(h, "bob")
	lab := h.create("alice", "projects", "lab", map[string]any{})
	key := createIn(h, "alice", "credentials", "bucket key", lab.Metadata.Rid, map[string]any{"kind": "api_key"})
	h.mustJSON("alice", "PUT", p+"/credentials/"+rid(key)+"/secret", map[string]any{"fields": map[string]string{"accessKeyId": "AKIA1", "secretAccessKey": "s3cret"}}, nil)
	storage := func(endpoint, bucket string, credential any) map[string]any {
		return map[string]any{"storage": map[string]any{"endpoint": endpoint, "region": "us-west-2", "bucket": bucket, "keyPrefix": "/results/", "credential": credential}}
	}
	create := func(who string, spec map[string]any) (int, string) {
		status, body := h.do(who, "POST", p+"/warehouses", map[string]any{"name": "ours", "parent": lab.Metadata.Rid, "spec": spec})
		return status, string(body)
	}

	// The lake and the units connect to the address: one nobody listed is refused.
	if status, body := create("alice", storage("http://minio.lab:9000", "lab", key.Metadata.Uri)); status != http.StatusBadRequest || !strings.Contains(body, "administrator") {
		t.Fatalf("an unlisted store: %d %s", status, body)
	}
	var settings envelope
	h.mustJSON("admin", "GET", p+"/settings", nil, &settings)
	var spec map[string]any
	mustDecode(t, settings.Spec, &spec)
	spec["warehouseEndpoints"] = []string{"http://minio.lab:9000/"}
	h.mustJSON("admin", "PUT", p+"/settings", map[string]any{"spec": spec}, nil)

	// The credential must be one, with the two fields, and the caller's to use.
	if status, body := create("alice", storage("http://minio.lab:9000", "lab", lab.Metadata.Uri)); status != http.StatusBadRequest {
		t.Fatalf("a project is not a credential: %d %s", status, body)
	}
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(lab)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	bobs := h.create("bob", "projects", "bob's", map[string]any{})
	if status, body := h.do("bob", "POST", p+"/warehouses", map[string]any{"name": "sneaky", "parent": bobs.Metadata.Rid, "spec": storage("http://minio.lab:9000", "lab", key.Metadata.Uri)}); status != http.StatusForbidden {
		t.Fatalf("a credential one may only read is not one to use: %d %s", status, body)
	}
	empty := createIn(h, "alice", "credentials", "no fields", lab.Metadata.Rid, map[string]any{"kind": "api_key"})
	if status, body := create("alice", storage("http://minio.lab:9000", "lab", empty.Metadata.Uri)); status != http.StatusBadRequest || !strings.Contains(body, "accessKeyId") {
		t.Fatalf("a credential without the key: %d %s", status, body)
	}
	// The lake tries the storage: what it cannot use is refused with its reason, and nothing is made.
	h.lake.Refuse = func(s ports.WarehouseStorage) string {
		if s.Bucket == "missing" {
			return "the bucket missing does not exist"
		}
		return ""
	}
	if status, body := create("alice", storage("http://minio.lab:9000", "missing", key.Metadata.Uri)); status != http.StatusBadRequest || !strings.Contains(body, "the bucket missing does not exist") {
		t.Fatalf("a storage the lake cannot use: %d %s", status, body)
	}
	if got := list(h, "alice", "/warehouses?project="+rid(lab)); len(got) != 0 {
		t.Fatalf("nothing was made: %v", got)
	}

	// Accepted: the lake has the place and the key; the key is not in the resource.
	own := createIn(h, "alice", "warehouses", "ours", lab.Metadata.Rid, storage("http://minio.lab:9000", "lab", key.Metadata.Uri))
	name := lakeName(h, "alice", own)
	got, _ := h.lake.Storage(name)
	if got != (ports.WarehouseStorage{Endpoint: "http://minio.lab:9000", Region: "us-west-2", Bucket: "lab", KeyPrefix: "results", AccessKey: "AKIA1", SecretKey: "s3cret"}) {
		t.Fatalf("the lake's storage: %+v", got)
	}
	if raw, _ := json.Marshal(own); strings.Contains(string(raw), "s3cret") {
		t.Fatal("the key is in the resource")
	}
	// A rotated key reaches the lake; the place cannot change, and the credential stays while it is used.
	h.mustJSON("alice", "PUT", p+"/credentials/"+rid(key)+"/secret", map[string]any{"fields": map[string]string{"accessKeyId": "AKIA2", "secretAccessKey": "newer"}}, nil)
	if got, _ := h.lake.Storage(name); got.AccessKey != "AKIA2" || got.SecretKey != "newer" {
		t.Fatalf("after the rotation: %+v", got)
	}
	if status, body := h.do("alice", "PUT", p+"/warehouses/"+rid(own), map[string]any{"spec": storage("http://minio.lab:9000", "elsewhere", key.Metadata.Uri)}); status != http.StatusBadRequest || !strings.Contains(string(body), "cannot change") {
		t.Fatalf("moving a warehouse: %d %s", status, body)
	}
	if status, body := h.do("alice", "DELETE", p+"/credentials/"+rid(key), nil); status != http.StatusConflict {
		t.Fatalf("the credential a warehouse uses: %d %s", status, body)
	}
}

func TestAWarehouseGoesOnlyWhenNothingKeepsResultsInIt(t *testing.T) {
	h := newHarness(t)
	lab := h.create("alice", "projects", "lab", map[string]any{})
	own := createIn(h, "alice", "warehouses", "lab results", lab.Metadata.Rid, map[string]any{})
	name := lakeName(h, "alice", own)
	wf := oneScan(h, "alice", &lab, "in the lab", nil)
	_, _, namespace := ran(h, "alice", wf, map[string]any{"warehouse": own.Metadata.Uri})
	del := func() (int, string) {
		status, body := h.do("alice", "DELETE", p+"/warehouses/"+rid(own), nil)
		return status, string(body)
	}

	// An execution keeps its results there: the warehouse stays.
	if status, body := del(); status != http.StatusConflict || !strings.Contains(body, "in_use") {
		t.Fatalf("with results in it: %d %s", status, body)
	}
	// The execution's results expire: its namespace is dropped in its own warehouse.
	var settings envelope
	h.mustJSON("admin", "GET", p+"/settings", nil, &settings)
	var spec map[string]any
	mustDecode(t, settings.Spec, &spec)
	spec["retention"] = map[string]any{"results": "PT0S"}
	h.mustJSON("admin", "PUT", p+"/settings", map[string]any{"spec": spec}, nil)
	time.Sleep(20 * time.Millisecond)
	var sweep api.RetentionSweep
	h.mustJSON("admin", "POST", p+"/settings/retention/sweep", nil, &sweep)
	if sweep.ExecutionsExpired != 1 || h.lake.OpenedFor(name, namespace) != "" {
		t.Fatalf("the expiry: %+v, opened %v", sweep, h.lake.Opened)
	}
	dropped := false
	for _, d := range h.lake.Dropped {
		dropped = dropped || d == name+"/"+namespace
	}
	if !dropped {
		t.Fatalf("the namespace is dropped in its own warehouse: %v", h.lake.Dropped)
	}
	// Named as a project's default it is still referenced; once nothing names it, it goes, and
	// the lake's warehouse with it.
	h.mustJSON("alice", "PUT", p+"/projects/"+rid(lab), map[string]any{"spec": map[string]any{"defaultWarehouse": own.Metadata.Uri}}, nil)
	if status, body := del(); status != http.StatusConflict || !strings.Contains(body, "referenced") {
		t.Fatalf("named by the project: %d %s", status, body)
	}
	h.mustJSON("alice", "PUT", p+"/projects/"+rid(lab), map[string]any{"spec": map[string]any{}}, nil)
	// The lake has the last word: it still holds a namespace, one the catalog knows nothing of.
	if err := h.lake.OpenNamespace(context.Background(), name, "stray", "", ""); err != nil {
		t.Fatal(err)
	}
	if status, body := del(); status != http.StatusConflict || !strings.Contains(body, "not_empty") {
		t.Fatalf("with a namespace left in the lake: %d %s", status, body)
	}
	if err := h.lake.DropNamespace(context.Background(), name, "stray"); err != nil {
		t.Fatal(err)
	}
	if status, body := del(); status != http.StatusNoContent {
		t.Fatalf("with nothing in it: %d %s", status, body)
	}
	if _, ok := h.lake.Storage(name); ok {
		t.Fatal("the lake still has the warehouse")
	}
}

// An execution made before warehouses were resources kept its results in the platform's: every
// start gives such an execution its warehouse, and leaves its age alone.
func TestAnExecutionOfAnEarlierReleaseIsGivenThePlatformsWarehouse(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	platform := builtInWarehouse(h)
	wf := oneScan(h, "alice", nil, "old", nil)
	alice := mustUUID(principalOf(h, "alice"))
	parent, project := mustUUID(rid(wf)), mustUUID(string(wf.Metadata.Project))
	// As an earlier release stored it: no warehouse in its spec.
	old, _, err := h.svc.Store.CreateResource(ctx, store.NewResource{
		Kind: "execution", Name: "ran before", ParentRID: &parent, ProjectRID: &project, OwnerPID: alice, CreatedByPID: alice,
		Spec:   json.RawMessage(`{"workflow": "` + string(wf.Metadata.Uri) + `@1", "computingUnit": "texera://computing-units/00000000-0000-4000-8000-000000000001"}`),
		Status: json.RawMessage(`{"phase": "completed"}`),
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := h.svc.Seed(ctx); err != nil {
		t.Fatal(err)
	}
	after, err := h.svc.Store.GetResource(ctx, old.RID)
	if err != nil {
		t.Fatal(err)
	}
	var filled api.ExecutionSpec
	mustDecode(t, after.Spec, &filled)
	if string(filled.Warehouse) != string(platform.Metadata.Uri) {
		t.Fatalf("the execution's warehouse after the start: %q", filled.Warehouse)
	}
	if !after.UpdatedAt.Equal(old.UpdatedAt) {
		t.Fatalf("its age changed: %v then %v", old.UpdatedAt, after.UpdatedAt)
	}
	// One that names its warehouse keeps it.
	lab := h.create("alice", "projects", "lab", map[string]any{})
	own := createIn(h, "alice", "warehouses", "lab results", lab.Metadata.Rid, map[string]any{})
	_, warehouse, _ := ran(h, "alice", wf, map[string]any{"warehouse": own.Metadata.Uri})
	if err := h.svc.Seed(ctx); err != nil {
		t.Fatal(err)
	}
	if warehouse != string(own.Metadata.Uri) {
		t.Fatalf("an execution's own warehouse: %s", warehouse)
	}
}
