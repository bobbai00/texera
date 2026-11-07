"""The built-in operators in the engine: a workflow's lines name them with flat settings,
`filter(readings, where="hour(taken_at) >= 22")`, and they run on the unit like any other
operator. A mistake is reported before anything runs, naming the setting and the column."""
from texera_e2e import workflows as w

READINGS = b"""patient_id,taken_at,glucose
P-1,2026-11-01 23:30:00,64
P-1,2026-11-02 02:15:00,58
P-1,2026-11-02 12:00:00,140
P-2,2026-11-01 22:10:00,181
P-2,2026-11-02 03:40:00,170
P-3,2026-11-02 01:05:00,99
"""
LABS = b"""patient_id,a1c,insulin
P-1,7.4,true
P-2,8.9,true
P-3,5.6,false
"""


def dataset(api, project, name, data):
    ds = api.create("datasets", name, {"format": "csv"}, project=project)
    rid = ds["metadata"]["rid"]
    api.upload(f"/datasets/{rid}/files/{name}.csv", data)
    api.post(f"/datasets/{rid}/commit", {"message": name})
    head = api.get(f"/datasets/{rid}")["metadata"]["head"]
    return f"{ds['metadata']['uri']}@{head}/files/{name}.csv"


def op(opid, op_type, **settings):
    return {"operatorID": opid, "operatorType": op_type, "operatorProperties": settings}


def link(src, dst, lid, port="input-0"):
    return {"linkID": lid, "source": {"operatorID": src, "portID": "output-0"}, "target": {"operatorID": dst, "portID": port}}


def overnight(readings, labs, where="hour(taken_at) >= 22 or hour(taken_at) < 6"):
    """Each patient's overnight lows, with their A1c, highest risk first."""
    ops = [
        op("readings", "scan", file=readings),
        op("labs", "scan", file=labs),
        op("night", "filter", where=where),
        op("mmol", "compute", columns=["mmol = round(glucose / 18.016, 2)"]),
        op("lows", "aggregate", by=["patient_id"], outputs=["readings = count(*)", "lows = count_if(glucose < 70)", "mean = round(avg(glucose), 1)"]),
        op("risk", "join", on=["patient_id"], how="inner"),
        op("ranked", "sort", by=["lows desc", "patient_id"]),
        op("top", "limit", n=2),
    ]
    ops[-1]["viewResult"] = True
    links = [
        link("readings", "night", "l1"),
        link("night", "mmol", "l2"),
        link("mmol", "lows", "l3"),
        link("lows", "risk", "l4", "input-0"),
        link("labs", "risk", "l5", "input-1"),
        link("risk", "ranked", "l6"),
        link("ranked", "top", "l7"),
    ]
    return {"operators": ops, "links": links}


def test_the_built_ins_run_in_the_engine_and_give_the_right_rows(alice, project, unit):
    spec = overnight(dataset(alice, project, "readings", READINGS), dataset(alice, project, "labs", LABS))
    wf = alice.create("workflows", "overnight lows", spec, project=project)
    rid = wf["metadata"]["rid"]

    checked = alice.post(f"/workflows/{rid}/validate", {})
    assert checked["ok"], checked["operatorErrors"]
    columns = [a["attributeName"] for a in checked["operatorOutputSchemas"]["top"]["output-0"]]
    assert columns == ["patient_id", "readings", "lows", "mean", "a1c", "insulin"]

    run = w.run(alice, rid, "built-ins", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    page = w.rows(alice, rid, run["metadata"]["rid"], opid="top")
    got = [[r[w.column(page, c)] for c in ["patient_id", "readings", "lows", "mean", "a1c"]] for r in page["rows"]]
    # Overnight: P-1 has 64 and 58 (two lows), P-2 181 and 170, P-3 99; the top two by lows.
    assert got == [["P-1", 2, 2, 61.0, 7.4], ["P-2", 2, 0, 175.5, 8.9]], got


def test_a_mistake_names_the_setting_and_the_closest_column_before_anything_runs(alice, project, unit):
    spec = overnight(dataset(alice, project, "readings", READINGS), dataset(alice, project, "labs", LABS), where="hour(taken) >= 22")
    wf = alice.create("workflows", "a typo", spec, project=project)
    checked = alice.post(f"/workflows/{wf['metadata']['rid']}/validate", {})
    assert not checked["ok"]
    assert 'where: the input has no column "taken"; did you mean "taken_at"?' in str(checked["operatorErrors"]["night"]), checked["operatorErrors"]
