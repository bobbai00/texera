"""A Python function is an operator. A team saves one; the catalog reads its inputs, settings and
columns from its code; a workflow calls it with its settings and `by`, and it runs on the unit's
Python workers with each patient's rows whole on one worker, giving what pandas gives. What it
returns against its @returns fails the run, naming both; a `by` column that is not there is a
mistake before anything runs."""
import io
import math

import pandas as pd

from texera_e2e import workflows as w

CGM_METRICS = '''import pandas as pd

@returns(patient_id=str, readings=int, mean_glucose=float, time_in_range=float, cv=float)
def cgm_metrics(readings: pd.DataFrame, *, low: int = 70, high: int = 180) -> pd.DataFrame:
    """Readings, mean glucose, time in range and the coefficient of variation, one row per patient."""
    g = readings.groupby("patient_id")["glucose"]
    return pd.DataFrame({
        "readings": g.size(),
        "mean_glucose": g.mean(),
        "time_in_range": g.apply(lambda s: s.between(low, high).mean()),
        "cv": g.std() / g.mean(),
    }).reset_index()
'''


def readings_csv() -> bytes:
    """Eight patients, a day of readings every half hour, glucose from a fixed pattern."""
    lines = ["patient_id,taken_at,glucose"]
    for p in range(8):
        for k in range(48):
            glucose = 60 + (p * 23 + k * 17) % 160 + (15 if k % 6 == 0 else 0)
            lines.append(f"P-{p + 1},2026-11-01 {k // 2:02d}:{30 * (k % 2):02d}:00,{glucose}")
    return ("\n".join(lines) + "\n").encode()


def dataset(api, project, name, data):
    ds = api.create("datasets", name, {"format": "csv"}, project=project)
    rid = ds["metadata"]["rid"]
    api.upload(f"/datasets/{rid}/files/{name}.csv", data)
    api.post(f"/datasets/{rid}/commit", {"message": name})
    return f"{ds['metadata']['uri']}@1/files/{name}.csv"


def function_operator(api, project, name, code, function):
    return api.create("operators", name, {"implementation": {"python": {"code": code, "function": function}}}, project=project)


def op(opid, op_type, **settings):
    return {"operatorID": opid, "operatorType": op_type, "operatorProperties": settings}


def link(src, dst, lid):
    return {"linkID": lid, "source": {"operatorID": src, "portID": "output-0"}, "target": {"operatorID": dst, "portID": "input-0"}}


def metrics_workflow(api, project, file_uri, operator_uri, **settings):
    spec = {
        "operators": [op("readings", "scan", file=file_uri), op("metrics", operator_uri, **settings), op("ranked", "sort", by=["patient_id"])],
        "links": [link("readings", "metrics", "l1"), link("metrics", "ranked", "l2")],
    }
    return api.create("workflows", "cgm metrics", spec, project=project)["metadata"]["rid"]


def test_a_function_runs_on_python_workers_by_patient_and_gives_what_pandas_gives(alice, project, unit):
    data = readings_csv()
    operator = function_operator(alice, project, "CGM metrics", CGM_METRICS, "cgm_metrics")
    assert operator["spec"]["operatorType"] == "cgm_metrics"
    assert operator["spec"]["description"].startswith("Readings, mean glucose")
    assert set(operator["spec"]["propertiesSchema"]["properties"]) == {"by", "low", "high"}

    rid = metrics_workflow(alice, project, dataset(alice, project, "cgm", data), f"{operator['metadata']['uri']}@1", by=["patient_id"], low=80)
    checked = alice.post(f"/workflows/{rid}/validate", {})
    assert checked["ok"], checked["operatorErrors"]
    assert [(a["attributeName"], a["attributeType"]) for a in checked["operatorOutputSchemas"]["metrics"]["output-0"]] == [
        ("patient_id", "string"), ("readings", "long"), ("mean_glucose", "double"), ("time_in_range", "double"), ("cv", "double"),
    ]

    run = w.run(alice, rid, "metrics", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    page = w.rows(alice, rid, run["metadata"]["rid"], opid="ranked", limit=20)
    got = {r[w.column(page, "patient_id")]: [r[w.column(page, c)] for c in ["readings", "mean_glucose", "time_in_range", "cv"]] for r in page["rows"]}

    frame = pd.read_csv(io.BytesIO(data))
    g = frame.groupby("patient_id")["glucose"]
    want = {pid: [len(s), s.mean(), s.between(80, 180).mean(), s.std() / s.mean()] for pid, s in g}
    assert set(got) == set(want) and len(got) == 8
    for pid, values in want.items():
        assert got[pid][0] == values[0]
        assert all(math.isclose(a, b, rel_tol=1e-9) for a, b in zip(got[pid][1:], values[1:])), (pid, got[pid], values)


def test_a_function_returning_other_columns_fails_the_run_naming_both(alice, project, unit):
    code = '''@returns(patient_id=str, n=int)
def count_readings(readings):
    return readings.groupby("patient_id").size().rename("count").reset_index()
'''
    operator = function_operator(alice, project, "count", code, "count_readings")
    rid = metrics_workflow(alice, project, dataset(alice, project, "cgm", readings_csv()), f"{operator['metadata']['uri']}@1")
    run = w.run(alice, rid, "wrong columns", computingUnit=unit)
    assert run["status"]["phase"] == "failed"
    message = (run["status"].get("error") or {}).get("message", "")
    assert "count_readings returned the columns ['patient_id', 'count'], but its @returns declares ['patient_id', 'n']" in message, w.error_text(run)


def test_a_by_column_that_is_not_there_is_said_before_anything_runs(alice, project, unit):
    operator = function_operator(alice, project, "CGM metrics", CGM_METRICS, "cgm_metrics")
    rid = metrics_workflow(alice, project, dataset(alice, project, "cgm", readings_csv()), f"{operator['metadata']['uri']}@1", by=["patient"])
    checked = alice.post(f"/workflows/{rid}/validate", {})
    assert not checked["ok"]
    assert 'by: the input has no column "patient"; did you mean "patient_id"?' in str(checked["operatorErrors"]["metrics"])
