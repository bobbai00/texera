"""The unit's two doors are closed. Its API answers the catalog's own client alone: a person's
token is refused at the unit and the gateway no longer routes to units. On the way back a
unit reports as itself, and the catalog takes an execution's events from the unit that runs
it alone: not from a person, not from the platform's client, not from another unit."""
import time

import pytest

from texera_e2e import lake
from texera_e2e import workflows as w
from texera_e2e.client import Api, client_token

UNIT = "http://localhost:28085"


def event(eid: str, status: str = "completed") -> dict:
    return {"eventType": "COMPLETE", "eventTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "producer": "e2e",
            "schemaURL": "https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent",
            "run": {"runId": eid, "facets": {"texera_execution": {"status": status}}}, "job": {"namespace": "texera", "name": eid}}


@pytest.mark.local
def test_the_unit_answers_the_catalog_alone(alice, service, gw):
    assert Api(UNIT, alice.token).call("GET", f"{UNIT}/api/operators")[0] == 403, "a person at the unit"
    assert Api(UNIT, alice.token).call("POST", f"{UNIT}/api/executions", {"eid": "x"})[0] == 403
    assert Api(UNIT).call("GET", f"{UNIT}/api/operators")[0] == 401, "nobody at the unit"
    assert Api(UNIT, service).call("GET", f"{UNIT}/api/operators")[0] == 200, "the catalog's client at the unit"
    assert Api(UNIT).call("GET", f"{UNIT}/api/health")[0] == 200, "health stays open for the probes"
    units = alice.get("/computing-units/available")
    rid = units[0]["metadata"]["rid"]
    status, body = alice.call("GET", f"{gw}/units/{rid}/api/health")
    assert not (isinstance(body, dict) and body.get("status") == "ok"), f"the gateway no longer routes to units ({status})"


@pytest.mark.local
def test_only_the_running_unit_reports(alice, service, project, iris, unit):
    wf = alice.create("workflows", "reported", w.average_by_species(iris.file), project=project)
    run = w.run(alice, wf["metadata"]["rid"], "run", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    eid = run["metadata"]["rid"]
    lineage = f"{alice.gw}/lineage/v1/events"
    assert alice.call("POST", lineage, event(eid))[0] == 403, "a person"
    assert Api(alice.gw, service).call("POST", lineage, event(eid))[0] == 403, "the platform's own client"

    status, unit_tok = client_token(lake.token_url(), *lake.UNIT_CLIENT)
    assert status == 200
    assert Api(alice.gw, unit_tok).call("POST", lineage, event(eid))[0] == 204, "the unit that ran it"

    other = alice.create("computing-units", "other unit", {"provider": "kubernetes", "computingNodes": [{"name": "master", "role": "master", "memory": "1Gi"}]}, project=project)
    status, secret = lake.unit_secret(other["metadata"]["rid"])
    assert status == 200 and secret
    status, other_tok = client_token(lake.token_url(), f"unit-{other['metadata']['rid']}", secret)
    assert status == 200
    assert Api(alice.gw, other_tok).call("POST", lineage, event(eid))[0] == 403, "another unit"
    assert alice.get(f"/workflows/{wf['metadata']['rid']}/executions/{eid}")["status"]["phase"] == "completed"
