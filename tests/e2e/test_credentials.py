"""Credentials in operator properties: a property with format credential holds a credential
URI; the run gets the secret through a lease and the code sees it; the version keeps the URI;
a project viewer who may not use the credential is refused until granted use."""
import json

from texera_e2e import workflows as w


def test_a_credential_reaches_the_run_through_a_lease(alice, bob, project, iris, unit, grants_guard):
    secret = "token-9f3a-e2e"
    cred = alice.create("credentials", "service key", {"kind": "api_key", "scope": "example.org"}, project=project)
    alice.put(f"/credentials/{cred['metadata']['rid']}/secret", {"fields": {"value": secret}})
    op = alice.create("operators", "Authed tagger", {
        "operatorType": "AuthedTagger", "displayName": "Authed tagger", "group": "Custom",
        "inputPorts": [{"portID": "input-0"}], "outputPorts": [{"portID": "output-0"}],
        "propertiesSchema": {"type": "object", "properties": {"apiKey": {"type": "string", "format": "credential"}, "label": {"type": "string"}}, "required": ["apiKey"]},
        "implementation": {"python": {"code": w.UDF_AUTHED, "outputColumns": [{"attributeName": "auth", "attributeType": "string"}, {"attributeName": "label", "attributeType": "string"}]}},
    }, project=project)
    op_uri = f"{op['metadata']['uri']}@{op['metadata']['head']}"
    wf = alice.create("workflows", "authed tagging", w.with_operator(iris.file, op_uri, {"apiKey": cred["metadata"]["uri"], "label": "tagged"}, opid="tag"), project=project)
    rid = wf["metadata"]["rid"]
    assert alice.post(f"/workflows/{rid}/validate", {})["ok"], "a compile leaves the URI in place"

    run = w.run(alice, rid, "authed run", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    page = w.rows(alice, rid, run["metadata"]["rid"], opid="tag", limit=2)
    row = page["rows"][0]
    assert row[w.column(page, "auth")] == secret[-4:] and row[w.column(page, "label")] == "tagged", "the code saw the leased secret through PROPS"
    version = json.dumps(alice.get(f"/workflows/{rid}/versions/1"))
    assert cred["metadata"]["uri"] in version and secret not in version
    assert secret not in json.dumps(alice.get(f"/workflows/{rid}/executions/{run['metadata']['rid']}"))

    bob_pid = bob.pid()
    grants_guard(project, bob_pid, "viewer")
    before = len(alice.get(f"/workflows/{rid}/executions")["items"])
    status, body = bob.call("POST", f"/workflows/{rid}/run", {"waitSeconds": 60, "name": "bob tries", "computingUnit": unit})
    assert status == 403, (status, body)
    assert len(alice.get(f"/workflows/{rid}/executions")["items"]) == before, "a refused run leaves no execution behind"
    grants_guard(cred["metadata"]["rid"], bob_pid, "user")
    status, bobs = bob.call("POST", f"/workflows/{rid}/run", {"waitSeconds": 240, "name": "bob with use", "computingUnit": unit})
    assert status == 201 and bobs["status"]["phase"] == "completed", (status, bobs)
