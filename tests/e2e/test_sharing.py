"""Sharing a project: a viewer finds its workflow, run and dataset, reads them and runs the
workflow, but cannot edit, delete, lease the owner's credential or see the grants; revoking
takes it all back. Acceptance item 6."""
from texera_e2e import chat
from texera_e2e import workflows as w
from texera_e2e.events import Watch

EMPTY = {"operators": [], "links": []}


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
    assert {rid, eid, iris.rid} <= found, "bob finds the workflow, the execution and the dataset"
    assert bob.get(f"/workflows/{rid}")["metadata"]["name"] == wf["metadata"]["name"]
    assert bob.status("GET", f"/workflows/{rid}/executions/{eid}/operators/avg/ports/output-0/rows?limit=5") == 200
    assert any(f["path"] == "iris.csv" for f in bob.get(f"/datasets/{iris.rid}/versions/1/files")["files"])

    status, bobs = bob.call("POST", f"/workflows/{rid}/run", {"waitSeconds": 180, "name": "bob's run", "computingUnit": unit})
    assert status == 201 and bobs["status"]["phase"] == "completed", (status, bobs)
    assert bobs["metadata"]["owner"] == bob_pid, "bob's execution is his own"

    assert bob.status("POST", f"/workflows/{rid}/edit", {"patch": [{"op": "replace", "path": "/operators/1/operatorProperties/aggregations/0/attribute", "value": "SepalWidthCm"}]}) == 403
    assert bob.status("DELETE", f"/workflows/{rid}") == 403
    assert bob.status("POST", f"/credentials/{crid}/lease", {"purpose": f"texera://workflows/{rid}/executions/{eid}"}) == 403
    status, lease = alice.call("POST", f"/credentials/{crid}/lease", {"purpose": f"texera://workflows/{rid}/executions/{eid}"})
    assert status == 201 and lease["fields"]["value"] == "s3cret"
    assert bob.status("GET", f"/resources/{rid}/grants") == 403

    alice.revoke(project, bob_pid)
    assert bob.status("GET", f"/workflows/{rid}") in (403, 404)


def test_what_others_shared_with_a_person_is_one_list(alice, bob, project, iris, grants_guard):
    """What a person was given is one list, whatever its kind and wherever it lives: a project,
    a chat, a workflow, a dataset. It holds what they hold a grant on: not what they own, not
    what lies inside a project they were given. A grant taken back takes the thing off it."""
    bob_pid = bob.pid()
    wf = alice.create("workflows", "shared alone", EMPTY, project=project)["metadata"]["rid"]
    kept = alice.create("workflows", "kept in the project", EMPTY, project=project)["metadata"]["rid"]
    crid = chat.conversation(alice, "shared chat", project)

    def shared(who, more: str = "") -> set[str]:
        return {r["metadata"]["rid"] for r in who.get(f"/resources?shared=true&limit=200{more}")["items"]}

    ours = {wf, kept, crid, iris.rid, project}
    assert not (shared(bob) & ours), "nothing of this test is shared yet"

    for rid, relation in ((wf, "viewer"), (iris.rid, "viewer"), (crid, "editor")):
        grants_guard(rid, bob_pid, relation)
    assert shared(bob) & ours == {wf, iris.rid, crid}
    assert shared(bob, "&kind=workflow") & ours == {wf}, "by kind, like any list"
    for path in (f"/workflows/{wf}", f"/datasets/{iris.rid}", f"/conversations/{crid}"):
        assert bob.status("GET", path) == 200, f"bob opens {path}"

    # The project itself: the list gains the project, and what else is in it is reached through it.
    grants_guard(project, bob_pid, "viewer")
    assert shared(bob) & ours == {wf, iris.rid, crid, project}
    assert bob.status("GET", f"/workflows/{kept}") == 200
    assert not (shared(alice) & ours), "alice shared them; nothing here was shared with her"

    alice.revoke(iris.rid, bob_pid)
    assert shared(bob) & ours == {wf, crid, project}


def test_a_watch_ends_when_what_let_the_watcher_read_is_taken_back(alice, bob, project, grants_guard):
    """A resource's event stream is for someone who may read it. The catalog asks that again
    while the stream is open, so a grant taken back, here on the project the workflow lives
    in, ends the stream though nothing about the workflow changed."""
    bob_pid = bob.pid()
    rid = alice.create("workflows", "watched", EMPTY, project=project)["metadata"]["rid"]
    grants_guard(project, bob_pid, "viewer")
    watch = Watch(bob, rid)
    assert watch.next("resource")["kind"] == "workflow"

    alice.revoke(project, bob_pid)
    assert watch.ended(timeout=45), "the stream ends within a beat of the grant being taken back"
    assert bob.status("GET", f"/resources/{rid}/events") == 403
