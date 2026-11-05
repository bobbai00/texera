"""A completed execution's rows stay readable after the unit restarts: the catalog recorded the
result's table and the unit serves it from the warehouse. Restarts the Compose stack's unit."""
import pytest

from texera_e2e import stack
from texera_e2e import workflows as w


@pytest.mark.local
@pytest.mark.destructive
def test_results_survive_a_unit_restart(alice, project, iris, unit):
    wf = alice.create("workflows", "restart", w.average_by_species(iris.file, "SepalWidthCm"), project=project)
    rid = wf["metadata"]["rid"]
    run = w.run(alice, rid, "before", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    before = w.rows(alice, rid, run["metadata"]["rid"])["rows"]
    assert before
    stack.restart_unit()
    assert w.rows(alice, rid, run["metadata"]["rid"])["rows"] == before
