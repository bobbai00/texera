"""The catalog through the gateway: who I am and the seeds, a workflow's versions and edits,
sharing, dataset files and references, a conversation with a turn and an origin, and the MCP
server. Acceptance items 1 and 2, and the surface every other scenario stands on."""
import time
import urllib.error
import urllib.request

import pytest

from texera_e2e.client import uri_rid

CSV = b"sepal_length,species\n5.1,setosa\n4.9,setosa\n"


def test_me_and_the_public_settings(alice, anon):
    me = alice.me()
    assert me["principal"]["displayName"] and me["homeProject"] and me["systemProject"]
    assert me["admin"] is False
    public = anon.get("/settings/public")
    assert public["branding"]["name"] and public["auth"]["clientId"] == "texera-app"


def test_the_seeds(alice):
    # One agent is the entry to every chat: the platform ships it, and it is the default. What
    # the platform ships is what lives in its project, which is public; nothing else marks it.
    platform = alice.me()["systemProject"]
    assert alice.get(f"/projects/{platform}")["metadata"]["name"] == "Built-in"
    agents = [t for t in alice.get("/agent-templates")["items"] if t["metadata"]["project"] == platform]
    assert all("texera.builtin" not in t["metadata"].get("labels", {}) and t["metadata"]["visibility"] == "private" for t in agents)
    assert [t["metadata"]["name"] for t in agents] == ["Texera Agent"]
    assert alice.get("/settings")["spec"]["defaults"]["agentTemplate"] == agents[0]["metadata"]["uri"]
    assert any(u["status"]["phase"] == "ready" for u in alice.get("/computing-units/available")), "a ready unit"
    # One MCP server is the platform's own, the catalog; whatever else it ships is an add-on.
    servers = {s["metadata"]["name"] for s in alice.get("/mcp-servers")["items"]}
    assert "catalog" in servers and "dataflow" not in servers
    endpoints = alice.get("/model-endpoints")["items"]
    assert endpoints and endpoints[0]["spec"]["model"]
    for _ in range(30):
        if alice.get("/operators?limit=5")["items"]:
            break
        time.sleep(3)
    scan = [o for o in alice.get("/operators?q=CSVFileScan")["items"] if o["spec"]["operatorType"] == "CSVFileScan"]
    # The engine's operators are built in like the rest: they live in the platform's project.
    assert scan and "propertiesSchema" in scan[0]["spec"] and scan[0]["metadata"]["project"] == platform


