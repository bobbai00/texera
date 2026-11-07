"""Aggregate runs in two stages: every first-stage worker accumulates its share of each group,
and the second stage merges the shares by group key. Rows reach the first stage's two workers
one by one in turn, so a group whose rows are uneven in number splits unevenly; its mean must
still be the mean of all its rows (an average of the workers' averages would not be)."""
from texera_e2e import workflows as w

# One row at a time to two workers: Irvine's 10 and 20 land on one, its 60 on the other (or
# the other way round), so the workers' averages differ in weight. The mean of 10, 60 and 20
# is 30; an unweighted mean of the workers' averages would be 25.
SALES = b"city,sales\nIrvine,10\nIrvine,60\nDavis,5\nIrvine,20\n"


def test_an_average_over_an_uneven_split_is_the_mean_of_all_rows(alice, project, unit):
    ds = alice.create("datasets", "sales", {"format": "csv"}, project=project)
    rid = ds["metadata"]["rid"]
    alice.upload(f"/datasets/{rid}/files/sales.csv", SALES)
    alice.post(f"/datasets/{rid}/commit", {"message": "four sales"})
    head = alice.get(f"/datasets/{rid}")["metadata"]["head"]
    spec = {
        "operators": [
            w.scan(f"{ds['metadata']['uri']}@{head}/files/sales.csv"),
            {"operatorID": "avg", "operatorType": "Aggregate", "viewResult": True,
             "operatorProperties": {"groupByKeys": ["city"], "aggregations": [
                 {"aggFunction": "average", "attribute": "sales", "result attribute": "mean"},
                 {"aggFunction": "count", "attribute": "sales", "result attribute": "n"}]}},
        ],
        "links": [w.link("scan", "avg")],
    }
    wf = alice.create("workflows", "mean sales by city", spec, project=project)
    run = w.run(alice, wf["metadata"]["rid"], "two stages", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)

    page = w.rows(alice, wf["metadata"]["rid"], run["metadata"]["rid"])
    by_city = {r[w.column(page, "city")]: (r[w.column(page, "mean")], r[w.column(page, "n")]) for r in page["rows"]}
    assert by_city == {"Irvine": (30.0, 3), "Davis": (5.0, 1)}, by_city
