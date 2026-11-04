"""Sharing a project: a viewer finds its workflow, run and dataset, reads them and runs the
workflow, but cannot edit, delete, lease the owner's credential or see the grants; revoking
takes it all back. Acceptance item 6."""
from texera_e2e import workflows as w


def test_a_viewer_reads_and_runs_but_no_more(alice, bob, project, iris, unit, grants_guard):
    wf = alice.create("workflows", "shared petal widths", w.average_by_species(iris.file, "PetalWidthCm"), project=project)
    rid = wf["metadata"]["rid"]
    run = w.run(alice, rid, "alice's run", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    eid = run["metadata"]["rid"]
    cred = alice.create("credentials", "alice's key", {"kind": "api_key", "scope": "example.org"}, project=project)
    crid = cred["metadata"]["rid"]
    alice.put(f"/credentials/{crid}/secret", {"fields": {"value": "s3cret"}})
    bob_pid = bob.pid()
    assert bob.status("GET", f"/workflows/{rid}") in (403, 404)

    grants_guard(project, bob_pid, "viewer")
    found = {r["metadata"]["rid"] for r in bob.get(f"/resources?project={project}&limit=500")["items"]}
    assert {rid, eid, iris.rid} <= found, "bob finds the workflow, the run and the dataset"
    assert bob.get(f"/workflows/{rid}")["metadata"]["name"] == wf["metadata"]["name"]
    assert bob.status("GET", f"/workflows/{rid}/executions/{eid}/operators/avg/ports/output-0/rows?limit=5") == 200
    assert any(f["path"] == "iris.csv" for f in bob.get(f"/datasets/{iris.rid}/versions/1/files")["files"])

    status, bobs = bob.call("POST", f"/workflows/{rid}/run", {"waitSeconds": 180, "name": "bob's run", "computingUnit": unit})
    assert status == 201 and bobs["status"]["phase"] == "completed", (status, bobs)
    assert bobs["metadata"]["owner"] == bob_pid, "bob's run is his own"

    assert bob.status("POST", f"/workflows/{rid}/edit", {"patch": [{"op": "replace", "path": "/operators/1/operatorProperties/aggregations/0/attribute", "value": "SepalWidthCm"}]}) == 403
    assert bob.status("DELETE", f"/workflows/{rid}") == 403
    assert bob.status("POST", f"/credentials/{crid}/lease", {"purpose": f"texera://workflows/{rid}/executions/{eid}"}) == 403
    status, lease = alice.call("POST", f"/credentials/{crid}/lease", {"purpose": f"texera://workflows/{rid}/executions/{eid}"})
    assert status == 201 and lease["fields"]["value"] == "s3cret"
    assert bob.status("GET", f"/resources/{rid}/grants") == 403

    alice.revoke(project, bob_pid)
    assert bob.status("GET", f"/workflows/{rid}") in (403, 404)
