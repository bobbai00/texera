"""The lake enforces the catalog's decision: a run's tables live in a namespace of their own
that the unit which ran it reads with vended credentials; anonymous callers, a person's own
token and another unit's identity get nothing; deleting a provisioned unit deletes its
identity and credential. Needs the Compose stack's ports (Lakekeeper, Keycloak, OpenBao)."""
import pytest

from texera_e2e import lake
from texera_e2e import workflows as w
from texera_e2e.client import client_token


@pytest.mark.local
def test_a_unit_reaches_only_its_own_runs(alice, project, iris, unit):
    wf = alice.create("workflows", "lake petal widths", w.average_by_species(iris.file, "PetalWidthCm"), project=project)
    rid = wf["metadata"]["rid"]
    run = w.run(alice, rid, "run", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    eid = run["metadata"]["rid"]
    namespace = lake.execution_namespace(eid)
    assert len(w.rows(alice, rid, eid)["rows"]) == 3, "the catalog serves the rows"

    assert lake.lake_get("/catalog/v1/config?warehouse=texera")[0] == 401, "anonymous"
    assert lake.lake_get("/catalog/v1/config?warehouse=texera", alice.token)[0] in (403, 404), "a person's own token"

    status, unit_tok = client_token(lake.token_url(), *lake.UNIT_CLIENT)
    assert status == 200, "the unit's identity gets a token"
    pfx = lake.prefix(unit_tok)
    status, names = lake.namespaces(unit_tok, pfx)
    assert status == 200 and namespace in names
    assert not [n for n in names if not n.startswith("e_")], "the unit sees no namespace but runs"
    status, table_names = lake.tables(unit_tok, pfx, namespace)
    assert status == 200 and table_names
    assert lake.load_table(unit_tok, pfx, namespace, table_names[0]) == 200, "vended credentials"

    other = alice.create("computing-units", "other unit", {"provider": "kubernetes", "computingNodes": [{"name": "master", "role": "master", "memory": "1Gi"}]}, project=project)
    orid = other["metadata"]["rid"]
    identity = other["status"].get("identity") or {}
    assert identity.get("clientId") == f"unit-{orid}" and identity.get("subject")
    status, other_secret = lake.unit_secret(orid)
    assert status == 200 and other_secret, "its credential is in the secret store"
    status, other_tok = client_token(lake.token_url(), f"unit-{orid}", other_secret)
    assert status == 200
    assert lake.lake_get("/catalog/v1/config?warehouse=texera", other_tok)[0] in (403, 404), "no run of its own, nothing from the lake"
    assert lake.tables(other_tok, pfx, namespace)[0] in (403, 404)
    assert lake.load_table(other_tok, pfx, namespace, table_names[0]) in (403, 404)

    alice.delete(f"/computing-units/{orid}")
    assert client_token(lake.token_url(), f"unit-{orid}", other_secret)[0] in (400, 401), "the identity went with the unit"
    assert lake.unit_secret(orid)[0] == 404, "and its credential"
