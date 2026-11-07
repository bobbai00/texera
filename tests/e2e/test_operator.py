"""A custom operator: a Python function saved as a resource, used in a workflow by its URI and
run, listed beside the engine's operators; deleting it is refused while a workflow references it.
Acceptance item 5."""
import json

import pytest

from texera_e2e import workflows as w


@pytest.mark.slow
def test_a_custom_operator_runs_and_is_referenced(alice, project, iris, unit):
    op = w.function_operator(alice, project, "Ordinal rank", w.ORDINAL, description="Adds an ordinal rank column from Id")
    assert op["spec"]["operatorType"] == "ordinal_rank" and op["spec"]["implementation"]["python"]["function"] == "ordinal_rank"
    op_uri = w.at_head(op)
    listed = alice.get("/operators?q=Ordinal+rank")["items"]
    assert any(o["metadata"]["rid"] == op["metadata"]["rid"] and o["metadata"]["project"] == project for o in listed)

    wf = alice.create("workflows", "ranked iris", w.with_operator(iris.file, op_uri, opid="rank"), project=project)
    rid = wf["metadata"]["rid"]
    assert alice.post(f"/workflows/{rid}/validate", {})["ok"]
    run = w.run(alice, rid, "ranked", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    page = w.rows(alice, rid, run["metadata"]["rid"], opid="rank", limit=3)
    assert page["rows"][0][w.column(page, "rank")] == "1st"

    dependents = alice.get(f"/resources/{op['metadata']['rid']}/dependents")
    assert any(e["from"].startswith(wf["metadata"]["uri"]) and e["relation"] == "references" for e in dependents)
    status, body = alice.call("DELETE", f"/operators/{op['metadata']['rid']}")
    assert status == 409 and wf["metadata"]["uri"] in json.dumps(body)
