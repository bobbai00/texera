"""Results live with executions: a second execution of an edited workflow leaves the first execution's
rows alone, both survive the unit's idle release, an execution can be deleted with its tables, and
the retention policy expires old results while the record stays."""
import time

import pytest

from texera_e2e import workflows as w


@pytest.mark.slow
def test_results_are_kept_per_execution(alice, project, iris, unit):
    wf = alice.create("workflows", "retention", w.average_by_species(iris.file), project=project)
    rid = wf["metadata"]["rid"]
    first = w.run(alice, rid, "petal length", computingUnit=unit)
    assert first["status"]["phase"] == "completed", w.error_text(first)
    first_rows = w.rows(alice, rid, first["metadata"]["rid"])["rows"]

    alice.post(f"/workflows/{rid}/edit", {"patch": [{"op": "replace", "path": "/operators/1/operatorProperties/aggregations/0/attribute", "value": "SepalLengthCm"}],
                                           "expectedHead": 1, "message": "sepal instead of petal"})
    second = w.run(alice, rid, "sepal length", computingUnit=unit)
    assert second["status"]["phase"] == "completed", w.error_text(second)
    second_rows = w.rows(alice, rid, second["metadata"]["rid"])["rows"]
    assert first_rows and second_rows and first_rows != second_rows
    assert w.rows(alice, rid, first["metadata"]["rid"])["rows"] == first_rows, "the first execution's rows after the second execution"
    for run in (first, second):
        assert run["status"]["ports"] and all(p.get("table") for p in run["status"]["ports"])

    time.sleep(40)  # the unit's idle release
    assert w.rows(alice, rid, first["metadata"]["rid"])["rows"] == first_rows
    assert w.rows(alice, rid, second["metadata"]["rid"])["rows"] == second_rows

    # Deleting an execution takes its tables with it.
    path = f"/workflows/{rid}/executions/{first['metadata']['rid']}"
    assert alice.status("DELETE", path) == 204
    assert alice.status("GET", path) == 404
    assert alice.status("GET", f"{path}/operators/avg/ports/output-0/rows") == 404


@pytest.mark.destructive
def test_results_expire_under_the_policy(alice, admin, project, iris, unit, settings_guard):
    """Expires every finished run on the stack: a dev stack only."""
    wf = alice.create("workflows", "expiring", w.average_by_species(iris.file), project=project)
    rid = wf["metadata"]["rid"]
    run = w.run(alice, rid, "to expire", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    eid = run["metadata"]["rid"]
    kept = w.run(alice, rid, "to keep", computingUnit=unit)
    assert kept["status"]["phase"] == "completed", w.error_text(kept)
    keid = kept["metadata"]["rid"]
    alice.call("PATCH", f"/resources/{keid}", {"labels": {"texera.keep": "true"}})
    assert alice.status("POST", "/settings/retention/sweep") == 403, "a sweep is the administrator's"
    admin.put("/settings", {"spec": {**settings_guard, "retention": {"results": "PT0S"}}})
    time.sleep(1)
    sweep = admin.post("/settings/retention/sweep")
    assert sweep["executionsExpired"] >= 1
    status = alice.get(f"/workflows/{rid}/executions/{eid}")["status"]
    assert status["phase"] == "completed" and status.get("resultsExpiredAt"), "the record stays, marked"
    assert alice.status("GET", f"/workflows/{rid}/executions/{eid}/operators/avg/ports/output-0/rows") == 410
    assert not alice.get(f"/workflows/{rid}/executions/{keid}")["status"].get("resultsExpiredAt"), "a kept execution stays"
    assert len(w.rows(alice, rid, keid)["rows"]) == 3
