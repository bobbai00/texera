package server_test

import (
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/server"
)

const p = server.Prefix

func TestMeAndSeed(t *testing.T) {
	h := newHarness(t)
	var me api.Me
	h.mustJSON("alice", "GET", p+"/me", nil, &me)
	if me.HomeProject == "" || me.SystemProject == "" || me.Admin {
		t.Fatalf("me: %+v", me)
	}
	var settings api.PublicSettings
	h.mustJSON("", "GET", p+"/settings/public", nil, &settings)
	if settings.Branding.Name != "Texera Test" || settings.Auth.ClientId != "texera-app" {
		t.Fatalf("public settings: %+v", settings)
	}
	status, _ := h.do("", "GET", p+"/me", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("no token: %d", status)
	}
	var full envelope
	h.mustJSON("alice", "GET", p+"/settings", nil, &full)
	if full.Kind != "settings" || full.Spec["defaults"] == nil {
		t.Fatalf("settings: %+v", full)
	}
	status, _ = h.do("alice", "PUT", p+"/settings", map[string]any{"spec": full.Spec})
	if status != http.StatusForbidden {
		t.Fatalf("alice may not write settings: %d", status)
	}
	h.mustJSON("admin", "PUT", p+"/settings", map[string]any{"spec": full.Spec}, nil)
}

