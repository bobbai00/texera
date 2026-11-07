"""Profiles: what a computing node is made of, its size and the Python packages it adds to the
platform's runtime. A unit made from a profile has them: a Python function that imports one of them
runs there and fails on a unit without it; the execution records the profile version and each
package as the unit installed it. Saving the unit as a profile makes the profile's next version,
its packages pinned, or a new profile; the unit is then made from what was saved."""
import re

import pytest

from texera_e2e import workflows as w
from texera_e2e.units import wait_ready


@pytest.mark.cluster
@pytest.mark.slow
def test_a_unit_made_from_a_profile_has_its_packages(alice, project, iris, unit):
    profile = alice.create("profiles", "py-humanize", {"memory": "2Gi", "packages": ["humanize"]}, project=project)
    puri = profile["metadata"]["uri"]
    made = alice.post("/computing-units/from-profile", {"name": "humanize unit", "parent": project, "profile": puri})
    rid, uri = made["metadata"]["rid"], made["metadata"]["uri"]
    # The unit's node is the profile's version, filled in.
    node = made["spec"]["computingNodes"][0]
    assert (node["profile"], node["memory"], node["packages"]) == (f"{puri}@1", "2Gi", ["humanize"]), node
    phase, took = wait_ready(alice, rid)
    assert phase == "ready", f"{phase} after {took:.0f}s"

    rank = w.function_operator(alice, project, "humanize rank", w.RANK)
    wf = alice.create("workflows", "humanize ranks", w.with_operator(iris.file, w.at_head(rank), opid="udf"), project=project)
    wrid = wf["metadata"]["rid"]
    assert alice.post(f"/workflows/{wrid}/validate", {})["ok"]

    # The platform's unit has no humanize. The engine names the missing module when its Python
    # is 3.11 or newer; the cluster image's 3.10 cannot (`add_note`): a bare ModuleNotFoundError.
    plain = w.run(alice, wrid, "on the platform's unit", computingUnit=unit)
    assert plain["status"]["phase"] == "failed" and w.missing_module(plain, "humanize")

    run = w.run(alice, wrid, "on the humanize unit", wait=600, computingUnit=uri)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    page = w.rows(alice, wrid, run["metadata"]["rid"], opid="udf", limit=3)
    assert page["rows"][0][w.column(page, "rank")] == "1st"
    # What the unit had: the profile version, its size, each package as installed.
    computing = alice.get(f"/workflows/{wrid}/executions/{run['metadata']['rid']}")["spec"]["computing"]
    assert computing["profile"] == f"{puri}@1" and computing["memory"] == "2Gi", computing
    assert len(computing["packages"]) == 1 and re.fullmatch(r"humanize==\d+(\.\d+)+", computing["packages"][0]), computing
    pin = computing["packages"][0]
    assert pin in alice.get(f"/computing-units/{rid}")["status"]["installed"]

    # Saved as the profile it came from: its next version, the package pinned; the unit follows.
    saved = alice.post(f"/computing-units/{rid}/profile", {"profile": puri})
    assert saved["metadata"]["head"] == 2 and saved["spec"]["packages"] == [pin] and saved["spec"]["runtime"], saved["spec"]
    assert alice.get(f"/computing-units/{rid}")["spec"]["computingNodes"][0]["profile"] == f"{puri}@2"
    # Or as a new profile, in the unit's project.
    other = alice.post(f"/computing-units/{rid}/profile", {"name": "py-humanize pinned"})
    assert other["metadata"]["project"] == project and other["spec"]["packages"] == [pin] and other["metadata"]["head"] == 1
    assert alice.get(f"/computing-units/{rid}")["spec"]["computingNodes"][0]["profile"] == f"{other['metadata']['uri']}@1"

    assert alice.post(f"/computing-units/{rid}/terminate", {})["status"]["phase"] == "terminated"
    assert alice.status("DELETE", f"/computing-units/{rid}") == 204
