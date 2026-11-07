"""A run reads what an earlier run of the same work stored instead of making it again. The
costly step, a team's function, runs once: a second run reads its rows from the first and does
not scan the file, changing the last step makes only that step again, and a fresh run makes
everything. The rows are the same each way. A function that draws at random says so, and runs
again every time."""
import time

from texera_e2e import workflows as w

SLOW = '''import time

import pandas as pd


@returns(patient_id=str, readings=int, mean_glucose=float)
def slow_summary(readings: pd.DataFrame, *, pause: float = 4.0) -> pd.DataFrame:
    """Readings and mean glucose per patient, after a pause that stands for costly work."""
    time.sleep(pause)
    g = readings.groupby("patient_id")["glucose"]
    return pd.DataFrame({"readings": g.size(), "mean_glucose": g.mean()}).reset_index()
'''


SAMPLED = '''import pandas as pd


@returns(patient_id=str, glucose=float, nondeterministic=True)
def some_readings(readings: pd.DataFrame, *, n: int = 10) -> pd.DataFrame:
    """Readings drawn at random, so each run may draw others."""
    return readings.sample(n=n)[["patient_id", "glucose"]].astype({"glucose": float})
'''


def readings_csv() -> bytes:
    lines = ["patient_id,taken_at,glucose"]
    for p in range(5):
        for k in range(12):
            lines.append(f"P-{p + 1},2026-11-01 {k:02d}:00:00,{70 + (p * 31 + k * 13) % 150}")
    return ("\n".join(lines) + "\n").encode()


def op(opid, op_type, **settings):
    return {"operatorID": opid, "operatorType": op_type, "operatorProperties": settings}


def link(src, dst):
    return {"linkID": f"{src}-{dst}", "source": {"operatorID": src, "portID": "output-0"}, "target": {"operatorID": dst, "portID": "input-0"}}


def timed_run(api, rid, unit, **more):
    began = time.monotonic()
    run = w.run(api, rid, "reuse", computingUnit=unit, **more)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    return run, time.monotonic() - began


def rows_of(api, rid, run):
    page = w.rows(api, rid, run["metadata"]["rid"], opid="top", limit=20)
    return sorted(tuple(r) for r in page["rows"])


def test_a_run_reads_the_costly_rows_an_earlier_run_stored(alice, project, unit):
    ds = alice.create("datasets", "cgm", {"format": "csv"}, project=project)
    alice.upload(f"/datasets/{ds['metadata']['rid']}/files/cgm.csv", readings_csv())
    alice.post(f"/datasets/{ds['metadata']['rid']}/commit", {})
    file = f"{ds['metadata']['uri']}@1/files/cgm.csv"
    summary = alice.create("operators", "slow summary", {"implementation": {"python": {"code": SLOW, "function": "slow_summary"}}}, project=project)
    spec = {
        "operators": [op("readings", "scan", file=file), op("summary", f"{summary['metadata']['uri']}@1", by=["patient_id"]), op("top", "filter", where="mean_glucose > 120")],
        "links": [link("readings", "summary"), link("summary", "top")],
    }
    rid = alice.create("workflows", "reuse", spec, project=project)["metadata"]["rid"]

    first, slow = timed_run(alice, rid, unit)
    assert "reused" not in first["spec"]
    second, quick = timed_run(alice, rid, unit)
    first_port = f"{first['metadata']['uri']}/operators/summary/ports/output-0"
    assert second["spec"]["reused"] == [{"operatorID": "summary", "portID": "output-0", "from": first_port}], second["spec"].get("reused")
    assert second["spec"]["skipped"] == ["readings"]
    assert rows_of(alice, rid, second) == rows_of(alice, rid, first)
    assert quick < slow - 2, f"the second run took {quick:.1f}s, the first {slow:.1f}s: the 4s function ran again"
    up = alice.get(f"/resources/{second['metadata']['rid']}/lineage?direction=upstream")
    assert any(e["relation"] == "reused" and e["to"] == first_port for e in up["edges"]), up["edges"]

    # The last step changed: only it runs, reading the function's rows from the first run.
    spec["operators"][2] = op("top", "filter", where="mean_glucose > 100")
    alice.call("PUT", f"/workflows/{rid}", {"spec": spec, "message": "a lower bar"})
    third, _ = timed_run(alice, rid, unit)
    assert [r["from"] for r in third["spec"].get("reused", [])] == [first_port]

    # Fresh makes everything again, and gives the same rows.
    fresh, _ = timed_run(alice, rid, unit, fresh=True)
    assert "reused" not in fresh["spec"] and "skipped" not in fresh["spec"]
    assert rows_of(alice, rid, fresh) == rows_of(alice, rid, third)


def test_a_function_that_draws_at_random_runs_again_every_time(alice, project, unit):
    ds = alice.create("datasets", "cgm", {"format": "csv"}, project=project)
    alice.upload(f"/datasets/{ds['metadata']['rid']}/files/cgm.csv", readings_csv())
    alice.post(f"/datasets/{ds['metadata']['rid']}/commit", {})
    draw = alice.create("operators", "some readings", {"implementation": {"python": {"code": SAMPLED, "function": "some_readings"}}}, project=project)
    assert draw["spec"]["implementation"]["python"]["nondeterministic"] is True
    spec = {
        "operators": [
            op("readings", "scan", file=f"{ds['metadata']['uri']}@1/files/cgm.csv"),
            op("draw", f"{draw['metadata']['uri']}@1", n=10),
            op("top", "aggregate", by=["patient_id"], outputs=["n = count(*)"]),
        ],
        "links": [link("readings", "draw"), link("draw", "top")],
    }
    rid = alice.create("workflows", "draws", spec, project=project)["metadata"]["rid"]

    first, _ = timed_run(alice, rid, unit)
    second, _ = timed_run(alice, rid, unit)
    # Neither the draw nor the aggregate after it is read from the first run.
    assert "reused" not in second["spec"] and "skipped" not in second["spec"], second["spec"]
    assert sum(n for _, n in rows_of(alice, rid, first)) == sum(n for _, n in rows_of(alice, rid, second)) == 10