func TestWorkflowLifecycleAndSharing(t *testing.T) {
	h := newHarness(t)
	spec := map[string]any{"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{}}}, "links": []any{}}
	wf := h.create("alice", "workflows", "iris", spec)
	if wf.Metadata.Head != 1 || wf.Kind != "workflow" || !strings.HasPrefix(string(wf.Metadata.Uri), "texera://workflows/") {
		t.Fatalf("created: %+v", wf.Metadata)
	}
	// A spec write is a version; the stale head is refused.
	spec2 := map[string]any{"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"limit": 5}}}, "links": []any{}}
	var updated envelope
	h.mustJSON("alice", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": spec2, "expectedHead": 1, "message": "limit"}, &updated)
	if updated.Metadata.Head != 2 || updated.Metadata.Etag == wf.Metadata.Etag {
		t.Fatalf("updated: %+v", updated.Metadata)
	}
	if status, _ := h.do("alice", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": spec2, "expectedHead": 1}); status != http.StatusConflict {
		t.Fatalf("stale head: %d", status)
	}
	if status, _ := h.do("alice", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": spec2}, "If-Match", "stale"); status != http.StatusPreconditionFailed {
		t.Fatalf("stale etag: %d", status)
	}
	// An invalid spec is refused with the schema's name.
	if status, data := h.do("alice", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": map[string]any{"operators": "no"}}); status != http.StatusBadRequest || !strings.Contains(string(data), "WorkflowSpec") {
		t.Fatalf("invalid spec: %d %s", status, data)
	}
	// Edit by patch makes version 3.
	var v3 api.Version
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/edit", map[string]any{"patch": []any{map[string]any{"op": "replace", "path": "/operators/0/operatorProperties/limit", "value": 10}}, "message": "ten"}, &v3)
	if v3.Vno != 3 || !strings.HasSuffix(string(v3.Uri), "@3") {
		t.Fatalf("edit: %+v", v3)
	}
	var versions api.VersionSummaryPage
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/versions", nil, &versions)
	if len(versions.Items) != 3 || versions.Items[0].Vno != 3 {
		t.Fatalf("versions: %+v", versions.Items)
	}
	var v1 api.Version
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/versions/1", nil, &v1)
	if v1.Vno != 1 || v1.Digest == "" {
		t.Fatalf("v1: %+v", v1)
	}
	var resolved api.Resolved
	h.mustJSON("alice", "GET", p+"/resources/resolve?uri="+string(v3.Uri), nil, &resolved)
	if resolved.Version == nil || resolved.Version.Vno != 3 || resolved.Resource.Metadata.Rid != wf.Metadata.Rid {
		t.Fatalf("resolve: %+v", resolved)
	}

	// Bob sees nothing until shared; a viewer reads and cannot write; revoking takes it back.
	if status, _ := h.do("bob", "GET", p+"/workflows/"+rid(wf), nil); status != http.StatusForbidden {
		t.Fatalf("bob before sharing: %d", status)
	}
	var page api.ResourcePage
	h.mustJSON("bob", "GET", p+"/workflows", nil, &page)
	if len(page.Items) != 0 {
		t.Fatalf("bob lists %d workflows", len(page.Items))
	}
	var bobMe api.Me
	h.mustJSON("bob", "GET", p+"/me", nil, &bobMe)
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(wf)+"/grants/"+string(bobMe.Principal.Pid), map[string]any{"relation": "viewer"}, nil)
	if status, _ := h.do("bob", "GET", p+"/workflows/"+rid(wf), nil); status != http.StatusOK {
		t.Fatalf("bob as viewer: %d", status)
	}
	h.mustJSON("bob", "GET", p+"/workflows", nil, &page)
	if len(page.Items) != 1 {
		t.Fatalf("bob lists %d workflows after the grant", len(page.Items))
	}
	if status, _ := h.do("bob", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": spec2}); status != http.StatusForbidden {
		t.Fatalf("bob as viewer writes: %d", status)
	}
	var grants []api.Grant
	h.mustJSON("alice", "GET", p+"/resources/"+rid(wf)+"/grants", nil, &grants)
	if len(grants) != 2 {
		t.Fatalf("grants: %+v", grants)
	}
	if status, _ := h.do("bob", "GET", p+"/resources/"+rid(wf)+"/grants", nil); status != http.StatusForbidden {
		t.Fatalf("a viewer may not list grants: %d", status)
	}
	if status, _ := h.do("alice", "DELETE", p+"/resources/"+rid(wf)+"/grants/"+string(bobMe.Principal.Pid), nil); status != http.StatusNoContent {
		t.Fatalf("revoke: %d", status)
	}
	if status, _ := h.do("bob", "GET", p+"/workflows/"+rid(wf), nil); status != http.StatusForbidden {
		t.Fatalf("bob after revoke: %d", status)
	}
	// Public: everyone reads.
	var public envelope
	h.mustJSON("alice", "PATCH", p+"/resources/"+rid(wf), map[string]any{"visibility": "public", "description": "the iris workflow"}, &public)
	if public.Metadata.Visibility != "public" || public.Metadata.Description == nil {
		t.Fatalf("patched: %+v", public.Metadata)
	}
	if status, _ := h.do("bob", "GET", p+"/workflows/"+rid(wf), nil); status != http.StatusOK {
		t.Fatalf("bob reads public: %d", status)
	}
	// A project grant reaches what is inside it.
	var me api.Me
	h.mustJSON("alice", "GET", p+"/me", nil, &me)
	ds := h.create("alice", "datasets", "private data", map[string]any{"format": "csv"})
	if status, _ := h.do("bob", "GET", p+"/datasets/"+rid(ds), nil); status != http.StatusForbidden {
		t.Fatalf("bob before the project grant: %d", status)
	}
	h.mustJSON("alice", "PUT", p+"/resources/"+string(me.HomeProject)+"/grants/"+string(bobMe.Principal.Pid), map[string]any{"relation": "viewer"}, nil)
	if status, _ := h.do("bob", "GET", p+"/datasets/"+rid(ds), nil); status != http.StatusOK {
		t.Fatalf("bob through the project: %d", status)
	}
	// Search across kinds.
	h.mustJSON("bob", "GET", p+"/resources?q=iris", nil, &page)
	if len(page.Items) != 1 || page.Items[0].Kind != "workflow" {
		t.Fatalf("search: %+v", page.Items)
	}
}

func TestDatasetFilesReferencesAndDelete(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	if ds.Metadata.Head != 0 {
		t.Fatalf("a dataset starts without versions: %+v", ds.Metadata)
	}
	csv := "Species,PetalLengthCm\nsetosa,1.4\nversicolor,4.7\n"
	var file api.DatasetFile
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", csv, &file)
	if file.Size != int64(len(csv)) || !strings.HasPrefix(string(file.Sha256), "sha256:") {
		t.Fatalf("upload: %+v", file)
	}
	var staged api.Manifest
	h.mustJSON("alice", "GET", p+"/datasets/"+rid(ds)+"/staged", nil, &staged)
	if len(staged.Files) != 1 {
		t.Fatalf("staged: %+v", staged)
	}
	if status, _ := h.do("alice", "GET", p+"/datasets/"+rid(ds)+"/versions/1/files", nil); status != http.StatusNotFound {
		t.Fatalf("no version yet: %d", status)
	}
	var v1 api.Version
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{"message": "first"}, &v1)
	if v1.Vno != 1 || v1.ContentKind != "manifest" {
		t.Fatalf("commit: %+v", v1)
	}
	var files api.Manifest
	h.mustJSON("alice", "GET", p+"/datasets/"+rid(ds)+"/versions/1/files", nil, &files)
	if len(files.Files) != 1 || files.Files[0].Path != "iris.csv" {
		t.Fatalf("files: %+v", files)
	}
	status, data := h.do("alice", "GET", p+"/datasets/"+rid(ds)+"/versions/1/files/iris.csv?maxBytes=10", nil)
	if status != http.StatusPartialContent || string(data) != csv[:10] {
		t.Fatalf("download: %d %q", status, data)
	}
	status, data = h.do("alice", "GET", p+"/datasets/"+rid(ds)+"/versions/1/files/iris.csv", nil)
	if status != http.StatusOK || string(data) != csv {
		t.Fatalf("download all: %d %q", status, data)
	}
	var link api.FileLink
	h.mustJSON("alice", "GET", p+"/datasets/"+rid(ds)+"/versions/1/links/iris.csv", nil, &link)
	if link.Url == "" {
		t.Fatal("no link")
	}
	var after envelope
	h.mustJSON("alice", "GET", p+"/datasets/"+rid(ds), nil, &after)
	if after.Metadata.Head != 1 || field(after, "files") != float64(1) || field(after, "staged") != float64(0) {
		t.Fatalf("dataset after commit: %+v %v", after.Metadata, after.Status)
	}
	// A second file joins the first in version 2.
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/notes%2Freadme.txt", "hello", nil)
	var v2 api.Version
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, &v2)
	h.mustJSON("alice", "GET", p+"/datasets/"+rid(ds)+"/versions/2/files", nil, &files)
	if len(files.Files) != 2 {
		t.Fatalf("v2 files: %+v", files)
	}

	// A workflow that reads the file references the dataset; the dataset cannot be deleted
	// while it does; a reference to a missing version is refused.
	fileURI := string(ds.Metadata.Uri) + "@1/files/iris.csv"
	spec := map[string]any{"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": fileURI}}}, "links": []any{}}
	wf := h.create("alice", "workflows", "analysis", spec)
	var deps []api.Edge
	h.mustJSON("alice", "GET", p+"/resources/"+rid(ds)+"/dependents", nil, &deps)
	if len(deps) != 1 || deps[0].Relation != "references" || deps[0].Field == nil {
		t.Fatalf("dependents: %+v", deps)
	}
	if status, data := h.do("alice", "DELETE", p+"/datasets/"+rid(ds), nil); status != http.StatusConflict || !strings.Contains(string(data), "referenced") {
		t.Fatalf("delete referenced: %d %s", status, data)
	}
	bad := map[string]any{"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@9/files/iris.csv"}}}, "links": []any{}}
	if status, data := h.do("alice", "PUT", p+"/workflows/"+rid(wf), map[string]any{"spec": bad}); status != http.StatusBadRequest || !strings.Contains(string(data), "version 9") {
		t.Fatalf("missing version: %d %s", status, data)
	}
	if status, _ := h.do("alice", "DELETE", p+"/workflows/"+rid(wf), nil); status != http.StatusNoContent {
		t.Fatalf("delete workflow: %d", status)
	}
	if status, _ := h.do("alice", "DELETE", p+"/datasets/"+rid(ds), nil); status != http.StatusNoContent {
		t.Fatalf("delete dataset: %d", status)
	}
	if status, _ := h.do("alice", "GET", p+"/datasets/"+rid(ds), nil); status != http.StatusNotFound {
		t.Fatalf("deleted: %d", status)
	}
}

