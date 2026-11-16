"""The e2e scenarios. Each one builds a workflow, runs it through the transport,
and records named checks; any exception fails the scenario with its trace.

Expected values are computed here from the same CSV files that were uploaded
(driver/data), independently of Texera, so a check compares Texera's answer with
a plain-Python one.
"""

from __future__ import annotations

import csv
import io
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable

from texera_api import TexeraApi
from transport import RunFailed, RunHandle, RunTimeout, Transport, console_type
from workflow import (Workflow, aggregate, csv_scan, filter_op, hash_join, projection,
                      python_udf, sort_op)

STATUS_COMPLETED, STATUS_KILLED = 3, 5


# ------------------------------------------------------------------- records


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""


@dataclass
class ScenarioRecord:
    key: str
    name: str
    title: str
    outcome: str = "NOT RUN"
    duration_s: float = 0.0
    checks: list[Check] = field(default_factory=list)
    wid: int | None = None
    eid: int | None = None
    run: dict | None = None
    persisted: dict | None = None
    error: str | None = None

    def to_json(self) -> dict:
        return {
            "key": self.key, "name": self.name, "title": self.title, "outcome": self.outcome,
            "duration_s": round(self.duration_s, 1),
            "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in self.checks],
            "wid": self.wid, "eid": self.eid, "persisted_execution": self.persisted,
            "run": self.run, "error": self.error,
        }


class Ctx:
    def __init__(self, api: TexeraApi, transport: Transport, *, run_id: str, cuid: int,
                 whid: int | None, paths: dict[str, str], data_dir, timeout: float,
                 log: Callable[[str], None]):
        self.api, self.transport = api, transport
        self.run_id, self.cuid, self.whid = run_id, cuid, whid
        self.paths, self.timeout, self.log = paths, timeout, log
        self.data = {name: list(csv.DictReader(io.StringIO((data_dir / name).read_text())))
                     for name in paths}
        self.rec: ScenarioRecord | None = None
        self.handles: list[RunHandle] = []

    def check(self, name: str, ok: bool, detail: Any = "") -> bool:
        detail = detail if isinstance(detail, str) else repr(detail)
        self.rec.checks.append(Check(name, bool(ok), detail[:2000]))
        self.log(f"  [{'ok' if ok else 'FAIL'}] {name}{'' if ok else ' -- ' + detail[:400]}")
        return bool(ok)

    def workflow(self, key: str) -> Workflow:
        return Workflow(f"sce-e2e {self.run_id} {key}")

    def start(self, wf: Workflow, view: list[str]) -> RunHandle:
        wid = self.api.create_workflow(wf.name, wf.ui_content())
        self.rec.wid = wid
        self.log(f"  workflow {wid} '{wf.name}' created; starting run on unit {self.cuid}")
        handle = self.transport.start_run(
            wid=wid, cuid=self.cuid, warehouse_id=self.whid,
            logical_plan=wf.logical_plan(view), execution_name=f"{wf.name}",
        )
        self.handles.append(handle)
        return handle

    def persisted_status(self, want: int) -> None:
        entry = self.api.wait_execution_status(self.rec.wid, want, timeout=30)
        if entry:
            self.rec.eid = entry.get("eId")
            self.rec.persisted = {k: entry.get(k) for k in ("eId", "vId", "cuId", "whId", "status",
                                                             "result", "name")}
        self.check(f"persisted execution status is {want}",
                   bool(entry) and entry.get("status") == want,
                   f"GET /api/executions/{self.rec.wid}/latest -> {self.rec.persisted}")


# ----------------------------------------------------------------- comparing


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def same(a: Any, b: Any) -> bool:
    """Numbers compare with a 1e-9 relative tolerance: tight enough that "exact
    rows" means exact (1e-6 let a sum of 320000.5 be off by 0.3), loose enough for
    float summation order. The data's fractions (.25, .5, .75) are exact in binary
    floating point, so the expected sums are exact anyway. Column types are checked
    separately, so 3 vs 3.0 passing here is fine."""
    na, nb = _num(a), _num(b)
    if na is not None and nb is not None:
        return abs(na - nb) <= 1e-9 * max(1.0, abs(nb))
    return a == b


