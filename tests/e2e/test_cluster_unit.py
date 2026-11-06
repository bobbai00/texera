"""A computing unit as a resource on Kubernetes: created through the API it becomes a
Deployment the catalog reconciles, with a Secret holding the identity minted for it; it
reports pending then ready; a workflow runs on it; a changed spec rolls the Deployment and the
unit runs again; a viewer may not run on it until granted use; terminating removes the
workloads and the resource can be deleted afterwards."""
import time

import pytest

from texera_e2e import kube
from texera_e2e import workflows as w
from texera_e2e.units import wait_ready


@pytest.mark.cluster
@pytest.mark.slow
def test_a_unit_lives_as_a_resource(alice, bob, project, iris, kubectl, grants_guard):
    unit = alice.create("computing-units", "alice's unit", {"provider": "kubernetes", "computingNodes": [{"name": "master", "role": "master", "memory": "2Gi"}]}, project=project)
    rid, uri = unit["metadata"]["rid"], unit["metadata"]["uri"]
    phase, took = wait_ready(alice, rid)
    assert phase == "ready", f"{phase} after {took:.0f}s"
    if kubectl:
        held = kube.held_for(rid)
        assert any("deployment" in h for h in held) and any("service" in h for h in held) and any("secret" in h for h in held), held
    identity = alice.get(f"/computing-units/{rid}")["status"].get("identity") or {}
    assert identity.get("clientId") == f"unit-{rid}" and identity.get("subject")

    wf = alice.create("workflows", "on my unit", w.average_by_species(iris.file, "SepalLengthCm"), project=project)
    wrid = wf["metadata"]["rid"]
    run = w.run(alice, wrid, "run on my unit", wait=300, computingUnit=uri)
    assert run["status"]["phase"] == "completed" and run["spec"]["computingUnit"] == uri, w.error_text(run)
    assert len(w.rows(alice, wrid, run["metadata"]["rid"], limit=5)["rows"]) == 3

    # A changed spec rolls the Deployment: more memory, ready again, runs again.
    before = kube.memory_request(rid) if kubectl else ""
    alice.put(f"/computing-units/{rid}", {"spec": {"provider": "kubernetes", "computingNodes": [{"name": "master", "role": "master", "memory": "3Gi"}]}})
    if kubectl:
        kube.rolled_out(rid)
    phase, took = wait_ready(alice, rid)
    assert phase == "ready", f"{phase} after {took:.0f}s"
    if kubectl:
        assert (before, kube.memory_request(rid)) == ("2Gi", "3Gi")
    again = w.run(alice, wrid, "run after the change", wait=300, computingUnit=uri)
    assert again["status"]["phase"] == "completed", w.error_text(again)

    bob_pid = bob.pid()
    grants_guard(wrid, bob_pid, "viewer")
    grants_guard(iris.rid, bob_pid, "viewer")
    status, body = bob.call("POST", f"/workflows/{wrid}/run", {"waitSeconds": 60, "computingUnit": uri, "name": "bob on alice's unit"})
    assert status == 403, (status, body)
    grants_guard(rid, bob_pid, "user")
    status, body = bob.call("POST", f"/workflows/{wrid}/run", {"waitSeconds": 300, "computingUnit": uri, "name": "bob with use"})
    assert status == 201 and body["status"]["phase"] == "completed", (status, body)

    assert alice.post(f"/computing-units/{rid}/terminate", {})["status"]["phase"] == "terminated"
    time.sleep(3)
    if kubectl:
        assert kube.held_for(rid) == []
    assert alice.status("DELETE", f"/computing-units/{rid}") == 204