func TestExecutionResultsAndLineage(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	fileURI := string(ds.Metadata.Uri) + "@1/files/iris.csv"
	spec := map[string]any{
		"operators": []any{
			map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": fileURI}},
			map[string]any{"operatorID": "agg", "operatorType": "Aggregate", "viewResult": true, "operatorProperties": map[string]any{"groupByKeys": []any{"Species"}}},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "agg", "portID": "input-0"}}},
	}
	wf := h.create("alice", "workflows", "analysis", spec)

	// Validation compiles on the seeded unit.
	var compiled api.WorkflowValidation
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/validate", map[string]any{}, &compiled)
	if !compiled.Ok {
		t.Fatalf("compile: %+v", compiled)
	}

	var exec envelope
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "first execution"}, &exec)
	if exec.Kind != "execution" || exec.Metadata.Parent == nil || string(*exec.Metadata.Parent) != rid(wf) {
		t.Fatalf("execution: %+v", exec.Metadata)
	}
	if !strings.HasPrefix(string(exec.Metadata.Uri), string(wf.Metadata.Uri)+"/executions/") {
		t.Fatalf("execution uri: %s", exec.Metadata.Uri)
	}
	execPath := p + "/workflows/" + rid(wf) + "/executions/" + rid(exec)
	// The unit receives the start request with the file resolved to a URL.
	deadline := time.Now().Add(10 * time.Second)
	for len(h.unit.starts()) == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	starts := h.unit.starts()
	if len(starts) != 1 || starts[0]["eid"] != rid(exec) {
		t.Fatalf("unit starts: %+v", starts)
	}
	plan := starts[0]["logicalPlan"].(map[string]any)
	scan := plan["operators"].([]any)[0].(map[string]any)
	if !strings.HasPrefix(scan["fileName"].(string), "memory://blobs/sha256:") {
		t.Fatalf("file not resolved: %v", scan["fileName"])
	}
	var running envelope
	for time.Now().Before(deadline) {
		h.mustJSON("alice", "GET", execPath, nil, &running)
		if field(running, "phase") == "running" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if field(running, "phase") != "running" {
		t.Fatalf("phase: %v", running.Status)
	}
	// Lineage: the used arrow was recorded at start.
	var up api.LineageGraph
	h.mustJSON("alice", "GET", p+"/resources/"+rid(exec)+"/lineage?direction=upstream", nil, &up)
	if !hasEdge(up.Edges, "used", "", fileURI) {
		t.Fatalf("used edge: %+v", up.Edges)
	}
	// The unit reports: an operator event with the port result, then the execution's completion.
	event := func(job string, eventType string, runFacets, outputFacets map[string]any, outputs []string) {
		t.Helper()
		ev := map[string]any{"eventType": eventType, "eventTime": time.Now().UTC().Format(time.RFC3339), "producer": "test", "schemaURL": "https://openlineage.io/spec/1-0-5/OpenLineage.json",
			"run": map[string]any{"runId": rid(exec), "facets": runFacets}, "job": map[string]any{"namespace": "texera", "name": job}}
		var outs []any
		for _, o := range outputs {
			outs = append(outs, map[string]any{"namespace": "texera", "name": o, "facets": outputFacets})
		}
		if outs != nil {
			ev["outputs"] = outs
		}
		if status, data := h.do("unit", "POST", "/lineage/v1/events", ev); status != http.StatusNoContent {
			t.Fatalf("event: %d %s", status, data)
		}
	}
	// Only the unit that runs the execution reports on it: not a person, not the platform's own
	// client, not another unit.
	start := map[string]any{"eventType": "START", "eventTime": time.Now().UTC().Format(time.RFC3339), "producer": "x", "schemaURL": "x", "run": map[string]any{"runId": rid(exec)}, "job": map[string]any{"namespace": "t", "name": rid(exec)}}
	for _, who := range []string{"alice", "admin", "service", "unit:unit-" + uuid.NewString()} {
		if status, _ := h.do(who, "POST", "/lineage/v1/events", start); status != http.StatusForbidden {
			t.Fatalf("%s may not report on the execution: %d", who, status)
		}
	}
	// The ports and their tables are known from the start; a report of another table is refused.
	namespace := "e_" + strings.ReplaceAll(rid(exec), "-", "")
	var started envelope
	h.mustJSON("alice", "GET", execPath, nil, &started)
	var startedStatus api.ExecutionStatus
	mustDecode(t, started.Status, &startedStatus)
	// scan feeds agg and has no table of its own; agg's is known from the start.
	if startedStatus.Ports == nil || len(*startedStatus.Ports) != 1 {
		t.Fatalf("the ports are known from the start: %+v", startedStatus.Ports)
	}
	for _, port := range *startedStatus.Ports {
		if port.OperatorID == "agg" && (port.Table == nil || *port.Table != namespace+".agg_output_0") {
			t.Fatalf("the catalog named the table: %+v", port)
		}
	}
	foreign := map[string]any{"eventType": "COMPLETE", "eventTime": time.Now().UTC().Format(time.RFC3339), "producer": "test", "schemaURL": "x",
		"run": map[string]any{"runId": rid(exec), "facets": map[string]any{"texera_operator": map[string]any{"opid": "agg", "state": "Completed"}}}, "job": map[string]any{"namespace": "texera", "name": rid(exec) + "/agg"},
		"outputs": []any{map[string]any{"namespace": "texera", "name": rid(exec) + "/agg/output-0", "facets": map[string]any{"texera_port": map[string]any{"table": "e_other.agg_output_0"}}}}}
	if status, body := h.do("unit", "POST", "/lineage/v1/events", foreign); status != http.StatusBadRequest {
		t.Fatalf("a table outside the plan is refused: %d %s", status, body)
	}
	event(rid(exec)+"/agg", "COMPLETE", map[string]any{"texera_operator": map[string]any{"opid": "agg", "state": "Completed", "rowsIn": 2, "rowsOut": 3}},
		map[string]any{"texera_port": map[string]any{"table": namespace + ".agg_output_0", "snapshot": "5566", "tupleCount": 3, "bytes": 120, "hash": "ab12"}}, []string{rid(exec) + "/agg/output-0"})
	event(rid(exec), "COMPLETE", map[string]any{"texera_execution": map[string]any{"status": "completed"}}, nil, nil)
	var done envelope
	h.mustJSON("alice", "GET", execPath, nil, &done)
	if field(done, "phase") != "completed" {
		t.Fatalf("phase: %v", done.Status)
	}
	var port api.ExecutionPort
	h.mustJSON("alice", "GET", execPath+"/operators/agg/ports/output-0", nil, &port)
	if port.Result == nil || port.Result.Rows == nil || *port.Result.Rows != 3 || port.Result.Table == nil {
		t.Fatalf("port: %+v", port)
	}
	h.mustJSON("alice", "GET", execPath+"/operators/agg/ports/input-0", nil, &port)
	if port.BoundTo == nil || !strings.HasSuffix(string(*port.BoundTo), "/operators/scan/ports/output-0") {
		t.Fatalf("input binding: %+v", port)
	}
	var rows api.RowPage
	h.mustJSON("alice", "GET", execPath+"/operators/agg/ports/output-0/rows?limit=2", nil, &rows)
	if len(rows.Rows) != 3 || len(rows.Schema) != 2 {
		t.Fatalf("rows: %+v", rows)
	}
	// The execution's own lineage: it produced its table and used the file; the file leads to the execution.
	var down api.LineageGraph
	h.mustJSON("alice", "GET", p+"/resources/"+rid(exec)+"/lineage?direction=downstream", nil, &down)
	if !hasEdge(down.Edges, "produced", "", "iceberg://"+namespace+".agg_output_0@5566") {
		t.Fatalf("downstream of the execution: %+v", names(down.Edges))
	}
	h.mustJSON("alice", "GET", p+"/resources/"+rid(ds)+"/lineage?direction=downstream", nil, &down)
	if !hasEdge(down.Edges, "used", "", fileURI) {
		t.Fatalf("downstream of iris: %+v", names(down.Edges))
	}
	// Executions list across workflows, and the flat filter by phase.
	var page api.ResourcePage
	h.mustJSON("alice", "GET", p+"/executions?phase=completed", nil, &page)
	if len(page.Items) != 1 {
		t.Fatalf("executions: %d", len(page.Items))
	}
	h.mustJSON("alice", "GET", p+"/workflows/"+rid(wf)+"/executions", nil, &page)
	if len(page.Items) != 1 {
		t.Fatalf("workflow executions: %d", len(page.Items))
	}
	// Built-in operators were synced from the unit into the system project.
	if err := h.svc.SyncOperators(t.Context(), unitOf(h)); err != nil {
		t.Fatal(err)
	}
	var withSchema api.ResourcePage
	h.mustJSON("alice", "GET", p+"/operators?q=csv", nil, &withSchema)
	if len(withSchema.Items) != 1 || withSchema.Items[0].Spec["propertiesSchema"] == nil {
		t.Fatalf("operators with q: %+v", withSchema.Items)
	}
	var compact api.ResourcePage
	h.mustJSON("alice", "GET", p+"/operators", nil, &compact)
	if len(compact.Items) != 2 || compact.Items[0].Spec["propertiesSchema"] != nil {
		t.Fatalf("compact operators: %+v", compact.Items)
	}
}