def row_matches(actual: dict, expected: dict) -> bool:
    return set(actual) == set(expected) and all(same(actual[k], expected[k]) for k in expected)


def diff_rows(actual: list[dict], expected: list[dict], ordered: bool) -> str:
    if ordered:
        bad = [(i, a, e) for i, (a, e) in enumerate(zip(actual, expected)) if not row_matches(a, e)]
        extra = f"; lengths {len(actual)} vs {len(expected)}" if len(actual) != len(expected) else ""
        return f"first mismatches (index, actual, expected): {bad[:3]}{extra}" if bad or extra else ""
    unmatched = list(actual)
    missing = []
    for e in expected:
        for i, a in enumerate(unmatched):
            if row_matches(a, e):
                unmatched.pop(i)
                break
        else:
            missing.append(e)
    if missing or unmatched:
        return f"missing {missing[:5]}; unexpected {unmatched[:5]}"
    return ""


def run_to_completion(ctx: Ctx, wf: Workflow, sink: str) -> tuple[RunHandle, dict]:
    handle = ctx.start(wf, view=[sink])
    try:
        state = handle.wait_for_state("Completed", timeout=ctx.timeout)
    except (RunFailed, RunTimeout) as e:
        ctx.check("run completed", False, str(e))
        raise
    ctx.check("run completed", state == "Completed", f"states {handle.states}")
    ctx.check("no fatal errors", not handle.fatal_errors,
              [e.get("message") for e in handle.fatal_errors][:3])
    res = handle.results(sink)
    ctx.log(f"  read {len(res['rows'])} result rows of {sink} in {res['pages']} page(s); "
            f"columns {res['columns']}")
    return handle, res


def check_columns(ctx: Ctx, res: dict, names: list[str], types: list[str] | None = None) -> None:
    got_names = [c for c, _ in res["columns"]]
    ctx.check("result columns", got_names == names, f"got {got_names}, want {names}")
    if types is not None:
        got_types = [t for _, t in res["columns"]]
        ctx.check("result column types", got_types == types, f"got {got_types}, want {types}")


# ----------------------------------------------------------------- scenarios


def scenario_a(ctx: Ctx) -> None:
    """CSV scan -> Filter(age > 30) -> Projection(dept AS department, salary)
    -> Aggregate(group by department: sum(salary) AS total_salary, count(salary) AS n)."""
    people = ctx.data["people.csv"]
    groups: dict[str, dict] = {}
    passed = [p for p in people if int(p["age"]) > 30]
    for p in passed:
        g = groups.setdefault(p["dept"], {"department": p["dept"], "total_salary": 0.0, "n": 0})
        g["total_salary"] += float(p["salary"])
        g["n"] += 1
    expected = sorted(groups.values(), key=lambda r: r["department"])

    wf = ctx.workflow("a-filter-project-aggregate")
    scan = wf.add("people", "CSVFileScan", csv_scan(ctx.paths["people.csv"]), n_in=0)
    flt = wf.add("age-over-30", "Filter", filter_op(("age", ">", "30")))
    prj = wf.add("dept-salary", "Projection", projection(("dept", "department"), ("salary", "")))
    agg = wf.add("by-department", "Aggregate",
                 aggregate(["department"], ("sum", "salary", "total_salary"), ("count", "salary", "n")))
    wf.link(scan, flt)
    wf.link(flt, prj)
    wf.link(prj, agg)

    handle, res = run_to_completion(ctx, wf, agg)
    rows = sorted(res["rows"], key=lambda r: str(r.get("department")))
    check_columns(ctx, res, ["department", "total_salary", "n"], ["string", "double", "integer"])
    ctx.check("row count", len(rows) == len(expected), f"got {len(rows)}, want {len(expected)}")
    d = diff_rows(rows, expected, ordered=True)
    ctx.check("exact rows", not d, d or f"{rows}")
    try:
        handle.wait_until(lambda: handle.output_rows(flt) == len(passed), 15, "final Filter statistics")
    except Exception:
        pass
    ctx.check("operator statistics: Filter emitted the rows with age > 30",
              handle.output_rows(flt) == len(passed),
              f"Filter output rows {handle.output_rows(flt)}, want {len(passed)}; "
              f"scan output {handle.output_rows(scan)}")
    ctx.persisted_status(STATUS_COMPLETED)


