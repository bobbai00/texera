"""A run through the unit: validation, an execution with its ports and rows, the lineage, and
the result saved as a dataset version derived from the port. Acceptance items 3 and 4 at the
API level (the chat drives the same in test_agents)."""
from texera_e2e import workflows as w
from texera_e2e.client import uri_rid


def test_validate_run_results_lineage_and_save(alice, project, iris, unit):
    wf = alice.create("workflows", "iris petal length by species", w.average_by_species(iris.file, result="avg_petal_length"), project=project)
    rid = wf["metadata"]["rid"]

    validated = alice.post(f"/workflows/{rid}/validate", {})
    assert validated["ok"], validated["operatorErrors"]
    assert "avg_petal_length" in {a["attributeName"] for a in validated["operatorOutputSchemas"]["avg"]["output-0"]}

    run = w.run(alice, rid, "smoke run", computingUnit=unit)
    eid = run["metadata"]["rid"]
    assert run["status"]["phase"] == "completed", w.error_text(run)
    assert run["spec"]["workflow"] == f"{wf['metadata']['uri']}@1"
    assert any(p["operatorID"] == "avg" and p.get("rows") == 3 for p in run["status"]["ports"])

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

    saved = alice.post(f"{path}/operators/avg/ports/output-0/save", {"name": "petal length by species"})
    srid = saved["rid"]
    csv = alice.download(f"/datasets/{srid}/versions/1/files/avg.csv").decode()
    assert "Iris-setosa" in csv and csv.count("\n") >= 3
    relations = {e["relation"] for e in alice.get(f"/resources/{srid}/lineage?vno=1&direction=upstream")["edges"]}
    assert relations == {"derivedFrom", "produced", "used"}, "the saved version reaches the port, its execution and the file it read"