func TestConversationsCredentialsAndUnits(t *testing.T) {
	h := newHarness(t)
	conv := h.create("alice", "conversations", "chat", map[string]any{})
	var turn api.Turn
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/turns", map[string]any{}, &turn)
	if turn.Turn == "" || !strings.HasPrefix(string(turn.Template), "texera://agent-templates/") || !strings.HasSuffix(string(turn.Template), "@1") {
		t.Fatalf("turn: %+v", turn)
	}
	if status, _ := h.do("alice", "POST", p+"/conversations/"+rid(conv)+"/turns", map[string]any{}); status != http.StatusConflict {
		t.Fatalf("second turn: %d", status)
	}
	var m1 api.Message
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/messages", map[string]any{"turn": turn.Turn, "role": "user", "parts": []any{map[string]any{"type": "text", "text": "hi"}}}, &m1)
	var m2 api.Message
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/messages", map[string]any{"turn": turn.Turn, "role": "assistant", "template": turn.Template, "parts": []any{}}, &m2)
	h.mustJSON("alice", "PUT", p+"/conversations/"+rid(conv)+"/messages/2", map[string]any{"parts": []any{map[string]any{"type": "text", "text": "hello"}}}, nil)
	var msgs api.MessagePage
	h.mustJSON("alice", "GET", p+"/conversations/"+rid(conv)+"/messages", nil, &msgs)
	if len(msgs.Items) != 2 || msgs.Items[1].Parts[0].Text == nil || *msgs.Items[1].Parts[0].Text != "hello" || msgs.Items[1].Template == nil {
		t.Fatalf("messages: %+v", msgs.Items)
	}
	if status, _ := h.do("alice", "DELETE", p+"/conversations/"+rid(conv)+"/turns/"+turn.Turn, nil); status != http.StatusNoContent {
		t.Fatalf("end turn: %d", status)
	}
	var after envelope
	h.mustJSON("alice", "GET", p+"/conversations/"+rid(conv), nil, &after)
	if field(after, "activeTurn") != nil || field(after, "messages") != float64(2) {
		t.Fatalf("conversation status: %v", after.Status)
	}
	// A resource made in the turn carries the origin, when the runtime vouches for it.
	origin := "conversation=" + rid(conv) + ";turn=" + turn.Turn + ";template=" + string(turn.Template)
	var wf envelope
	h.mustJSON("alice", "POST", p+"/workflows", map[string]any{"name": "from chat", "spec": map[string]any{"operators": []any{}, "links": []any{}}}, &wf, "X-Texera-Origin", origin, "X-Texera-Service-Token", "service")
	if wf.Metadata.Origin == nil || string(wf.Metadata.Origin.Conversation) != rid(conv) {
		t.Fatalf("origin: %+v", wf.Metadata)
	}
	if status, _ := h.do("alice", "POST", p+"/workflows", map[string]any{"name": "forged", "spec": map[string]any{}}, "X-Texera-Origin", origin); status != http.StatusUnauthorized {
		t.Fatalf("origin without a service token: %d", status)
	}
	var produced []api.ChatResource
	h.mustJSON("alice", "GET", p+"/conversations/"+rid(conv)+"/resources", nil, &produced)
	if len(produced) != 1 || produced[0].Resource.Metadata.Rid != wf.Metadata.Rid || !produced[0].Made {
		t.Fatalf("conversation resources: %+v", produced)
	}

	// Credentials: no value until set; a lease hands the value to a purpose; a stranger may not.
	cred := h.create("alice", "credentials", "pg", map[string]any{"kind": "basic", "scope": "the lab's database"})
	purpose := map[string]any{"purpose": string(wf.Metadata.Uri)}
	if status, data := h.do("alice", "POST", p+"/credentials/"+rid(cred)+"/lease", purpose); status != http.StatusConflict || !strings.Contains(string(data), "no_secret") {
		t.Fatalf("lease without secret: %d %s", status, data)
	}
	if status, _ := h.do("alice", "PUT", p+"/credentials/"+rid(cred)+"/secret", map[string]any{"fields": map[string]any{"username": "lab", "password": "hunter2"}}); status != http.StatusNoContent {
		t.Fatalf("set secret: %d", status)
	}
	var lease api.Lease
	h.mustJSON("alice", "POST", p+"/credentials/"+rid(cred)+"/lease", purpose, &lease)
	if lease.Fields["password"] != "hunter2" || lease.Lease == "" {
		t.Fatalf("lease: %+v", lease)
	}
	if status, _ := h.do("bob", "POST", p+"/credentials/"+rid(cred)+"/lease", purpose); status != http.StatusForbidden {
		t.Fatalf("bob leases: %d", status)
	}
	var credView envelope
	h.mustJSON("alice", "GET", p+"/credentials/"+rid(cred), nil, &credView)
	if field(credView, "hasSecret") != true {
		t.Fatalf("credential status: %v", credView.Status)
	}
	if _, err := h.secrets.Get(t.Context(), "credentials/"+rid(cred)); err != nil {
		t.Fatalf("the value lives in the secret store: %v", err)
	}
	// The seeded platform credential points at the deployment's path and is readable by all.
	var creds api.ResourcePage
	h.mustJSON("bob", "GET", p+"/credentials?q=anthropic", nil, &creds)
	if len(creds.Items) != 1 || field(creds.Items[0], "secretPath") != "platform/anthropic" {
		t.Fatalf("platform credential: %+v", creds.Items)
	}

	// Units: the seeded unit is available and ready, with one node.
	var units []envelope
	h.mustJSON("bob", "GET", p+"/computing-units/available", nil, &units)
	if len(units) != 1 || field(units[0], "phase") != "ready" {
		t.Fatalf("available: %+v", units)
	}
	var nodes []api.ComputingNodeStatus
	h.mustJSON("bob", "GET", p+"/computing-units/"+rid(units[0])+"/computing-nodes", nil, &nodes)
	if len(nodes) != 1 || !nodes[0].Ready {
		t.Fatalf("nodes: %+v", nodes)
	}
	if status, _ := h.do("bob", "GET", p+"/computing-units/"+rid(units[0])+"/computing-nodes/master", nil); status != http.StatusOK {
		t.Fatalf("node: %d", status)
	}
	// AuthZEN: bob can read the public unit, not write it.
	var decision api.AuthzResponse
	h.mustJSON("bob", "POST", "/access/v1/evaluation", map[string]any{"subject": map[string]any{"type": "user", "id": ""}, "action": map[string]any{"name": "read"}, "resource": map[string]any{"type": "resource", "id": rid(units[0])}}, &decision)
	if !decision.Decision {
		t.Fatal("bob should read the public unit")
	}
	h.mustJSON("bob", "POST", "/access/v1/evaluation", map[string]any{"subject": map[string]any{"type": "user", "id": ""}, "action": map[string]any{"name": "write"}, "resource": map[string]any{"type": "resource", "id": rid(units[0])}}, &decision)
	if decision.Decision {
		t.Fatal("bob should not write the unit")
	}
}