UDF_ADD_COLUMNS = '''from pytexera import *


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["name_upper"] = tuple_["name"].upper()
        tuple_["age_plus_10"] = tuple_["age"] + 10
        yield tuple_
'''


def scenario_b(ctx: Ctx) -> None:
    """CSV scan -> Python UDF (V2) adding name_upper and age_plus_10."""
    people = ctx.data["people.csv"]
    expected = [
        {"id": int(p["id"]), "name": p["name"], "dept": p["dept"], "age": int(p["age"]),
         "salary": float(p["salary"]), "name_upper": p["name"].upper(), "age_plus_10": int(p["age"]) + 10}
        for p in people
    ]
    wf = ctx.workflow("b-python-udf-column")
    scan = wf.add("people", "CSVFileScan", csv_scan(ctx.paths["people.csv"]), n_in=0)
    udf = wf.add("add-columns", "PythonUDFV2",
                 python_udf(UDF_ADD_COLUMNS, out_columns=[("name_upper", "string"), ("age_plus_10", "integer")]))
    wf.link(scan, udf)

    handle, res = run_to_completion(ctx, wf, udf)
    rows = sorted(res["rows"], key=lambda r: int(r.get("id", 0)))
    check_columns(ctx, res, ["id", "name", "dept", "age", "salary", "name_upper", "age_plus_10"],
                  ["integer", "string", "string", "integer", "double", "string", "integer"])
    ctx.check("row count", len(rows) == len(expected), f"got {len(rows)}, want {len(expected)}")
    d = diff_rows(rows, expected, ordered=True)
    ctx.check("UDF column values", not d, d or "")
    ctx.persisted_status(STATUS_COMPLETED)


def scenario_c(ctx: Ctx) -> None:
    """Two CSV sources -> HashJoin(depts.dept_id = people.dept) -> Sort(age DESC)."""
    depts = {d["dept_id"]: d for d in ctx.data["depts.csv"]}
    joined = []
    for p in ctx.data["people.csv"]:
        d = depts.get(p["dept"])
        if d:
            joined.append({"dept_id": d["dept_id"], "dept_name": d["dept_name"], "floor": int(d["floor"]),
                           "id": int(p["id"]), "name": p["name"], "age": int(p["age"]),
                           "salary": float(p["salary"])})
    expected = sorted(joined, key=lambda r: -r["age"])

    wf = ctx.workflow("c-join-sort")
    dsrc = wf.add("depts", "CSVFileScan", csv_scan(ctx.paths["depts.csv"]), n_in=0)
    psrc = wf.add("people", "CSVFileScan", csv_scan(ctx.paths["people.csv"]), n_in=0)
    join = wf.add("join-dept", "HashJoin", hash_join("dept_id", "dept"), n_in=2,
                  in_names=["left", "right"])
    srt = wf.add("age-desc", "Sort", sort_op(("age", "DESC")))
    wf.link(dsrc, join, 0, 0)  # build side
    wf.link(psrc, join, 0, 1)  # probe side
    wf.link(join, srt)

    handle, res = run_to_completion(ctx, wf, srt)
    rows = res["rows"]
    check_columns(ctx, res, ["dept_id", "dept_name", "floor", "id", "name", "age", "salary"],
                  ["string", "string", "integer", "integer", "string", "integer", "double"])
    ctx.check("row count (inner join drops ops and fin)", len(rows) == len(expected),
              f"got {len(rows)}, want {len(expected)}")
    d = diff_rows(rows, expected, ordered=True)
    ctx.check("exact rows in age-descending order", not d,
              d or "")
    ctx.persisted_status(STATUS_COMPLETED)


