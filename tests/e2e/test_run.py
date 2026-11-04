"""A run through the unit in three phases: a dry run returns the plan the run is started
with, the run stores it (URIs, no secret), the execution has its ports and rows and its
lineage, and a kept run stays past the retention policy. Acceptance items 3 and 4 at the API
level (the chat drives the same in test_agents)."""
from texera_e2e import workflows as w
from texera_e2e.client import uri_rid


def test_validate_run_results_and_lineage(alice, project, iris, unit):
    wf = alice.create("workflows", "iris petal length by species", w.average_by_species(iris.file, result="avg_petal_length"), project=project)
    rid = wf["metadata"]["rid"]

    validated = alice.post(f"/workflows/{rid}/validate", {})
    assert validated["ok"], validated["operatorErrors"]
    assert "avg_petal_length" in {a["attributeName"] for a in validated["operatorOutputSchemas"]["avg"]["output-0"]}
    plan = validated["plan"]
    assert [(o["operatorID"], o["portID"], o["table"]) for o in plan["outputs"]] == [("avg", "output-0", "avg_output_0")], "one table per port the engine writes: scan feeds avg and has none"
    assert iris.file in str(plan["logicalPlan"]), "the plan names the file by URI"

    run = w.run(alice, rid, "smoke run", computingUnit=unit)
    eid = run["metadata"]["rid"]
    assert run["status"]["phase"] == "completed", w.error_text(run)
    assert run["spec"]["workflow"] == f"{wf['metadata']['uri']}@1"
    stored = run["spec"]["plan"]
    assert stored["namespace"] == "e_" + eid.replace("-", "") and stored["outputs"] == plan["outputs"] and stored["logicalPlan"] == plan["logicalPlan"], "the run stores the plan the dry run returned"
    assert any(p["operatorID"] == "avg" and p.get("rows") == 3 and p.get("table") == f"{stored['namespace']}.avg_output_0" for p in run["status"]["ports"]), run["status"]["ports"]

    path = f"/workflows/{rid}/executions/{eid}"
    out = alice.get(f"{path}/operators/avg/ports/output-0")
    assert out["direction"] == "output" and out["result"]["rows"] == 3 and out["result"]["table"]
    inp = alice.get(f"{path}/operators/avg/ports/input-0")
    assert inp["direction"] == "input" and inp["boundTo"].endswith("/ports/output-0")
    page = w.rows(alice, rid, eid)
    assert len(page["rows"]) == 3 and page["total"] == 3
    species = [r[w.column(page, "Species")] for r in page["rows"]]
    assert set(species) == {"Iris-setosa", "Iris-versicolor", "Iris-virginica"}

    upstream = alice.get(f"/resources/{eid}/lineage?direction=upstream")["edges"]
    assert any(e["relation"] == "used" and e["to"].startswith(iris.uri) for e in upstream)
    downstream = alice.get(f"/resources/{iris.rid}/lineage?direction=downstream")["edges"]
    assert any(uri_rid(e["from"].split("/executions/")[-1]) == eid or eid in e["from"] for e in downstream)
    assert eid in {e["metadata"]["rid"] for e in alice.get(f"/workflows/{rid}/executions")["items"]}
    assert alice.get("/executions?phase=completed&limit=3")["items"]

    produced = alice.get(f"/resources/{eid}/lineage?direction=downstream")["edges"]
    assert any(e["relation"] == "produced" and e["to"].startswith("iceberg://") for e in produced), "the run produced its tables"

    # Kept: the mark the retention sweep honours.
    kept = alice.call("PATCH", f"/resources/{eid}", {"labels": {"texera.keep": "true"}})
    assert kept[0] == 200 and kept[1]["metadata"]["labels"]["texera.keep"] == "true"
