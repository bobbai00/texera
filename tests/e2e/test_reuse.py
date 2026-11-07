"""A run reads what an earlier run of the same work stored instead of making it again. The
costly step, a team's function, runs once: a second run reads its rows from the first and does
not scan the file, changing the last step makes only that step again, and a fresh run makes
everything. The rows are the same each way."""
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