SLOW_UDF_SLEEP_S = 0.2
PAUSE_HOLD_S = 5.0
UDF_SLOW = f'''from pytexera import *
import time


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        time.sleep({SLOW_UDF_SLEEP_S})
        yield tuple_
'''


def is_subsequence(needle: list[str], hay: list[str]) -> bool:
    it = iter(hay)
    return all(any(x == y for y in it) for x in needle)


def scenario_d(ctx: Ctx) -> None:
    """A slow Python UDF (0.2 s per tuple over 300 rows): pause, hold, resume, kill."""
    total = len(ctx.data["numbers.csv"])
    wf = ctx.workflow("d-pause-resume-kill")
    scan = wf.add("numbers", "CSVFileScan", csv_scan(ctx.paths["numbers.csv"]), n_in=0)
    udf = wf.add("slow-udf", "PythonUDFV2", python_udf(UDF_SLOW))
    wf.link(scan, udf)

    handle = ctx.start(wf, view=[udf])
    handle.wait_for_state("Running", timeout=ctx.timeout)
    ctx.check("reached Running", True, "")

    handle.wait_until(lambda: handle.output_rows(udf) >= 3, ctx.timeout, "the UDF to emit 3 rows")
    ctx.check("UDF makes progress before pause", handle.output_rows(udf) >= 3,
              f"output rows {handle.output_rows(udf)}")

    handle.pause()
    paused = handle.wait_for_state("Paused", timeout=120)
    ctx.check("pause -> Paused", paused == "Paused", f"states {handle.states}")
    at_pause = handle.output_rows(udf)
    time.sleep(PAUSE_HOLD_S)
    after_hold = handle.output_rows(udf)
    # Weak on its own: the coordinator stops its periodic statistics for the whole
    # pause (PauseHandler), so normally nothing new arrives during the hold and this
    # compares a value with itself. The post-resume bound further down is the check
    # that catches work done while paused.
    ctx.check("no progress reported while paused (5 s hold)", after_hold - at_pause <= 1,
              f"output rows {at_pause} -> {after_hold} (statistics are normally not sent "
              f"while paused; see the post-resume bound)")
    ctx.check("still Paused after the hold", handle.last_state == "Paused", f"last {handle.last_state}")

    t_resume = time.monotonic()
    handle.resume()
    resumed = handle.wait_for_state("Running", timeout=120)
    ctx.check("resume -> Running", resumed == "Running", f"states {handle.states}")
    handle.wait_until(lambda: handle.output_rows(udf) >= after_hold + 3, 120,
                      "the UDF to make progress after resume")
    ctx.check("progress after resume", handle.output_rows(udf) >= after_hold + 3,
              f"output rows {after_hold} -> {handle.output_rows(udf)}")

    handle.kill()
    killed = handle.wait_for_state("Killed", timeout=120)
    t_killed = time.monotonic()
    ctx.check("kill -> Killed", killed == "Killed", f"states {handle.states}")
    states = handle.states
    ctx.check("state sequence Running, Paused, Running, Killed (in order)",
              is_subsequence(["Running", "Paused", "Running", "Killed"], states), f"states {states}")
    ctx.check("transitional states Pausing and Resuming reported",
              "Pausing" in states and "Resuming" in states, f"states {states}")
    ctx.check("killed before finishing (never Completed)",
              "Completed" not in states and handle.output_rows(udf) < total,
              f"states {states}; output rows {handle.output_rows(udf)} of {total}")

    # The decisive pause check. The coordinator sends no statistics while paused,
    # and the resume only re-sends the figures cached at the pause, so work done
    # during the hold first shows up in the periodic updates after resume. Each
    # tuple sleeps >= SLOW_UDF_SLEEP_S, so from the resume request until Killed
    # arrived the UDF can emit at most window / sleep rows (+2: a tuple in flight
    # at the pause, and rounding). A worker that kept running through the hold
    # adds ~PAUSE_HOLD_S / SLOW_UDF_SLEEP_S = 25 rows on top, which this catches
    # however long the run took to initialize. Both times are taken on this
    # process's clock around the calls, so the window can only be overestimated,
    # and the check needs no transport-specific command labels.
    final_rows = handle.output_rows(udf)
    window = t_killed - t_resume
    bound = int(window / SLOW_UDF_SLEEP_S) + 2
    ctx.check("no work done during the pause (rows after resume <= time since resume / sleep)",
              final_rows - after_hold <= bound,
              f"{final_rows - after_hold} rows after the pause ({after_hold} -> {final_rows}) in "
              f"{window:.2f}s from resume to Killed; at most {bound} possible at "
              f"{SLOW_UDF_SLEEP_S}s per tuple; working through the {PAUSE_HOLD_S:.0f}s hold "
              f"would add about {int(PAUSE_HOLD_S / SLOW_UDF_SLEEP_S)}")
    ctx.check("no fatal errors", not handle.fatal_errors,
              [e.get("message") for e in handle.fatal_errors][:3])
    ctx.persisted_status(STATUS_KILLED)


