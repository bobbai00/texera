package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/apache/texera/catalog/internal/store"
)

func TestAuthenticationIsRequired(t *testing.T) {
	s := newStack(t)
	require.Equal(t, http.StatusUnauthorized, s.do("GET", "/catalog/v1/me", "", nil).status)
	require.Equal(t, http.StatusUnauthorized, s.do("GET", "/catalog/v1/me", "not-a-jwt", nil).status)
	forged := strings.Split(s.issuer.user("alice"), ".")
	forged[2] = "c2lnbmF0dXJl" // a different signature
	require.Equal(t, http.StatusUnauthorized, s.do("GET", "/catalog/v1/me", strings.Join(forged, "."), nil).status)

	pid, home := s.whoami(s.issuer.user("alice"))
	pid2, home2 := s.whoami(s.issuer.user("alice"))
	require.Equal(t, pid, pid2, "a person maps to one principal")
	require.Equal(t, home, home2, "and one home project")
}

func TestSeededModesAndUnits(t *testing.T) {
	s := newStack(t)
	alice := s.issuer.user("alice")
	tpls := s.ok("GET", "/catalog/v1/agent-templates", alice, nil)["items"].([]any)
	var names []string
	for _, x := range tpls {
		names = append(names, x.(map[string]any)["metadata"].(map[string]any)["name"].(string))
	}
	require.ElementsMatch(t, []string{"Data Analyst", "General"}, names)
	units := s.do("GET", "/catalog/v1/computing-units/available", alice, nil)
	require.Equal(t, http.StatusOK, units.status)
	var list []map[string]any
	require.NoError(t, json.Unmarshal(units.body, &list))
	require.Len(t, list, 1)
	require.Equal(t, "ready", list[0]["status"].(map[string]any)["phase"])
	ops := s.ok("GET", "/catalog/v1/operators?q=csv", alice, nil)["operators"].([]any)
	require.Len(t, ops, 1, "the registry comes from the unit, filtered")
}