def test_workflow_versions_edits_and_sharing(alice, bob, project):
    wf = alice.create("workflows", "smoke", {"operators": [{"operatorID": "a", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": "x.csv"}}], "links": []}, project=project)
    rid, uri = wf["metadata"]["rid"], wf["metadata"]["uri"]
    assert wf["metadata"]["head"] == 1
    v2 = alice.post(f"/workflows/{rid}/edit", {"patch": [
        {"op": "add", "path": "/operators/-", "value": {"operatorID": "b", "operatorType": "Filter", "operatorProperties": {}}},
        {"op": "add", "path": "/links/-", "value": {"linkID": "l1", "source": {"operatorID": "a", "portID": "output-0"}, "target": {"operatorID": "b", "portID": "input-0"}}},
    ], "message": "add a filter"})
    assert v2["uri"].endswith("@2") and len(v2["content"]["operators"]) == 2
    assert [v["vno"] for v in alice.get(f"/workflows/{rid}/versions")["items"]] == [2, 1] or [v["vno"] for v in alice.get(f"/workflows/{rid}/versions")["items"]] == [1, 2]
    assert alice.status("POST", f"/workflows/{rid}/edit", {"patch": [{"op": "replace", "path": "/operators", "value": "nope"}]}) == 400
    resolved = alice.get(f"/resources/resolve?uri={uri}@1")
    assert resolved["resource"]["kind"] == "workflow" and resolved["version"]["vno"] == 1 and len(resolved["version"]["content"]["operators"]) == 1
    assert alice.status("PUT", f"/workflows/{rid}", {"spec": {"operators": [], "links": []}, "expectedHead": 1}) == 409, "a stale head"

    # Sharing: bob reads once granted, never edits as a viewer, loses it on revoke.
    pid = bob.pid()
    assert bob.status("GET", f"/workflows/{rid}") == 403
    assert alice.grant(rid, pid, "viewer")["relation"] == "viewer"
    assert bob.status("GET", f"/workflows/{rid}") == 200
    assert bob.status("POST", f"/workflows/{rid}/edit", {"spec": {"operators": [], "links": []}}) == 403
    assert rid in {r["metadata"]["rid"] for r in bob.get("/resources?q=smoke&limit=200")["items"]}
    alice.revoke(rid, pid)
    assert bob.status("GET", f"/workflows/{rid}") == 403


def test_dataset_files_and_references(alice, project):
    ds = alice.create("datasets", "iris-smoke", {"format": "csv"}, project=project)
    rid, uri = ds["metadata"]["rid"], ds["metadata"]["uri"]
    staged = alice.upload(f"/datasets/{rid}/files/iris.csv", CSV)
    assert staged["path"] == "iris.csv" and staged["size"] == len(CSV) and staged["sha256"].startswith("sha256:")
    again = alice.upload(f"/datasets/{rid}/files/copy.csv", CSV)
    assert again["sha256"] == staged["sha256"], "the same bytes are one blob"
    v1 = alice.post(f"/datasets/{rid}/commit", {"message": "first"})
    assert v1["uri"].endswith("@1") and v1["contentKind"] == "manifest"
    assert {f["path"] for f in alice.get(f"/datasets/{rid}/versions/1/files")["files"]} == {"iris.csv", "copy.csv"}
    assert alice.status("GET", f"/datasets/{rid}/versions/1/files/iris.csv?maxBytes=10") == 206, "a bounded read is partial"
    assert alice.download(f"/datasets/{rid}/versions/1/files/iris.csv") == CSV
    link = alice.get(f"/datasets/{rid}/versions/1/links/iris.csv")
    assert link["url"].startswith("http") and link["expiresInSeconds"] > 0

    wf = alice.create("workflows", "reads the file", {"operators": [{"operatorID": "a", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": f"{uri}@1/files/iris.csv"}}], "links": []}, project=project)
    dependents = alice.get(f"/resources/{rid}/dependents")
    assert any(e["relation"] == "references" and uri_rid(e["from"]) == wf["metadata"]["rid"] for e in dependents)
    assert alice.status("DELETE", f"/datasets/{rid}") == 409, "a referenced dataset stays"


def test_conversation_turn_and_origin(alice, service, project):
    conv = alice.create("conversations", "smoke chat", {}, project=project)
    crid = conv["metadata"]["rid"]
    # A chat stores its choices and a new one has none: what it runs with is resolved when asked,
    # and a turn pins the agent's version.
    assert conv["spec"] == {}
    settings = alice.get(f"/conversations/{crid}/settings")
    assert settings["agent"]["from"] == "platform" and settings["modelEndpoint"]["from"] == "agent"
    assert [(m["name"], m["platform"]) for m in settings["mcpServers"]] == [("catalog", True), ("biomcp", False)]
    assert settings == alice.get(f"/projects/{project}/chat-settings"), "a chat not started yet runs with the same"
    turn = alice.post(f"/conversations/{crid}/turns", {})
    tid, tpl = turn["turn"], turn["template"]
    assert tpl == settings["agent"]["uri"]
    assert alice.status("POST", f"/conversations/{crid}/turns", {}) == 409, "one turn at a time"
    assert alice.post(f"/conversations/{crid}/messages", {"turn": tid, "role": "user", "parts": [{"type": "text", "text": "hello"}]})["seq"] >= 1
    made = alice._ok("POST", "/workflows", {"name": "from chat", "spec": {"operators": [], "links": []}, "parent": project},
                     headers={"X-Texera-Service-Token": service, "X-Texera-Origin": f"conversation={crid};turn={tid};template={tpl}"})
    assert made["metadata"]["origin"]["turn"] == tid
    alice.delete(f"/conversations/{crid}/turns/{tid}")
    assert [(i["resource"]["kind"], i["resource"]["metadata"]["name"], i["made"]) for i in alice.get(f"/conversations/{crid}/resources")] == [("workflow", "from chat", True)]
    status = alice.get(f"/conversations/{crid}")["status"]
    assert status.get("activeTurn") is None and status["messages"] >= 1


def test_the_mcp_server(alice, anon, project):
    wf = alice.create("workflows", "for mcp", {"operators": [], "links": []}, project=project)
    status, init = alice.mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "0"}})
    assert status == 200 and init["result"]["serverInfo"]["name"] == "texera-catalog"
    # One server holds every tool: what exists (resources, dataset files, operators, units,
    # people, sharing), the verbs of a unit and those of a workflow and its executions.
    _, listed = alice.mcp("tools/list")
    assert {t["name"] for t in listed["result"]["tools"]} == {
        "search_resources", "resolve_uri", "get_resource", "list_versions", "get_version", "get_lineage", "grant_access",
        "search_principals", "whoami", "list_dataset_files", "read_dataset_file", "commit_dataset_version",
        "list_operators", "list_computing_units", "create_computing_unit", "save_unit_as_profile",
        "create_workflow", "get_workflow", "edit_workflow", "validate_workflow", "run_workflow",
        "get_execution", "pause_execution", "resume_execution", "get_port_result"}
    # There is no second server: the address the dataflow server had answers nothing.
    gone = urllib.request.Request(f"{alice.gw}/mcp/dataflow", method="POST", data=b"{}", headers={"Authorization": f"Bearer {alice.token}"})
    with pytest.raises(urllib.error.HTTPError) as refused:
        urllib.request.urlopen(gone, timeout=30)
    assert refused.value.code == 404
    _, units = alice.mcp("tools/call", {"name": "list_computing_units", "arguments": {}})
    assert any(u["status"]["phase"] == "ready" for u in units["result"]["structuredContent"]["items"]), units
    _, scan = alice.mcp("tools/call", {"name": "list_operators", "arguments": {"q": "CSVFileScan"}})
    assert not scan["result"].get("isError") and "CSVFileScan" in scan["result"]["content"][0]["text"]
    _, got = alice.mcp("tools/call", {"name": "get_workflow", "arguments": {"rid": wf["metadata"]["rid"]}})
    assert got["result"]["structuredContent"]["metadata"]["head"] == 1
    _, resolved = alice.mcp("tools/call", {"name": "resolve_uri", "arguments": {"uri": wf["metadata"]["uri"] + "@1"}})
    assert resolved["result"]["structuredContent"]["version"]["vno"] == 1
    assert anon.mcp("tools/list")[0] == 401


def test_a_resource_page_is_the_apps_to_serve_whatever_its_kind(alice):
    """A link to a resource's page opens the app. The page of an MCP server is one of them:
    its address starts like the MCP endpoint's (/mcp/catalog) and is not the endpoint's."""
    for plural in ("workflows", "mcp-servers", "model-endpoints"):
        with urllib.request.urlopen(f"{alice.gw}/{plural}/00000000-0000-4000-8000-000000000000", timeout=30) as page:
            assert page.status == 200 and "text/html" in page.headers["Content-Type"], plural
