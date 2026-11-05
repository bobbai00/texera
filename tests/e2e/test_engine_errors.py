"""What the engine says reaches whoever asked, through the REST API and through the dataflow MCP
tools an agent uses: an operator's own exception, a compile error, a port with no result. A port
the plan names whose table is not written yet is an empty page while the run goes, not an error."""
import json
import time

import pytest

from texera_e2e import chat
from texera_e2e import workflows as w

UDF_BOOM = '''from pytexera import *


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        raise ValueError("the flower count is cursed " + str(7000 + 431))
'''


def tool(api, name: str, **arguments) -> tuple[bool, str]:
    return chat.tool(api, "dataflow", name, **arguments)


def udf(file_uri: str, code: str) -> dict:
    return w.with_operator(file_uri, "PythonUDFV2", {"code": code, "workers": 1, "retainInputColumns": True, "outputColumns": []})


def test_a_failing_operator_says_why_through_run_workflow(alice, project, iris):
    wf = alice.create("workflows", "cursed", udf(iris.file, UDF_BOOM), project=project)
    failed, text = chat.tool(alice, "dataflow", "run_workflow", rid=wf["metadata"]["rid"], waitSeconds=120)
    assert not failed, "the call worked; the run failed, and the execution says so"
    execution = json.loads(text)
    assert execution["status"]["phase"] == "failed", text[:800]
    # Built at run time, so these words are the engine's and not the operator's source in the plan.
    words = "the flower count is cursed 7431"
    assert words in json.dumps(execution["status"]), json.dumps(execution["status"])[:1500]
    assert execution["status"]["operators"]["op"].get("error"), execution["status"]["operators"]
    # So does reading the run afterwards.
    failed, again = tool(alice, "get_execution", rid=wf["metadata"]["rid"], eid=execution["metadata"]["rid"])
    assert not failed and words in json.dumps(json.loads(again)["status"]), again[:1500]
    # And the workflow can be fixed and run again on the same unit.
    assert w.run(alice, wf["metadata"]["rid"], "again")["status"]["phase"] == "failed"


def test_a_compile_error_says_why_through_validate_workflow(alice, project, iris):
    spec = w.average_by_species(iris.file, "NoSuchColumn")
    wf = alice.create("workflows", "bad column", spec, project=project)
    failed, text = tool(alice, "validate_workflow", rid=wf["metadata"]["rid"])
    assert not failed, text[:800]
    assert "NoSuchColumn" in text, "the error names the column, as the engine does: " + text[:1500]
    assert json.loads(text)["ok"] is False, text[:800]


def test_reading_a_port_with_no_result_gives_the_engines_words(alice, project, iris):
    wf = alice.create("workflows", "no such port", w.average_by_species(iris.file), project=project)
    wrid = wf["metadata"]["rid"]
    run = w.run(alice, wrid, "finished")
    assert run["status"]["phase"] == "completed", w.error_text(run)
    eid = run["metadata"]["rid"]
    path = f"/workflows/{wrid}/executions/{eid}/operators/nosuch/ports/output-0/rows?limit=5"

    status, body = alice.call("GET", path)
    assert status == 404, (status, body)
    assert body["code"] == "not_found" and "nosuch" in body["message"], body

    failed, text = tool(alice, "get_port_result", rid=wrid, eid=eid, operatorID="nosuch", portID="output-0")
    assert failed, text
    assert "nosuch" in text and "unmarshal" not in text, text


def test_a_port_is_empty_until_its_table_is_written(alice, project, iris):
    wf = alice.create("workflows", "right away", w.average_by_species(iris.file), project=project)
    wrid = wf["metadata"]["rid"]
    eid = alice.post(f"/workflows/{wrid}/run", {"name": "read at once"})["metadata"]["rid"]
    path = f"/workflows/{wrid}/executions/{eid}/operators/avg/ports/output-0/rows?offset=0&limit=50"
    answers, deadline = [], time.time() + 120
    while time.time() < deadline:
        status, body = alice.call("GET", path)
        answers.append(status)
        assert status == 200, (status, body, f"after {len(answers)} reads")
        phase = alice.get(f"/workflows/{wrid}/executions/{eid}")["status"]["phase"]
        if phase == "completed" and len(body["rows"]) == 3:
            return
        assert phase in ("pending", "provisioning", "running", "completed"), phase
    pytest.fail(f"the run did not finish: {answers[-5:]}")


def test_an_unknown_run_is_not_found(alice, project, iris):
    wf = alice.create("workflows", "no such run", w.average_by_species(iris.file), project=project)
    failed, text = tool(alice, "get_port_result", rid=wf["metadata"]["rid"], eid="00000000-0000-4000-8000-000000000000", operatorID="avg", portID="output-0")
    assert failed and text.startswith("404"), text