func TestWorkflowVersionsEditsAndConflicts(t *testing.T) {
	s := newStack(t)
	alice := s.issuer.user("alice")
	wf := s.ok("POST", "/catalog/v1/workflows/with-content", alice, map[string]any{"name": "wf",
		"content": content(op("scan", "CSVFileScan", map[string]any{"fileName": "x.csv"}))})
	rid := wf["workflow"].(map[string]any)["metadata"].(map[string]any)["rid"].(string)
	require.EqualValues(t, 1, wf["version"].(map[string]any)["vno"])

	v2 := s.ok("POST", "/catalog/v1/workflows/"+rid+"/edit", alice, map[string]any{"message": "add avg", "patch": []any{
		map[string]any{"op": "add", "path": "/operators/-", "value": op("avg", "Aggregate", nil)},
		map[string]any{"op": "add", "path": "/links/-", "value": map[string]any{"linkID": "l1",
			"source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "avg", "portID": "input-0"}}},
	}})
	require.EqualValues(t, 2, v2["vno"])
	require.Equal(t, "add avg", v2["message"])
	require.Len(t, v2["content"].(map[string]any)["operators"], 2)

	bad := s.do("POST", "/catalog/v1/workflows/"+rid+"/edit", alice, map[string]any{"patch": []any{
		map[string]any{"op": "add", "path": "/links/-", "value": map[string]any{"linkID": "l2",
			"source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "missing", "portID": "input-0"}}}}})
	require.Equal(t, http.StatusBadRequest, bad.status, "an edit that breaks the graph never becomes a version")

	stale := s.do("POST", "/catalog/v1/workflows/"+rid+"/edit", alice, map[string]any{"expectedHead": 1, "content": content(op("a", "Filter", nil))})
	require.Equal(t, http.StatusConflict, stale.status, "a stale head is refused")

	versions := s.ok("GET", "/catalog/v1/resources/"+rid+"/versions", alice, nil)["items"].([]any)
	require.Len(t, versions, 2)
	head := s.ok("GET", "/catalog/v1/workflows/"+rid+"/content", alice, nil)
	require.EqualValues(t, 2, head["vno"])
	old := s.ok("GET", "/catalog/v1/workflows/"+rid+"/content?vno=1", alice, nil)
	require.Len(t, old["content"].(map[string]any)["operators"], 1, "old versions stay readable")
}

func TestSharingIsDecidedByThePDP(t *testing.T) {
	s := newStack(t)
	alice, bob := s.issuer.user("alice"), s.issuer.user("bob")
	bobPid, _ := s.whoami(bob)
	_, home := s.whoami(alice)
	wf := s.ok("POST", "/catalog/v1/workflows/with-content", alice, map[string]any{"name": "private", "content": content()})
	rid := wf["workflow"].(map[string]any)["metadata"].(map[string]any)["rid"].(string)

	require.Equal(t, http.StatusForbidden, s.do("GET", "/catalog/v1/workflows/"+rid, bob, nil).status)
	eval := s.ok("POST", "/access/v1/evaluation", bob, map[string]any{"subject": map[string]any{"type": "user", "id": bobPid},
		"action": map[string]any{"name": "read"}, "resource": map[string]any{"type": "resource", "id": rid}})
	require.Equal(t, false, eval["decision"])

	// Granting viewer on alice's home project lets bob read everything in it, but not edit.
	s.ok("PUT", "/catalog/v1/resources/"+home+"/grants/"+bobPid, alice, map[string]any{"relation": "viewer"})
	require.Equal(t, http.StatusOK, s.do("GET", "/catalog/v1/workflows/"+rid, bob, nil).status)
	require.Equal(t, http.StatusForbidden, s.do("POST", "/catalog/v1/workflows/"+rid+"/edit", bob, map[string]any{"content": content()}).status)
	require.Equal(t, http.StatusForbidden, s.do("PUT", "/catalog/v1/resources/"+rid+"/grants/"+bobPid, bob, map[string]any{"relation": "owner"}).status,
		"a viewer cannot share")

	// Search only shows what bob may read.
	found := s.ok("GET", "/catalog/v1/resources?kind=workflow", bob, nil)["items"].([]any)
	require.Len(t, found, 1)

	s.ok("DELETE", "/catalog/v1/resources/"+home+"/grants/"+bobPid, alice, nil)
	require.Equal(t, http.StatusForbidden, s.do("GET", "/catalog/v1/workflows/"+rid, bob, nil).status)
}

func TestAgentActionsAreAttributedToTheChat(t *testing.T) {
	s := newStack(t)
	alice := s.issuer.user("alice")
	alicePid, _ := s.whoami(alice)
	tpls := s.ok("GET", "/catalog/v1/agent-templates", alice, nil)["items"].([]any)
	tpl := tpls[0].(map[string]any)["metadata"].(map[string]any)
	tplRef := map[string]any{"rid": tpl["rid"], "vno": tpl["headVersion"]}
	conv := s.ok("POST", "/catalog/v1/conversations", alice, map[string]any{"name": "chat", "spec": map[string]any{"template": tplRef}})
	crid := conv["metadata"].(map[string]any)["rid"].(string)
	agent := s.ok("POST", "/catalog/v1/agents", alice, map[string]any{"template": tplRef, "conversation": crid})
	pid := agent["pid"].(string)

	// The runtime relays the person's message, then acts as the agent.
	agentHeaders := []string{"X-Texera-Agent", pid, "X-Texera-Service-Token", s.issuer.service()}
	userMsg := s.ok("POST", "/catalog/v1/conversations/"+crid+"/messages", alice,
		map[string]any{"role": "user", "parts": []any{map[string]any{"type": "text", "text": "build it"}}}, agentHeaders...)
	require.Equal(t, alicePid, userMsg["author"], "the person's words are the person's")
	seq := int64(userMsg["seq"].(float64))

	turn := append(agentHeaders, "X-Texera-Origin", crid+":"+itoa(seq))
	wf := s.ok("POST", "/catalog/v1/workflows/with-content", alice, map[string]any{"name": "built by the agent", "content": content(),
		"origin": map[string]any{"conversation": "00000000-0000-0000-0000-000000000000", "seq": 99}}, turn...)
	md := wf["workflow"].(map[string]any)["metadata"].(map[string]any)
	require.Equal(t, pid, md["createdBy"])
	require.Equal(t, alicePid, md["onBehalfOf"])
	require.Equal(t, alicePid, md["owner"], "the person owns what their agent makes")
	require.Equal(t, crid, md["origin"].(map[string]any)["conversation"], "the attested turn wins over a model-supplied origin")

	reply := s.ok("POST", "/catalog/v1/conversations/"+crid+"/messages", alice,
		map[string]any{"role": "assistant", "parts": []any{map[string]any{"type": "text", "text": "done"}}}, agentHeaders...)
	require.Equal(t, pid, reply["author"])
	require.Equal(t, alicePid, reply["onBehalfOf"])

	resources := s.do("GET", "/catalog/v1/conversations/"+crid+"/resources", alice, nil)
	var rs []map[string]any
	require.NoError(t, json.Unmarshal(resources.body, &rs))
	require.Len(t, rs, 1)

	// An agent assertion without the platform's service token is refused.
	require.Equal(t, http.StatusUnauthorized, s.do("GET", "/catalog/v1/me", alice, nil, "X-Texera-Agent", pid).status)
	require.Equal(t, http.StatusUnauthorized, s.do("GET", "/catalog/v1/me", alice, nil, "X-Texera-Agent", pid, "X-Texera-Service-Token", alice).status)
}

func TestRunsReportLineageAtPortLevel(t *testing.T) {
	s := newStack(t)
	alice := s.issuer.user("alice")
	alicePid, home := s.whoami(alice)
	ctx := context.Background()
	homeRID := mustUUID(t, home)
	owner := mustUUID(t, alicePid)
	ds, _, err := s.store.CreateResource(ctx, store.NewResource{Kind: "dataset", Name: "iris", ParentRID: &homeRID, OwnerPID: owner, CreatedByPID: owner,
		ContentKind: "manifest", Content: json.RawMessage(`{"files":[{"path":"iris.csv","size":5107}]}`)})
	require.NoError(t, err)

	wf := s.ok("POST", "/catalog/v1/workflows/with-content", alice, map[string]any{"name": "iris", "content": map[string]any{
		"operators": []any{
			op("scan", "CSVFileScan", map[string]any{"fileName": "dataset://" + ds.RID.String() + "@1/iris.csv"}),
			map[string]any{"operatorID": "avg", "operatorType": "Aggregate", "operatorProperties": map[string]any{}, "viewResult": true},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"},
			"target": map[string]any{"operatorID": "avg", "portID": "input-0"}}},
	}})
	rid := wf["workflow"].(map[string]any)["metadata"].(map[string]any)["rid"].(string)

	val := s.ok("POST", "/catalog/v1/workflows/"+rid+"/validate", alice, map[string]any{})
	require.Equal(t, true, val["ok"])

	ex := s.ok("POST", "/catalog/v1/workflows/"+rid+"/executions", alice, map[string]any{"waitSeconds": 10})
	require.Equal(t, "completed", ex["status"])
	require.Equal(t, map[string]any{"rid": rid, "vno": float64(1)}, ex["workflow"])
	require.Equal(t, []any{map[string]any{"rid": ds.RID.String(), "vno": float64(1)}}, ex["inputs"])
	ops := ex["operators"].(map[string]any)
	require.Equal(t, "Completed", ops["scan"].(map[string]any)["state"])
	require.EqualValues(t, 3, ops["avg"].(map[string]any)["tuples"])
	results := ex["results"].([]any)
	require.NotEmpty(t, results)

	// The unit got a self-contained request: the dataset URI rewritten to a presigned URL.
	start := s.unit.lastStart()
	plan := start["logicalPlan"].(map[string]any)["operators"].([]any)
	require.True(t, strings.HasPrefix(plan[0].(map[string]any)["fileName"].(string), "http://s3.test/"), "presigned for the engine")
	require.Equal(t, ex["eid"], start["eid"])

	// Port-level lineage and the resource-level roll-up.
	eid := mustUUID(t, ex["eid"].(string))
	var edges, inputs int
	require.NoError(t, s.store.Pool().QueryRow(ctx, `SELECT count(*) FROM port_edge WHERE eid = $1 AND opid = 'avg' AND from_opid = 'scan'`, eid).Scan(&edges))
	require.NoError(t, s.store.Pool().QueryRow(ctx, `SELECT count(*) FROM port_input WHERE eid = $1 AND opid = 'scan' AND path = 'iris.csv'`, eid).Scan(&inputs))
	require.Equal(t, 1, edges)
	require.Equal(t, 1, inputs)
	lin := s.ok("GET", "/catalog/v1/resources/"+ds.RID.String()+"/lineage?vno=1", alice, nil)
	down := lin["downstream"].([]any)
	require.Len(t, down, 1)
	require.Equal(t, rid, down[0].(map[string]any)["to"].(map[string]any)["rid"])

	page := s.ok("GET", "/catalog/v1/executions/"+ex["eid"].(string)+"/results/avg/output-0?limit=5", alice, nil)
	require.Len(t, page["rows"], 2)
	// The read names where the lineage events said the result is, so a restarted unit can serve it.
	require.Equal(t, []string{"vfs:///avg"}, s.unit.resultTables())

	// Only the platform may report lineage.
	require.Equal(t, http.StatusForbidden, s.do("POST", "/lineage/v1/events", alice, map[string]any{
		"eventType": "COMPLETE", "eventTime": time.Now().UTC().Format(time.RFC3339), "producer": "x", "schemaURL": "x",
		"run": map[string]any{"runId": ex["eid"]}, "job": map[string]any{"namespace": "texera", "name": ex["eid"]}}).status)

	// A failing run is recorded as failed with the engine's error.
	s.unit.fail = true
	failed := s.ok("POST", "/catalog/v1/workflows/"+rid+"/executions", alice, map[string]any{"waitSeconds": 10})
	require.Equal(t, "failed", failed["status"])
	require.Contains(t, failed["error"].(map[string]any)["message"], "boom")
}

func TestMCPServerOverHTTP(t *testing.T) {
	s := newStack(t)
	alice := s.issuer.user("alice")
	accept := []string{"Accept", "application/json, text/event-stream"}
	init := s.do("POST", "/mcp", alice, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "t", "version": "0"}}}, accept...)
	require.Equal(t, http.StatusOK, init.status, string(init.body))
	list := s.do("POST", "/mcp", alice, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{}}, accept...)
	require.Equal(t, http.StatusOK, list.status)
	body := sseData(list.body)
	var parsed map[string]any
	require.NoError(t, json.Unmarshal(body, &parsed), string(body))
	tools := parsed["result"].(map[string]any)["tools"].([]any)
	require.Len(t, tools, 20)

	anon := s.do("POST", "/mcp", "", map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/list"}, accept...)
	require.Equal(t, http.StatusUnauthorized, anon.status)
	require.Contains(t, anon.header.Get("WWW-Authenticate"), "resource_metadata=", "MCP clients discover the authorization server")
	meta := s.ok("GET", "/.well-known/oauth-protected-resource", "", nil)
	require.Equal(t, s.issuer.srv.URL, meta["authorization_servers"].([]any)[0])
}

func TestGatewayExtAuthz(t *testing.T) {
	s := newStack(t)
	alice, bob := s.issuer.user("alice"), s.issuer.user("bob")
	ok := s.do("GET", "/access/v1/ext-authz/catalog/v1/me", alice, nil)
	require.Equal(t, http.StatusOK, ok.status)
	require.NotEmpty(t, ok.header.Get("X-Texera-Principal"))
	require.Equal(t, http.StatusUnauthorized, s.do("GET", "/access/v1/ext-authz/catalog/v1/me", "", nil).status)

	alicePid, _ := s.whoami(alice)
	_, home := s.whoami(alice)
	unit := s.ok("POST", "/catalog/v1/computing-units", alice, map[string]any{"name": "mine", "project": home,
		"spec": map[string]any{"unitKind": "static", "endpoint": s.unit.srv.URL}})
	urid := unit["metadata"].(map[string]any)["rid"].(string)
	require.Equal(t, http.StatusOK, s.do("GET", "/access/v1/ext-authz/units/"+urid+"/wsapi", alice, nil).status)
	require.Equal(t, http.StatusForbidden, s.do("GET", "/access/v1/ext-authz/units/"+urid+"/wsapi", bob, nil).status,
		"a private unit is reachable only by those granted on it")
	require.Equal(t, http.StatusForbidden, s.do("GET", "/access/v1/ext-authz/lineage/v1/events", alice, nil).status)
	_ = alicePid
}

func sseData(b []byte) []byte {
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "data: ") {
			return []byte(strings.TrimPrefix(line, "data: "))
		}
	}
	return b
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestSavedResultsAreDatasetVersionsProducedByTheRun(t *testing.T) {
	s := newStack(t)
	alice, bob := s.issuer.user("alice"), s.issuer.user("bob")
	alicePid, home := s.whoami(alice)
	s.whoami(bob)
	ctx := context.Background()
	homeRID, owner := mustUUID(t, home), mustUUID(t, alicePid)
	iris, _, err := s.store.CreateResource(ctx, store.NewResource{Kind: "dataset", Name: "iris", ParentRID: &homeRID, OwnerPID: owner, CreatedByPID: owner,
		ContentKind: "manifest", Content: json.RawMessage(`{"files":[{"path":"iris.csv","size":5107}]}`)})
	require.NoError(t, err)
	wf := s.ok("POST", "/catalog/v1/workflows/with-content", alice, map[string]any{"name": "iris", "content": map[string]any{
		"operators": []any{
			op("scan", "CSVFileScan", map[string]any{"fileName": "dataset://" + iris.RID.String() + "@1/iris.csv"}),
			map[string]any{"operatorID": "avg", "operatorType": "Aggregate", "operatorProperties": map[string]any{}, "viewResult": true},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"},
			"target": map[string]any{"operatorID": "avg", "portID": "input-0"}}},
	}})
	wfRID := wf["workflow"].(map[string]any)["metadata"].(map[string]any)["rid"].(string)
	ex := s.ok("POST", "/catalog/v1/workflows/"+wfRID+"/executions", alice, map[string]any{"waitSeconds": 10})
	require.Equal(t, "completed", ex["status"])
	eid := ex["eid"].(string)
	save := "/catalog/v1/executions/" + eid + "/results/avg/output-0/save"

	// A new dataset whose first version holds the whole result as CSV, numbers exact.
	v1 := s.ok("POST", save, alice, map[string]any{"name": "species summary"})
	require.Equal(t, "dataset", v1["kind"])
	require.EqualValues(t, 1, v1["vno"])
	ds := v1["rid"].(string)
	got := s.do("GET", "/catalog/v1/datasets/"+ds+"/versions/1/files/avg.csv", alice, nil)
	require.Equal(t, http.StatusOK, got.status, string(got.body))
	require.Equal(t, "species,count,note\nsetosa,9007199254740993,\nvirginica,2,\"a, \"\"quoted\"\" note\"\n", string(got.body))
	meta := s.ok("GET", "/catalog/v1/datasets/"+ds, alice, nil)["metadata"].(map[string]any)
	require.Equal(t, "species summary", meta["name"])

	// Lineage: the version was produced by the workflow version the execution ran.
	up := s.ok("GET", "/catalog/v1/resources/"+ds+"/lineage?vno=1", alice, nil)["upstream"].([]any)
	require.Len(t, up, 1)
	edge := up[0].(map[string]any)
	require.Equal(t, "produced", edge["kind"])
	require.Equal(t, map[string]any{"rid": wfRID, "vno": float64(1)}, edge["from"])
	require.Equal(t, eid, edge["execution"])
	down := s.ok("GET", "/catalog/v1/resources/"+wfRID+"/lineage?vno=1", alice, nil)["downstream"].([]any)
	require.Contains(t, down, map[string]any{"kind": "produced", "from": map[string]any{"rid": wfRID, "vno": float64(1)},
		"to": map[string]any{"rid": ds, "vno": float64(1)}, "execution": eid})

	// Into an existing dataset: a second version, the first file carried forward.
	v2 := s.ok("POST", save, alice, map[string]any{"dataset": ds, "path": "again.csv", "message": "the same run, saved twice"})
	require.EqualValues(t, 2, v2["vno"])
	files := s.ok("GET", "/catalog/v1/datasets/"+ds+"/versions/2/files", alice, nil)["files"].([]any)
	require.Len(t, files, 2)

	// Files someone staged by hand are not swept into a saved version.
	require.Equal(t, http.StatusOK, s.do("PUT", "/catalog/v1/datasets/"+ds+"/files/manual.csv", alice, []byte("a\n1\n")).status)
	require.Equal(t, http.StatusConflict, s.do("POST", save, alice, map[string]any{"dataset": ds}).status)

	// Only someone who can read the execution can save it, and only into a dataset they can edit.
	require.Contains(t, []int{http.StatusForbidden, http.StatusNotFound}, s.do("POST", save, bob, map[string]any{}).status)

	// A run that did not complete has nothing to save.
	s.unit.fail = true
	failed := s.ok("POST", "/catalog/v1/workflows/"+wfRID+"/executions", alice, map[string]any{"waitSeconds": 10})
	require.Equal(t, "failed", failed["status"])
	require.Equal(t, http.StatusConflict, s.do("POST", "/catalog/v1/executions/"+failed["eid"].(string)+"/results/avg/output-0/save", alice, map[string]any{}).status)
}

func TestBuiltInTemplatesFollowThePlatform(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	alice := s.issuer.user("alice")
	analyst := func() map[string]any {
		for _, it := range s.ok("GET", "/catalog/v1/agent-templates?q=Data%20Analyst", alice, nil)["items"].([]any) {
			m := it.(map[string]any)
			if m["metadata"].(map[string]any)["name"] == "Data Analyst" {
				return m
			}
		}
		t.Fatal("no Data Analyst template")
		return nil
	}
	before := analyst()
	rid := before["metadata"].(map[string]any)["rid"].(string)
	require.EqualValues(t, 1, before["metadata"].(map[string]any)["headVersion"])

	// What an older release shipped.
	_, err := s.store.UpdateSpec(ctx, mustUUID(t, rid), json.RawMessage(`{"card":{"name":"Data Analyst","description":"old"}}`))
	require.NoError(t, err)
	require.NoError(t, s.server.Seed(ctx))

	after := analyst()
	require.EqualValues(t, 2, after["metadata"].(map[string]any)["headVersion"])
	prompt := after["spec"].(map[string]any)["prompts"].(map[string]any)["system"].(string)
	require.Contains(t, prompt, "save_result_as_dataset")
	versions := s.ok("GET", "/catalog/v1/resources/"+rid+"/versions", alice, nil)["items"].([]any)
	require.Equal(t, "updated by the platform", versions[0].(map[string]any)["message"])

	// Unchanged on the next start: no new version.
	require.NoError(t, s.server.Seed(ctx))
	require.EqualValues(t, 2, analyst()["metadata"].(map[string]any)["headVersion"])
}