UDF_PRINT = '''from pytexera import *


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        print(f"sce-e2e console: {tuple_['name']} is {tuple_['age']}")
        yield tuple_
'''


def scenario_e(ctx: Ctx) -> None:
    """CSV scan -> Python UDF that prints one line per tuple; the lines reach the client."""
    people = ctx.data["people.csv"]
    want = [f"sce-e2e console: {p['name']} is {p['age']}" for p in people]
    wf = ctx.workflow("e-console")
    scan = wf.add("people", "CSVFileScan", csv_scan(ctx.paths["people.csv"]), n_in=0)
    udf = wf.add("printer", "PythonUDFV2", python_udf(UDF_PRINT))
    wf.link(scan, udf)

    handle, res = run_to_completion(ctx, wf, udf)
    ctx.check("UDF passed every row through", len(res["rows"]) == len(people),
              f"got {len(res['rows'])}, want {len(people)}")

    def texts() -> list[str]:
        return [f"{m.get('title') or ''}{m.get('message') or ''}" for m in handle.console(udf)]

    def all_seen() -> bool:
        got = texts()
        return all(any(w in t for t in got) for w in want)

    try:
        handle.wait_until(all_seen, 30, "all console lines")
    except Exception:
        pass
    got = texts()
    missing = [w for w in want if not any(w in t for t in got)]
    ctx.check("console lines received over the transport", not missing,
              f"{len(want) - len(missing)}/{len(want)} received; missing {missing[:3]}; "
              f"sample {got[:2]}")
    msgs = handle.console(udf)
    ctx.check("console messages are PRINT, from the UDF operator",
              bool(msgs) and all(console_type(m) == "PRINT" for m in msgs),
              f"types {sorted({console_type(m) for m in msgs})}")
    ctx.persisted_status(STATUS_COMPLETED)


JAVA_UDF_NAME_LENGTH = '''import org.apache.texera.amber.operator.map.MapOpExec;
import org.apache.texera.amber.core.tuple.Tuple;
import org.apache.texera.amber.core.tuple.TupleLike;
import org.apache.texera.amber.core.tuple.TupleLike$;
import scala.Function1;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;

public class JavaUDFOpExec extends MapOpExec {
    public JavaUDFOpExec () {
        this.setMapFunc((Function1<Tuple, TupleLike> & Serializable) this::processTuple);
    }

    public TupleLike processTuple(Tuple tuple) {
        List<Object> fields = new ArrayList<>();
        for (Object f : tuple.getFields()) {
            fields.add(f);
        }
        String name = (String) tuple.getField("name");
        fields.add(name.length());
        return TupleLike$.MODULE$.apply(fields);
    }
}
'''