func unitOf(h *harness) *storeResource {
	var units []envelope
	h.mustJSON("admin", "GET", p+"/computing-units/available", nil, &units)
	r, err := h.svc.Store.GetResource(h.t.Context(), mustUUID(rid(units[0])))
	if err != nil {
		h.t.Fatal(err)
	}
	return r
}

func hasEdge(edges []api.Edge, relation, from, to string) bool {
	for _, e := range edges {
		if string(e.Relation) == relation && (from == "" || string(e.From) == from) && (to == "" || string(e.To) == to) {
			return true
		}
	}
	return false
}

func names(edges []api.Edge) []string {
	var out []string
	for _, e := range edges {
		out = append(out, string(e.Relation)+": "+string(e.From)+" -> "+string(e.To))
	}
	return out
}

var _ = json.Marshal

// A list gives as much as was asked for, up to the most a page holds: asking for more than
// that is asking for a full page, not for the default.
func TestAListAskedForMoreThanAPageHoldsGivesAFullPage(t *testing.T) {
	h := newHarness(t)
	for i := 0; i < 60; i++ {
		h.create("alice", "skills", fmt.Sprintf("skill-%02d", i), map[string]any{"name": fmt.Sprintf("skill-%02d", i), "description": "d", "body": "b"})
	}
	count := func(query string) (int, bool) {
		var page api.ResourcePage
		h.mustJSON("alice", "GET", p+"/skills"+query, nil, &page)
		return len(page.Items), page.NextCursor != nil && *page.NextCursor != ""
	}
	if n, more := count(""); n != 50 || !more {
		t.Fatalf("with no limit: %d items, more=%v", n, more)
	}
	if n, more := count("?limit=10"); n != 10 || !more {
		t.Fatalf("limit=10: %d items, more=%v", n, more)
	}
	// 60 of alice's and the platform's own, all on one page of 200.
	if n, more := count("?limit=5000"); n < 60 || more {
		t.Fatalf("limit=5000: %d items, more=%v", n, more)
	}
	var versions api.SkillVersionPage
	h.mustJSON("alice", "GET", p+"/skills/"+rid(h.create("alice", "skills", "versioned", map[string]any{"name": "versioned", "description": "d", "body": "b"}))+"/versions?limit=5000", nil, &versions)
	if len(versions.Items) != 1 {
		t.Fatalf("versions with limit=5000: %d", len(versions.Items))
	}
}