def scenario_u(ctx: Ctx) -> None:
    """CSV scan -> Java UDF adding name_len. The unit compiles the Java code with javac from
    the plan it reads back, which engine specs under sbt cannot do (javac there sees only the
    sbt launcher)."""
    people = ctx.data["people.csv"]
    expected = [
        {"id": int(p["id"]), "name": p["name"], "dept": p["dept"], "age": int(p["age"]),
         "salary": float(p["salary"]), "name_len": len(p["name"])}
        for p in people
    ]
    wf = ctx.workflow("u-java-udf-column")
    scan = wf.add("people", "CSVFileScan", csv_scan(ctx.paths["people.csv"]), n_in=0)
    udf = wf.add("name-length", "JavaUDF", {
        "code": JAVA_UDF_NAME_LENGTH,
        "workers": 1,
        "retainInputColumns": True,
        "outputColumns": [{"attributeName": "name_len", "attributeType": "integer"}],
    })
    wf.link(scan, udf)

    handle, res = run_to_completion(ctx, wf, udf)
    rows = sorted(res["rows"], key=lambda r: int(r.get("id", 0)))
    check_columns(ctx, res, ["id", "name", "dept", "age", "salary", "name_len"],
                  ["integer", "string", "string", "integer", "double", "integer"])
    ctx.check("row count", len(rows) == len(expected), f"got {len(rows)}, want {len(expected)}")
    d = diff_rows(rows, expected, ordered=True)
    ctx.check("Java UDF column values", not d, d or "")
    ctx.persisted_status(STATUS_COMPLETED)


SCENARIOS: dict[str, tuple[str, str, Callable[[Ctx], None]]] = {
    "a": ("scan-filter-project-aggregate",
          "CSV scan -> Filter -> Projection -> Aggregate; exact grouped rows", scenario_a),
    "b": ("python-udf-column",
          "CSV scan -> Python UDF V2 adding two columns; every value", scenario_b),
    "c": ("join-sort",
          "two CSV sources -> HashJoin -> Sort; exact rows in order", scenario_c),
    "d": ("pause-resume-kill",
          "slow Python UDF; pause, resume and kill; states and progress", scenario_d),
    "e": ("console",
          "Python UDF print() lines arrive as console messages", scenario_e),
    "u": ("java-udf-column",
          "CSV scan -> Java UDF adding a column; every value", scenario_u),
}


def resolve(selection: list[str]) -> list[str]:
    if not selection or selection == ["all"]:
        return list(SCENARIOS)
    by_name = {v[0]: k for k, v in SCENARIOS.items()}
    keys = []
    for item in selection:
        for s in item.split(","):
            s = s.strip()
            if not s:
                continue
            if s == "all":
                keys.extend(SCENARIOS)
            elif s in SCENARIOS:
                keys.append(s)
            elif s in by_name:
                keys.append(by_name[s])
            else:
                raise SystemExit(f"unknown scenario '{s}'; choose from "
                                 + ", ".join(f"{k} ({v[0]})" for k, v in SCENARIOS.items()))
    return list(dict.fromkeys(keys))


def run_scenario(ctx: Ctx, key: str) -> ScenarioRecord:
    name, title, fn = SCENARIOS[key]
    rec = ScenarioRecord(key=key, name=name, title=title)
    ctx.rec = rec
    ctx.handles = []
    t0 = time.monotonic()
    try:
        fn(ctx)
        rec.outcome = "PASS" if rec.checks and all(c.ok for c in rec.checks) else "FAIL"
    except Exception as e:  # noqa: BLE001 -- a scenario failure is data, not a crash
        rec.outcome = "FAIL"
        rec.error = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
        ctx.log(f"  scenario raised {type(e).__name__}: {str(e)[:500]}")
    finally:
        # A failed scenario can leave its run alive on the unit (e.g. a worker paused
        # on an exception); kill it so the next scenario starts on an idle unit.
        for h in ctx.handles:
            final = h.ensure_stopped()
            if rec.outcome != "PASS" and final:
                ctx.log(f"  run of workflow {h.wid} left in state {final}")
        rec.duration_s = time.monotonic() - t0
        if ctx.handles:
            rec.run = ctx.handles[-1].summary()
        for h in ctx.handles:
            h.close()
        if rec.wid and rec.eid is None:
            entry = ctx.api.latest_execution(rec.wid)
            if entry:
                rec.eid = entry.get("eId")
                rec.persisted = {k: entry.get(k) for k in ("eId", "vId", "cuId", "whId", "status",
                                                           "result", "name")}
    return rec
