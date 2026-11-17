"""The e2e scenarios. Each one builds a workflow, runs it through the transport,
and records named checks; any exception fails the scenario with its trace.

Expected values are computed here from the same CSV files that were uploaded
(driver/data), independently of Texera, so a check compares Texera's answer with
a plain-Python one.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import subprocess
import threading
import time
import traceback
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Callable

import requests

from lake import Label, Lake, TableState
from record_timing import RecordTiming
from texera_api import (REASON_COMPILE_ERROR, REASON_KILLED_BY_USER, REASON_NEVER_STARTED, REASON_UNIT_LOST,
                        REASON_UNIT_STOPPED, ExecutionState, StatisticsRow, TexeraApi, TexeraApiError,
                        history_completion_ms, history_reason)
from transport import (CreateRefused, RunFailed, RunHandle, RunTimeout, Transport, UpdateRefused,
                       console_type, response_body)
from workflow import (Workflow, aggregate, csv_scan, file_lister, file_scan_from_input, filter_op,
                      hash_join, projection, python_udf, sort_op, text_input)

STATUS_READY, STATUS_RUNNING, STATUS_COMPLETED, STATUS_FAILED, STATUS_KILLED = 0, 1, 3, 4, 5
#: an execution that was created and that no unit has started (review fix D1 of step 2,
#: docs/review-step2/x3-report.md: the Dashboard inserts the row as Created, and the unit's
#: first write makes it 0)
STATUS_CREATED = 6
#: udf.python.environments.root's default (design 3.9)
DEFAULT_ENVIRONMENTS_ROOT = "/tmp/texera-python-environments"
#: run by the unit's python3 with the root as argv[1]: one JSON line, every entry but *.lock
LIST_ENVIRONMENTS_PY = r'''
import json, os, sys
root = sys.argv[1]
out = []
for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
    if name.endswith(".lock"):
        continue
    path = os.path.join(root, name)
    marker = None
    f = os.path.join(path, "texera-environment.json")
    if os.path.isfile(f):
        try:
            marker = json.load(open(f))
        except ValueError as e:
            marker = {"unparsable": str(e)}
    out.append({"name": name, "path": path, "dir": os.path.isdir(path), "marker": marker})
print(json.dumps(out))
'''


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
    notes: list[str] = field(default_factory=list)
    #: what the scenario measured, beyond its checks' verdicts (the readings behind a deadline)
    facts: dict = field(default_factory=dict)
    evidence: dict | None = None
    #: under --negative-control the scenario's own checks are information only
    functional_checks: list[Check] | None = None

    def to_json(self) -> dict:
        out = {
            "key": self.key, "name": self.name, "title": self.title, "outcome": self.outcome,
            "duration_s": round(self.duration_s, 1),
            "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in self.checks],
            "wid": self.wid, "eid": self.eid, "persisted_execution": self.persisted,
            "run": self.run, "error": self.error,
        }
        if self.notes:
            out["notes"] = self.notes
        if self.facts:
            out["facts"] = self.facts
        if self.functional_checks is not None:
            out["functional_checks"] = [{"name": c.name, "ok": c.ok, "detail": c.detail}
                                        for c in self.functional_checks]
        if self.evidence is not None:
            out["evidence"] = self.evidence
        return out


@dataclass
class OtherUser:
    """The second user (sce-e2e-other) with its own local unit and warehouse."""

    api: TexeraApi
    cuid: int
    whid: int | None
    warehouse_name: str | None


class Ctx:
    def __init__(self, api: TexeraApi, transport: Transport, *, run_id: str, cuid: int,
                 whid: int | None, paths: dict[str, str], data_dir, timeout: float,
                 log: Callable[[str], None], transport_name: str = "ws", evidence: Any = None,
                 dataset: dict | None = None, warehouse_name: str | None = None,
                 unit_container: str = "sce-workflow-runtime-coordinator-service",
                 with_replay_log: bool = False, other: OtherUser | None = None,
                 unit2_cuid: int | None = None, unit_uri: str = "",
                 unit_exec_prefix: Callable[[bool], list[str]] | None = None,
                 timing: RecordTiming | None = None, lake: Lake | None = None, level: str | None = None,
                 stack: Any = None, stats_through_unit: bool = False):
        self.api, self.transport = api, transport
        self.run_id, self.cuid, self.whid = run_id, cuid, whid
        self.paths, self.timeout, self.log = paths, timeout, log
        self.data = {name: list(csv.DictReader(io.StringIO((data_dir / name).read_text())))
                     for name in paths}
        self.data_bytes = {name: (data_dir / name).read_bytes() for name in paths}
        self.rec: ScenarioRecord | None = None
        self.handles: list[RunHandle] = []
        self.transport_name = transport_name
        self.evidence = evidence
        self.dataset = dataset or {}
        self.warehouse_name = warehouse_name
        self.unit_container = unit_container
        # What goes before a command to run it where the unit runs, given whether the command
        # reads stdin. The single-node stack's is `docker exec` into the unit's container.
        self.unit_exec_prefix = unit_exec_prefix or (
            lambda interactive: ["docker", "exec", *(["-i"] if interactive else []), self.unit_container])
        self.with_replay_log = with_replay_log
        self.other = other
        self.unit2_cuid = unit2_cuid
        self.unit_uri = unit_uri
        # Step 3: the timers the stack was started with, the lake's catalog, and how far
        # the product under test is: the letter of the last step-3 gate it has passed
        # (A, B or C), None for a product of step 2.
        self.timing = timing or RecordTiming()
        self.lake = lake
        self.level = level
        # The stack's control (stack_control.py): how a scenario takes the unit down.
        self.stack = stack
        # Kubernetes before gate 3C: the gateway routes a statistics request to the unit,
        # so stored statistics cannot be asked for while the unit is down.
        self.stats_through_unit = stats_through_unit
        #: while another scenario's body runs as a part of this one: the part's key
        self.part: str | None = None
        #: step 3's negative control: the product is the old one, on purpose
        self.negative_control = False
        self.created_wids: list[int] = []
        self.hex = uuid.uuid4().hex[:8]

    def check(self, name: str, ok: bool, detail: Any = "") -> bool:
        name = f"{self.part}: {name}" if self.part else name
        detail = detail if isinstance(detail, str) else repr(detail)
        self.rec.checks.append(Check(name, bool(ok), detail[:2000]))
        self.log(f"  [{'ok' if ok else 'FAIL'}] {name}{'' if ok else ' -- ' + detail[:400]}")
        return bool(ok)

    def workflow(self, key: str) -> Workflow:
        return Workflow(f"sce-e2e {self.run_id} {key}")

    def note(self, text: str) -> None:
        self.rec.notes.append(text)
        self.log(f"  [note] {text}")

    def create_workflow(self, wf: Workflow, api: TexeraApi | None = None) -> int:
        wid = (api or self.api).create_workflow(wf.name, wf.ui_content())
        self.created_wids.append(wid)
        if self.rec.wid is None:
            self.rec.wid = wid
        return wid

    def start(self, wf: Workflow, view: list[str], *, wid: int | None = None,
              replay_from: dict | None = None, target_operator_ids: list[str] | None = None) -> RunHandle:
        if wid is None:
            wid = self.api.create_workflow(wf.name, wf.ui_content())
            self.created_wids.append(wid)
        self.rec.wid = wid
        self.log(f"  workflow {wid} '{wf.name}' created; starting run on unit {self.cuid}")
        extra: dict[str, Any] = {}
        if replay_from is not None:
            extra["replay_from"] = replay_from
        if target_operator_ids:
            extra["target_operator_ids"] = target_operator_ids
        handle = self.transport.start_run(
            wid=wid, cuid=self.cuid, warehouse_id=self.whid,
            logical_plan=wf.logical_plan(view), execution_name=f"{wf.name}", **extra,
        )
        self.handles.append(handle)
        if handle.eid is not None:
            self.rec.eid = handle.eid
        return handle

    def create(self, wf: Workflow, view: list[str], *, wid: int, api: TexeraApi | None = None,
               cuid: int | None = None, whid: Any = "default", **kw):
        """create-ws only: POST /api/executions without starting; (response, body)."""
        resp = self.transport.create_only(
            api=api, wid=wid, cuid=self.cuid if cuid is None else cuid,
            warehouse_id=self.whid if whid == "default" else whid,
            logical_plan=wf.logical_plan(view), execution_name=wf.name, **kw)
        return resp, response_body(resp)

    def persisted_status(self, want: int, eid: int | None = None) -> None:
        if eid is None:
            entry = self.api.wait_execution_status(self.rec.wid, want, timeout=30)
            where = f"GET /api/executions/{self.rec.wid}/latest"
        else:
            entry = self.api.wait_entry_status(self.rec.wid, eid, want, timeout=30)
            where = f"execution {eid} in GET /api/executions/{self.rec.wid}"
        if entry:
            self.rec.eid = entry.get("eId")
            self.rec.persisted = {k: entry.get(k) for k in ("eId", "vId", "cuId", "whId", "status",
                                                             "result", "name")}
        self.check(f"persisted execution status is {want}",
                   bool(entry) and entry.get("status") == want,
                   f"{where} -> {self.rec.persisted}")

    def expect_no_unit_statement(self, eid: int | None, why: str, since_last_start: bool = False) -> None:
        """Deferred to the evidence (the scenario's end): the unit ran no statement
        about `eid`. Without --evidence it is only noted."""
        if eid is None:
            return
        if self.evidence is None:
            self.note(f"not checked without --evidence: no unit statement for execution {eid} ({why})")
        else:
            self.evidence.expect_no_unit_statement(int(eid), why, since_last_start=since_last_start)

    def allow_status_zero(self, eid: int | None, why: str) -> None:
        if eid is not None and self.evidence is not None:
            self.evidence.allow_status_zero(int(eid), why)

    def expect_unit_silent(self, eid: int | None, why: str) -> None:
        """A refused start (the refusal has arrived and the caller settled): with
        --evidence, the unit ran no statement at all from that start's mark to now."""
        if eid is None:
            return
        if self.evidence is None:
            self.note(f"not checked without --evidence: the unit stays silent after the refused start of "
                      f"execution {eid} ({why})")
        else:
            self.evidence.expect_silent_since_start(int(eid), why)

    def settle_unit(self, why: str, min_wait_s: float = 0.0) -> None:
        """With --evidence: wait until the unit ran no statement for a second (and at
        least `min_wait_s` passed), so what a finished run still writes, or its idle
        cleanup, stays out of the window that follows. Without evidence: nothing."""
        if self.evidence is None:
            return
        out = self.evidence.settle_unit(min_wait_s=min_wait_s)
        self.log(f"  unit settled ({why}): {out}")
        self.rec.notes.append(f"unit settled before {why}: {out}")

    def at_least(self, level: str) -> bool:
        """Whether the product under test has what step 3's gate `level` brings."""
        return self.level is not None and self.level >= level

    @property
    def unstarted_status(self) -> int:
        """What the history reads for an execution nobody started. Step 3 is built on step
        2 with its review fixes, where such an execution is Created (and stays so once the
        status comes from the label: an open execution whose label has no state,
        docs/step3-notes/changes-since-rev2.md section 3). The images of step 2 that gates
        A to D were run on say 0; this is the one place to change when theirs say Created."""
        return STATUS_CREATED if self.level is not None else STATUS_READY

    def statistics(self, wid: int, eid: int) -> list[StatisticsRow]:
        """An execution's stored statistics. Until gate 3C the request names the unit, as
        the browser's does: in Kubernetes the gateway still routes it there."""
        return self.api.execution_statistics(wid, eid, cuid=None if self.at_least("C") else self.cuid)

    def lake_table(self, kind: str, wid: int, eid: int) -> TableState:
        """One of an execution's own tables (`plan`, `log`, `statistics`, `console`) as the
        catalog shows it, in the warehouse this driver's runs use."""
        if self.lake is None:
            raise RuntimeError("this scenario reads the lake's catalog, which this driver was not given")
        return self.lake.table(self.warehouse_name, wid, eid, kind)

    def unit_is_back(self, started: dict) -> None:
        """A unit runs again after a scenario took it down (`started`: what the stack's
        `start_unit` answered). In Kubernetes it is another unit, which the rest of the
        run then uses."""
        if started.get("cuid") is not None:
            self.cuid = int(started["cuid"])
        prefix = self.stack.exec_prefix()
        if prefix is not None:
            self.unit_exec_prefix = prefix
        if self.evidence is not None:
            self.evidence.unit_restarted()
        self.log(f"  the unit is back: {started}")

    def record_left_as_is(self, eid: int | None, label_state: str, why: str) -> None:
        """The unit is about to be taken down under this execution. Check I then expects
        its log's label at `label_state`, the last state the unit records of it, and does
        not count the files of its tables: their last tidy may not have run."""
        if eid is not None and self.evidence is not None:
            self.evidence.record_left_as_is(int(eid), label_state, why)

    def settle_records(self) -> None:
        """With Check I: judge now the record of every run of this scenario that has
        ended, before something changes its tables (see Evidence.settle_records)."""
        if self.evidence is None:
            return
        try:
            self.evidence.settle_records()
        except Exception as e:  # noqa: BLE001 -- Check I then reports what it can still read
            self.log(f"  the records could not be judged now: {type(e).__name__}: {e}")

    def unit_exec(self, *cmd: str, timeout: float = 120, stdin: str | None = None) -> subprocess.CompletedProcess:
        """Run `cmd` where the unit runs (stdout and stderr merged): in its container on the
        single-node stack, in its pod in Kubernetes mode, on this host in local-dev mode."""
        args = [*self.unit_exec_prefix(stdin is not None), *cmd]
        return subprocess.run(args, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, timeout=timeout)

    def environments_root(self) -> str:
        """Where the unit installs Python environments: UDF_PYTHON_ENVIRONMENTS_ROOT in the
        unit's environment, else the design's default (3.9)."""
        if not hasattr(self, "_env_root"):
            p = self.unit_exec("sh", "-c", 'printf %s "${UDF_PYTHON_ENVIRONMENTS_ROOT:-'
                                           + DEFAULT_ENVIRONMENTS_ROOT + '}"')
            root = (p.stdout or "").strip() if p.returncode == 0 else ""
            self._env_root = root or DEFAULT_ENVIRONMENTS_ROOT
        return self._env_root

    def environment_dirs(self) -> list[dict]:
        """Every entry of the environments root except lock files: {name, path, marker}
        with the whole texera-environment.json parsed (None when there is none), read
        by the unit's python3 so a pretty-printed marker parses as well as a compact one."""
        p = self.unit_exec("python3", "-c", LIST_ENVIRONMENTS_PY, self.environments_root())
        try:
            return json.loads((p.stdout or "").strip().splitlines()[-1])
        except (ValueError, IndexError):
            raise RuntimeError(f"could not list {self.environments_root()} on the unit: "
                               f"exit {p.returncode}: {(p.stdout or '')[-300:]}")


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


def poll(probe: Callable[[], Any], accept: Callable[[Any], bool], timeout: float,
         every: float = 0.5) -> tuple[Any, float]:
    """Ask `probe` every `every` seconds until `accept` takes its answer or `timeout`
    seconds passed; (the last answer, the seconds waited)."""
    t0 = time.monotonic()
    while True:
        answer = probe()
        waited = time.monotonic() - t0
        if accept(answer) or waited >= timeout:
            return answer, waited
        time.sleep(min(every, max(0.0, timeout - waited)))


def run_to_completion(ctx: Ctx, wf: Workflow, sink: str, wid: int | None = None) -> tuple[RunHandle, dict]:
    """Run `wf` (as a new workflow, or as another execution of workflow `wid`) until it
    completes, and read its sink's rows."""
    handle = ctx.start(wf, view=[sink], wid=wid)
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


def _workflow_a(ctx: Ctx, key: str = "a-filter-project-aggregate") -> tuple[Workflow, dict[str, str], list[dict], int]:
    """CSV scan -> Filter(age > 30) -> Projection(dept AS department, salary)
    -> Aggregate(group by department: sum(salary) AS total_salary, count(salary) AS n).
    Returns the workflow, its operators' ids by role, the groups it must give, and how
    many rows pass the Filter."""
    people = ctx.data["people.csv"]
    groups: dict[str, dict] = {}
    passed = [p for p in people if int(p["age"]) > 30]
    for p in passed:
        g = groups.setdefault(p["dept"], {"department": p["dept"], "total_salary": 0.0, "n": 0})
        g["total_salary"] += float(p["salary"])
        g["n"] += 1
    expected = sorted(groups.values(), key=lambda r: r["department"])

    wf = ctx.workflow(key)
    scan = wf.add("people", "CSVFileScan", csv_scan(ctx.paths["people.csv"]), n_in=0)
    flt = wf.add("age-over-30", "Filter", filter_op(("age", ">", "30")))
    prj = wf.add("dept-salary", "Projection", projection(("dept", "department"), ("salary", "")))
    agg = wf.add("by-department", "Aggregate",
                 aggregate(["department"], ("sum", "salary", "total_salary"), ("count", "salary", "n")))
    wf.link(scan, flt)
    wf.link(flt, prj)
    wf.link(prj, agg)
    return wf, {"scan": scan, "filter": flt, "projection": prj, "aggregate": agg}, expected, len(passed)


def _check_groups(ctx: Ctx, res: dict, expected: list[dict]) -> None:
    """The rows of a's Aggregate: its three columns and exactly the expected groups."""
    rows = sorted(res["rows"], key=lambda r: str(r.get("department")))
    check_columns(ctx, res, ["department", "total_salary", "n"], ["string", "double", "integer"])
    ctx.check("row count", len(rows) == len(expected), f"got {len(rows)}, want {len(expected)}")
    d = diff_rows(rows, expected, ordered=True)
    ctx.check("exact rows", not d, d or f"{rows}")


def scenario_a(ctx: Ctx) -> dict:
    """CSV scan -> Filter(age > 30) -> Projection(dept AS department, salary)
    -> Aggregate(group by department: sum(salary) AS total_salary, count(salary) AS n)."""
    wf, ops, expected, passed = _workflow_a(ctx)
    flt = ops["filter"]
    handle, res = run_to_completion(ctx, wf, ops["aggregate"])
    _check_groups(ctx, res, expected)
    try:
        handle.wait_until(lambda: handle.output_rows(flt) == passed, 15, "final Filter statistics")
    except Exception:
        pass
    ctx.check("operator statistics: Filter emitted the rows with age > 30",
              handle.output_rows(flt) == passed,
              f"Filter output rows {handle.output_rows(flt)}, want {passed}; "
              f"scan output {handle.output_rows(ops['scan'])}")
    ctx.persisted_status(STATUS_COMPLETED)
    return {"ops": ops, "expected": expected, "passed": passed}


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


def scenario_e(ctx: Ctx) -> dict:
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
    return {"udf": udf, "lines": want}


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



# ===================================================================== step 2
# Scenarios of the step 2 design (section 7 H3). Every one but g0 and j needs
# the `create-ws` transport (the Dashboard creates executions); g0 and j also
# run on `ws`, where j changes the operator through the old ModifyLogicRequest.


def _need_create_ws(ctx: Ctx) -> None:
    if ctx.transport_name != "create-ws":
        raise RuntimeError(f"scenario {ctx.rec.key} needs --transport create-ws (the Dashboard creates "
                           f"executions from step 2's PR B on); this run uses {ctx.transport_name}")


def _need_other(ctx: Ctx) -> OtherUser:
    if ctx.other is None:
        raise RuntimeError("this scenario needs the second user sce-e2e-other (set up by the driver "
                           "when a scenario that needs it is selected)")
    return ctx.other


def _error_text(err: Any) -> str:
    return json.dumps(err, default=str) if not isinstance(err, str) else err


def _contains(haystack: Any, needle: str) -> bool:
    return needle.lower() in _error_text(haystack).lower()


UDF_TABULATE = '''from pytexera import *
import tabulate


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["tabulate_version"] = tabulate.__version__
        yield tuple_
'''


def _tabulate_workflow(ctx: Ctx, key: str, env_name: str) -> tuple[Workflow, str]:
    """Text Input (one line) -> a Python UDF in environment `env_name` that outputs
    tabulate.__version__. No dataset read, so it runs on an isolated unit too."""
    wf = ctx.workflow(key)
    src = wf.add("one-line", "TextInput", text_input(["sce-e2e"]), n_in=0)
    udf = wf.add("tabulate-version", "PythonUDFV2",
                 python_udf(UDF_TABULATE, out_columns=[("tabulate_version", "string")], env_name=env_name))
    wf.link(src, udf)
    return wf, udf


def _precondition_no_tabulate(ctx: Ctx) -> None:
    p = ctx.unit_exec("python3", "-c", "import tabulate")
    ctx.check("precondition: the unit's own python3 cannot import tabulate (a silent fallback "
              "to it would fail the import)", p.returncode != 0,
              f"exit {p.returncode}: {(p.stdout or '').strip()[-300:]}")
    if p.returncode == 0:
        raise RuntimeError("the unit image has tabulate installed; the environment scenarios prove nothing")


def scenario_g0(ctx: Ctx) -> None:
    """The legacy environment path (until step 2's PR D): an environment built on
    the unit through /api/pve/db and /wsapi/pve, used by a UDF's envName."""
    _precondition_no_tabulate(ctx)
    name = f"sce-env0-{ctx.hex}"
    row = ctx.api.ensure_environment(name, {"tabulate": "==0.9.0"}, legacy=True)
    ctx.log(f"  environment row {row} saved through /api/pve/db; building it on unit {ctx.cuid} "
            f"through /wsapi/pve (installs amber's requirements: minutes)")
    t0 = time.monotonic()
    built = ctx.api.build_legacy_environment(ctx.cuid, name, ["tabulate==0.9.0"], log=ctx.log)
    took = time.monotonic() - t0
    install_tail = [ln for ln in built["install"] if "tabulate" in ln.lower()][-3:]
    ctx.check("environment built through /api/pve/db and /wsapi/pve (create, then install)", True,
              f"{len(built['create'])} create and {len(built['install'])} install lines in {took:.0f}s; "
              f"{install_tail}")
    wf, udf = _tabulate_workflow(ctx, "g0-environment-legacy", name)
    handle, res = run_to_completion(ctx, wf, udf)
    versions = [r.get("tabulate_version") for r in res["rows"]]
    ctx.check("the UDF ran in the environment: its row says tabulate 0.9.0",
              versions == ["0.9.0"], f"rows {res['rows'][:3]}")
    ctx.persisted_status(STATUS_COMPLETED, eid=handle.eid)


TAG_SLEEP_S = 0.05


def udf_tag(tag: str) -> str:
    return f'''from pytexera import *
import time


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        time.sleep({TAG_SLEEP_S})
        tuple_["tag"] = "{tag}"
        yield tuple_
'''


def scenario_j(ctx: Ctx) -> None:
    """numbers.csv -> a UDF tagging v1 (0.05 s per tuple); pause; change the code to
    tag v2; resume. On create-ws the change goes through the Dashboard, and another
    user's change (403) and a change after the end (409) are refused."""
    create_ws = ctx.transport_name == "create-ws"
    total = len(ctx.data["numbers.csv"])
    wf = ctx.workflow("j-modify-while-paused")
    scan = wf.add("numbers", "CSVFileScan", csv_scan(ctx.paths["numbers.csv"]), n_in=0)
    udf = wf.add("tagger", "PythonUDFV2", python_udf(udf_tag("v1"), out_columns=[("tag", "string")]))
    wf.link(scan, udf)

    handle = ctx.start(wf, view=[udf])
    handle.wait_for_state("Running", timeout=ctx.timeout)
    handle.wait_until(lambda: handle.output_rows(udf) >= 5, ctx.timeout, "the UDF to emit 5 rows")
    handle.pause()
    paused = handle.wait_for_state("Paused", timeout=120)
    ctx.check("pause -> Paused", paused == "Paused", f"states {handle.states}")
    at_pause = handle.output_rows(udf)

    new_op = wf.operator_json(udf, code=udf_tag("v2"))
    out = handle.modify_operator(new_op)
    resp = out.get("response") or {}
    how = "POST /api/executions/{eid}/updates 200, then OperatorUpdateRequest" if create_ws \
        else "ModifyLogicRequest"
    ctx.check(f"change accepted ({how}) and ModifyLogicResponse.isValid", resp.get("isValid") is True,
              json.dumps(out)[:600])
    if create_ws:
        ctx.check("the Dashboard answered {updateId, operatorId}",
                  str(out.get("updateId", "")).startswith("update-") and out.get("operatorId") == udf,
                  json.dumps({k: v for k, v in out.items() if k != "response"}))
        other = _need_other(ctx)
        r = other.api.post_operator_update(handle.eid, new_op)
        ctx.check("another user's change is refused (403)", r.status_code == 403,
                  f"HTTP {r.status_code}: {r.text[:300]}")
    else:
        ctx.note("ws: the Dashboard's update endpoint (403 for another user, 409 after the end) is "
                 "checked on create-ws only")

    handle.resume()
    done = handle.wait_for_state("Completed", timeout=ctx.timeout)
    ctx.check("resume -> Completed", done == "Completed", f"states {handle.states}")
    try:
        handle.wait_until(lambda: any(udf in (e.get("opIds") or []) for e in handle.modify_completed),
                          30, "ModifyLogicCompletedEvent", fail_fast=False)
    except RunTimeout:
        pass
    ctx.check("ModifyLogicCompletedEvent names the UDF",
              any(udf in (e.get("opIds") or []) for e in handle.modify_completed),
              f"{handle.modify_completed}")
    res = handle.results(udf)
    rows = res["rows"]
    tags = Counter(r.get("tag") for r in rows)
    ctx.check(f"all {total} rows", len(rows) == total, f"got {len(rows)}")
    ctx.check("some rows tagged v1 and the rest v2", tags.get("v1", 0) > 0 and tags.get("v2", 0) > 0
              and set(tags) <= {"v1", "v2"}, f"tags {dict(tags)}; {at_pause} rows reported at the pause")
    v1 = [int(r["n"]) for r in rows if r.get("tag") == "v1"]
    v2 = [int(r["n"]) for r in rows if r.get("tag") == "v2"]
    ctx.check("the v1 rows precede the v2 rows (the change took effect where the run paused)",
              bool(v1) and bool(v2) and max(v1) < min(v2),
              f"v1 n in [{min(v1, default=None)}, {max(v1, default=None)}], "
              f"v2 n in [{min(v2, default=None)}, {max(v2, default=None)}]")
    if create_ws:
        if ctx.at_least("B"):
            # The Dashboard refuses a change by the closing record (ended_at), which its
            # closing job writes a tick after the run ended: until then it takes the change.
            closed, waited = _wait_closed(ctx, handle.eid)
            ctx.note(f"waited {waited:.1f} s for the Dashboard to close the execution "
                     f"({'closed' if not closed.open else 'still open'}) before the late change")
        r = ctx.api.post_operator_update(handle.eid, new_op)
        ctx.check("a change after the run completed is refused (409)", r.status_code == 409,
                  f"HTTP {r.status_code}: {r.text[:300]}")
    ctx.persisted_status(STATUS_COMPLETED, eid=handle.eid)


def scenario_k(ctx: Ctx) -> None:
    """A Projection of a missing column: create answers 400 with the error on that
    operator, the row is FAILED, and the unit never hears of it."""
    _need_create_ws(ctx)
    wf = ctx.workflow("k-compile-error-from-create")
    scan = wf.add("people", "CSVFileScan", csv_scan(ctx.paths["people.csv"]), n_in=0)
    prj = wf.add("missing-column", "Projection", projection(("sce_no_such_column", "")))
    wf.link(scan, prj)
    wid = ctx.create_workflow(wf)
    resp, body = ctx.create(wf, [prj], wid=wid)
    ctx.check("create answers 400", resp.status_code == 400, f"HTTP {resp.status_code}: {str(body)[:500]}")
    body = body if isinstance(body, dict) else {}
    errors = body.get("operatorErrors") or {}
    ctx.check("operatorErrors carries the Projection's error naming the column",
              prj in errors and _contains(errors[prj], "sce_no_such_column"),
              f"operatorErrors keys {list(errors)}; {_error_text(errors.get(prj))[:400]}")
    eid = body.get("eid")
    ctx.rec.eid = eid
    ctx.check("the 400 names the execution it recorded", isinstance(eid, int), f"eid {eid}")
    if isinstance(eid, int):
        entry = ctx.api.wait_entry_status(wid, eid, STATUS_FAILED, timeout=15)
        ctx.check("that execution's row is FAILED (4)", bool(entry) and entry.get("status") == STATUS_FAILED,
                  f"{entry}")
        ctx.expect_no_unit_statement(eid, "a create refused by its compile never reaches the unit")


# ------------------------------------------------------------ l: refusals


def _tiny(ctx: Ctx, key: str) -> tuple[Workflow, str]:
    """A workflow that needs no dataset: Text Input of three lines."""
    wf = ctx.workflow(key)
    src = wf.add("lines", "TextInput", text_input(["a", "b", "c"]), n_in=0)
    return wf, src


def _refused_create(ctx: Ctx, label: str, want: int, *, wf: Workflow, view: list[str], wid: int,
                    owner_api: TexeraApi, api: TexeraApi | None = None, cuid: int | None = None,
                    whid: Any = "default") -> None:
    before = len(owner_api.list_executions(wid))
    resp, body = ctx.create(wf, view, wid=wid, api=api, cuid=cuid, whid=whid)
    ctx.check(f"{label}: create answers {want}", resp.status_code == want,
              f"HTTP {resp.status_code}: {str(body)[:400]}")
    after = len(owner_api.list_executions(wid))
    ctx.check(f"{label}: no execution row was written", after == before, f"rows {before} -> {after}")


def _created(ctx: Ctx, wf: Workflow, view: list[str], wid: int, **kw) -> dict:
    resp, body = ctx.create(wf, view, wid=wid, **kw)
    if resp.status_code != 201:
        raise CreateRefused(resp.status_code, body)
    return body


#: a start that is refused is answered within this
REFUSAL_WAIT_S = 30.0
#: after a refusal arrived: anything else the unit sends or runs for that start happens within this
REFUSAL_SETTLE_S = 3.0


def _refused_start(ctx: Ctx, label: str, expect: str | tuple[str, ...], *, wid: int, eid: int,
                   plan_uri: str, socket_cuid: int | None = None, token: str | None = None,
                   row_status: int | None = None) -> None:
    """Start `eid` on a socket that must be refused: the error reaches that socket
    only (a session of the creator on the same workflow sees none), nothing runs,
    the row stays as it was (`row_status`; when not given, what an execution nobody
    started reads), and the unit runs no statement at all from the start until after
    the refusal (D33). `expect`: the refusal's message contains one of these (the
    design's StoredExecutionStart messages)."""
    expect = (expect,) if isinstance(expect, str) else expect
    row_status = ctx.unstarted_status if row_status is None else row_status
    watcher = ctx.transport.open_socket(wid, ctx.cuid)
    ctx.handles.append(watcher)
    handle = ctx.transport.start_existing(wid=wid, cuid=socket_cuid or ctx.cuid, eid=eid,
                                          plan_uri=plan_uri, token=token)
    ctx.handles.append(handle)
    try:
        handle.wait_until(lambda: handle.error_event_count > 0, REFUSAL_WAIT_S, "the refusal", fail_fast=False)
    except RunTimeout:
        pass
    time.sleep(REFUSAL_SETTLE_S)  # anything else the unit sends or runs for this start happens by now
    ctx.expect_unit_silent(eid, f"{label}: a refused start runs nothing on the unit")
    messages = [str(e.get("message")) for e in handle.fatal_errors]
    ctx.check(f"{label}: the starting socket gets a WorkflowErrorEvent ({' or '.join(expect)})",
              handle.error_event_count > 0
              and any(x.lower() in m.lower() for m in messages for x in expect),
              f"error events {handle.error_event_count}: {messages[:3]}")
    ctx.check(f"{label}: no other session on the workflow gets it", watcher.error_event_count == 0,
              f"watcher error events {watcher.error_event_count}: "
              f"{[e.get('message') for e in watcher.fatal_errors][:2]}")
    ctx.check(f"{label}: never Running", "Running" not in handle.states and "Running" not in watcher.states,
              f"starting socket {handle.states}; watcher {watcher.states}")
    entry = ctx.api.execution_entry(wid, eid)
    ctx.check(f"{label}: the row stays {row_status}", bool(entry) and entry.get("status") == row_status,
              f"{entry}")
    ctx.expect_no_unit_statement(eid, f"{label}: a refused start writes nothing")
    ctx.allow_status_zero(eid, f"{ctx.rec.key}: start refused on purpose")


def scenario_l1(ctx: Ctx) -> None:
    """Create on a computing unit that does not exist: 403, no row."""
    _need_create_ws(ctx)
    wf, src = _tiny(ctx, "l1-unknown-unit")
    wid = ctx.create_workflow(wf)
    _refused_create(ctx, "l1 unknown unit", 403, wf=wf, view=[src], wid=wid, owner_api=ctx.api,
                    cuid=2_000_000_001)


def scenario_l2(ctx: Ctx) -> None:
    """Another user creates an execution of texera's workflow (on its own unit): 403, no row."""
    _need_create_ws(ctx)
    other = _need_other(ctx)
    wf, src = _tiny(ctx, "l2-other-user-texera-workflow")
    wid = ctx.create_workflow(wf)
    _refused_create(ctx, "l2 another user, texera's workflow", 403, wf=wf, view=[src], wid=wid,
                    owner_api=ctx.api, api=other.api, cuid=other.cuid, whid=other.whid)


def scenario_l3(ctx: Ctx) -> None:
    """Another user creates an execution of its own workflow on texera's unit: 403, no row."""
    _need_create_ws(ctx)
    other = _need_other(ctx)
    wf, src = _tiny(ctx, "l3-other-user-texera-unit")
    wid = ctx.create_workflow(wf, api=other.api)
    _refused_create(ctx, "l3 another user, texera's unit", 403, wf=wf, view=[src], wid=wid,
                    owner_api=other.api, api=other.api, cuid=ctx.cuid, whid=other.whid)


def scenario_l4(ctx: Ctx) -> None:
    """Create on a terminated unit: 409, no row."""
    _need_create_ws(ctx)
    unit = ctx.api.create_local_unit(f"sce-e2e-terminated-{ctx.hex}", ctx.unit_uri)
    cuid = int(unit["cuid"])
    r = ctx.api.terminate_unit(cuid)
    ctx.check("a fresh local unit was terminated", r.status_code == 200, f"HTTP {r.status_code}: {r.text[:200]}")
    wf, src = _tiny(ctx, "l4-terminated-unit")
    wid = ctx.create_workflow(wf)
    _refused_create(ctx, f"l4 terminated unit {cuid}", 409, wf=wf, view=[src], wid=wid,
                    owner_api=ctx.api, cuid=cuid)


def scenario_l5(ctx: Ctx) -> None:
    """Another user starts texera's created execution on a socket: refused."""
    _need_create_ws(ctx)
    other = _need_other(ctx)
    wf, src = _tiny(ctx, "l5-other-user-starts")
    wid = ctx.create_workflow(wf)
    created = _created(ctx, wf, [src], wid)
    ctx.rec.eid = created["eid"]
    # With warehouses on, the URI check (texera's warehouse in the URI) refuses it
    # before the record check (not the creator); either is the design's refusal.
    _refused_start(ctx, "l5 another user's socket", ("only the user who created", "another user's warehouse"),
                   wid=wid, eid=created["eid"], plan_uri=created["planUri"], token=other.api.token)


def scenario_l6(ctx: Ctx) -> None:
    """A start naming another execution's planUri: refused."""
    _need_create_ws(ctx)
    wf, src = _tiny(ctx, "l6-other-plan-uri")
    wid = ctx.create_workflow(wf)
    first = _created(ctx, wf, [src], wid)
    second = _created(ctx, wf, [src], wid)
    ctx.rec.eid = first["eid"]
    _refused_start(ctx, f"l6 execution {first['eid']} with {second['eid']}'s plan", "the plan is execution",
                   wid=wid, eid=first["eid"], plan_uri=second["planUri"])
    ctx.expect_no_unit_statement(second["eid"], "l6: the other execution is not started either")
    ctx.allow_status_zero(second["eid"], "l6: created as the plan another start names")


def scenario_l7(ctx: Ctx) -> None:
    """Create naming another user's warehouse: 400, no row."""
    _need_create_ws(ctx)
    other = _need_other(ctx)
    wf, src = _tiny(ctx, "l7-other-warehouse")
    wid = ctx.create_workflow(wf)
    whid = other.whid if other.whid is not None else 2_000_000_001
    if other.whid is None:
        ctx.note("warehouses are off here: l7 names a warehouse id while the feature is off (also a 400)")
    _refused_create(ctx, f"l7 warehouse {whid} of another user", 400, wf=wf, view=[src], wid=wid,
                    owner_api=ctx.api, whid=whid)


def scenario_l8(ctx: Ctx) -> None:
    """Start a completed execution again: refused with "already started"; the row stays 3."""
    _need_create_ws(ctx)
    wf, src = _tiny(ctx, "l8-start-twice")
    first = ctx.start(wf, view=[src])
    first.wait_for_state("Completed", timeout=ctx.timeout)
    ctx.persisted_status(STATUS_COMPLETED, eid=first.eid)
    # The first socket stays open, so the unit does not clean the workflow up meanwhile;
    # what the finished run still writes (result sizes, statistics) settles first.
    ctx.settle_unit("the second start")
    seen_states = len(first.state_log)
    seen_errors = first.error_event_count
    # The new socket gets the held run replayed (its state Completed, its console)
    # while it opens; that is not this start's answer (transport: the open sequence).
    again = ctx.transport.start_existing(wid=ctx.rec.wid, cuid=ctx.cuid, eid=first.eid,
                                         plan_uri=first.plan_uri)
    ctx.handles.append(again)
    try:
        again.wait_until(lambda: again.error_event_count > 0, REFUSAL_WAIT_S, "the refusal", fail_fast=False)
    except RunTimeout:
        pass
    time.sleep(REFUSAL_SETTLE_S)
    ctx.expect_unit_silent(first.eid, "l8: a second start runs nothing on the unit")
    messages = [str(e.get("message")) for e in again.fatal_errors]
    ctx.check("l8 second start: the socket gets a WorkflowErrorEvent ('already started')",
              any("already started" in m.lower() for m in messages), f"{messages[:3]}")
    ctx.check("l8 second start: the first session gets no error and no new state",
              first.error_event_count == seen_errors and len(first.state_log) == seen_states,
              f"errors {seen_errors} -> {first.error_event_count}; states {first.states}")
    ctx.check("l8 second start: never Running", "Running" not in again.states,
              f"after the start {again.states}; replayed while the socket opened "
              f"{again.replayed.get('states')}")
    entry = ctx.api.execution_entry(ctx.rec.wid, first.eid)
    ctx.check("l8: the row stays 3", bool(entry) and entry.get("status") == STATUS_COMPLETED, f"{entry}")
    ctx.expect_no_unit_statement(first.eid, "l8: a second start writes nothing", since_last_start=True)


def scenario_l9(ctx: Ctx) -> None:
    """Start, on a socket for texera's second unit, a plan created for the first: refused."""
    _need_create_ws(ctx)
    if ctx.unit2_cuid is None:
        raise RuntimeError("l9 needs texera's second local unit (sce-e2e-unit-2), set up by the driver")
    wf, src = _tiny(ctx, "l9-other-unit-socket")
    wid = ctx.create_workflow(wf)
    created = _created(ctx, wf, [src], wid)
    ctx.rec.eid = created["eid"]
    _refused_start(ctx, f"l9 socket of unit {ctx.unit2_cuid}", "computing unit", wid=wid,
                   eid=created["eid"], plan_uri=created["planUri"], socket_cuid=ctx.unit2_cuid)


def scenario_l10(ctx: Ctx) -> None:
    """A planUri naming another user's warehouse: refused before any catalog is opened."""
    _need_create_ws(ctx)
    other = _need_other(ctx)
    wf, src = _tiny(ctx, "l10-other-warehouse-uri")
    wid = ctx.create_workflow(wf)
    created = _created(ctx, wf, [src], wid)
    ctx.rec.eid = created["eid"]
    foreign = other.warehouse_name or f"user-{other.api.uid}-1"
    m = re.match(r"^vfs:///wh/[^/]+/(.*)$", created["planUri"])
    crafted = (f"vfs:///wh/{foreign}/{m.group(1)}" if m
               else created["planUri"].replace("vfs:///", f"vfs:///wh/{foreign}/", 1))
    ctx.log(f"  crafted plan URI {crafted}")
    _refused_start(ctx, f"l10 plan URI in warehouse {foreign}", "another user's warehouse", wid=wid,
                   eid=created["eid"], plan_uri=crafted)


# ------------------------------------------------------------- m: replay


REPLAY_SLEEP_MS = 50
# A slow operator on a JVM worker. A global checkpoint asks every worker of the run to
# prepare one, and a Python worker cannot: pyamber has no PrepareCheckpoint handler
# (grpclib UNIMPLEMENTED), so with a Python UDF in the workflow the checkpoint never
# completes and the coordinator records no interaction (seen on step2ckpt, 2026-11-16).
JAVA_UDF_SLOW_TAG = '''import org.apache.texera.amber.operator.map.MapOpExec;
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
        try {
            Thread.sleep(%d);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        List<Object> fields = new ArrayList<>();
        for (Object f : tuple.getFields()) {
            fields.add(f);
        }
        fields.add("replayed");
        return TupleLike$.MODULE$.apply(fields);
    }
}
''' % REPLAY_SLEEP_MS


def scenario_m(ctx: Ctx) -> None:
    """Replay: the refusals always (source without a log, source of another
    workflow: 400, no row); with --with-replay-log a run with a global checkpoint
    (the only interaction the engine records), its interactions, a replay created
    from the last one and started. The checkpointed run has JVM workers only."""
    _need_create_ws(ctx)
    wf1, src1 = _tiny(ctx, "m-replay-source")
    first = ctx.start(wf1, view=[src1])
    first.wait_for_state("Completed", timeout=ctx.timeout)
    wid1, eid1 = ctx.rec.wid, first.eid
    ctx.persisted_status(STATUS_COMPLETED, eid=eid1)
    entry1 = ctx.api.execution_entry(wid1, eid1) or {}
    if entry1.get("logLocation"):
        ctx.note(f"every execution has a replay log here ({entry1.get('logLocation')}); the "
                 f"'source without a log' refusal uses an execution that does not exist")
    no_log_source = {"eid": eid1 if not entry1.get("logLocation") else 2_000_000_001,
                     "interaction": "sce-e2e-none"}
    before = len(ctx.api.list_executions(wid1))
    resp, body = ctx.create(wf1, [src1], wid=wid1, replay_from=no_log_source)
    ctx.check("m replay of a source without a log answers 400", resp.status_code == 400,
              f"HTTP {resp.status_code}: {str(body)[:300]}")
    ctx.check("m ... and writes no row", len(ctx.api.list_executions(wid1)) == before, "")

    wf2, src2 = _tiny(ctx, "m-replay-other-workflow")
    wid2 = ctx.create_workflow(wf2)
    resp, body = ctx.create(wf2, [src2], wid=wid2, replay_from={"eid": eid1, "interaction": "sce-e2e-x"})
    ctx.check("m replay of another workflow's execution answers 400", resp.status_code == 400,
              f"HTTP {resp.status_code}: {str(body)[:300]}")
    ctx.check("m ... and writes no row", len(ctx.api.list_executions(wid2)) == 0, "")

    if not ctx.with_replay_log:
        ctx.note("the replay run is skipped: the stack was not started with --with-replay-log")
        return
    total = len(ctx.data["numbers.csv"])
    wf3 = ctx.workflow("m-replay-run")
    scan = wf3.add("numbers", "CSVFileScan", csv_scan(ctx.paths["numbers.csv"]), n_in=0)
    udf = wf3.add("slow", "JavaUDF", {
        "code": JAVA_UDF_SLOW_TAG,
        "workers": 1,
        "retainInputColumns": True,
        "outputColumns": [{"attributeName": "tag", "attributeType": "string"}],
    })
    wf3.link(scan, udf)
    run = ctx.start(wf3, view=[udf])
    run.wait_for_state("Running", timeout=ctx.timeout)
    run.wait_until(lambda: run.output_rows(udf) >= 3, ctx.timeout, "the UDF to emit 3 rows")
    # An interaction (a replay destination) is recorded only when an embedded control
    # message propagates: a global checkpoint. Pause and resume record none (seen on
    # step2wip, 2026-11-16).
    run.send_raw({"type": "WorkflowCheckpointRequest"}, "WorkflowCheckpointRequest")
    try:
        run.wait_for_state("Completed", timeout=ctx.timeout)
    except RunFailed as e:
        ctx.check("m the replay-logged source run completes after a checkpoint", False,
                  f"{e} -- on 2026-11-16 (step2ckpt, where a source worker takes the checkpoint) the engine "
                  f"failed the checkpoint of a JVM worker whose output port is stored: Kryo cannot serialize "
                  f"OutputManager.outputPortResultWriterThreads, live threads (upstream, not step 2)")
        return
    wid3, eid3 = ctx.rec.wid, run.eid
    interactions = ctx.api.execution_interactions(wid3, eid3)
    ctx.check("m the replay-logged run lists its interactions", len(interactions) >= 1, f"{interactions[:5]}")
    if not interactions:
        return
    resp, body = ctx.create(wf3, [udf], wid=wid3,
                            replay_from={"eid": eid3, "interaction": interactions[-1]})
    ctx.check("m replay create answers 201", resp.status_code == 201, f"HTTP {resp.status_code}: {str(body)[:300]}")
    if resp.status_code != 201:
        return
    replay = ctx.transport.start_existing(wid=wid3, cuid=ctx.cuid, eid=body["eid"], plan_uri=body["planUri"])
    ctx.handles.append(replay)
    state = replay.wait_for_state("Running", "Paused", "Completed", timeout=ctx.timeout)
    ctx.check("m the replay reaches a non-failed state", state in ("Running", "Paused", "Completed"),
              f"states {replay.states}; {total} rows in the source run")


# ------------------------------------------------------------ o: agent run


def scenario_o(ctx: Ctx) -> None:
    """The agent's path: create with targetOperatorIds [Filter], then the unit's
    POST /api/execution/{eid}/run; a repeat is refused."""
    _need_create_ws(ctx)
    people = ctx.data["people.csv"]
    expected = sorted(
        ({"id": int(p["id"]), "name": p["name"], "dept": p["dept"], "age": int(p["age"]),
          "salary": float(p["salary"])} for p in people if int(p["age"]) > 30),
        key=lambda r: r["id"])
    wf = ctx.workflow("o-agent-sync-run")
    scan = wf.add("people", "CSVFileScan", csv_scan(ctx.paths["people.csv"]), n_in=0)
    flt = wf.add("age-over-30", "Filter", filter_op(("age", ">", "30")))
    prj = wf.add("dept-salary", "Projection", projection(("dept", "department"), ("salary", "")))
    wf.link(scan, flt)
    wf.link(flt, prj)
    wid = ctx.create_workflow(wf)
    created = _created(ctx, wf, [prj], wid, target_operator_ids=[flt])
    eid, plan_uri = created["eid"], created["planUri"]
    ctx.rec.eid = eid
    body = {"planUri": plan_uri, "computingUnitId": ctx.cuid, "targetOperatorIds": [flt],
            "timeoutSeconds": 60, "maxOperatorResultCharLimit": 20000,
            "maxOperatorResultCellCharLimit": 4000}

    def call() -> tuple[int, Any]:
        p = ctx.unit_exec("curl", "-s", "-w", "\n%{http_code}", "-X", "POST",
                          f"http://localhost:8085/api/execution/{eid}/run",
                          "-H", f"Authorization: Bearer {ctx.api.token}",
                          "-H", "Content-Type: application/json", "--data-binary", "@-",
                          stdin=json.dumps(body), timeout=180)
        text, _, code = p.stdout.rpartition("\n")
        try:
            return int(code), json.loads(text)
        except ValueError:
            return (int(code) if code.isdigit() else 0), text

    record = ctx.evidence.on_phase("start", {"wid": wid, "cuid": ctx.cuid, "eid": eid,
                                             "plan_uri": plan_uri}) if ctx.evidence else None
    code, result = call()
    ok = isinstance(result, dict) and result.get("success") is True
    if record is not None:
        record.started = ok
        record.final_state = result.get("state") if isinstance(result, dict) else None
    ctx.check("the unit's run answers success with state Completed",
              code == 200 and ok and result.get("state") == "Completed",
              f"HTTP {code}: {str(result)[:500]}")
    op = ((result or {}).get("operators") or {}).get(flt) if isinstance(result, dict) else None
    # The sync endpoint adds bookkeeping keys to every row; the agent service strips them
    # before use, so the comparison does too.
    rows = [{k: v for k, v in r.items() if k not in ("__row_index__", "__is_visualization__")}
            for r in (op or {}).get("result") or []]
    rows.sort(key=lambda r: int(r.get("id", 0)))
    d = diff_rows(rows, expected, ordered=True)
    ctx.check("the Filter's rows are exact", bool(op) and not d, d or f"{len(rows)} rows")
    if isinstance(result, dict):
        ctx.check("only the target's sub-plan ran (the Projection downstream of it is not in the result)",
                  prj not in (result.get("operators") or {}), f"operators {list((result.get('operators') or {}))}")
    # The repeat is a refused start too: the unit must stay silent from it until after
    # its answer. No socket holds this workflow, so the unit cleans the finished run
    # `cleanup_seconds` after it ended; that and the run's trailing writes settle first.
    if ctx.evidence is not None:
        ctx.settle_unit("the repeated call", min_wait_s=ctx.evidence.cleanup_seconds + 1.0)
    repeat = ctx.evidence.on_phase("start", {"wid": wid, "cuid": ctx.cuid, "eid": eid,
                                             "plan_uri": plan_uri}) if ctx.evidence else None
    code2, again = call()
    if repeat is not None:
        repeat.started = False
    time.sleep(REFUSAL_SETTLE_S)
    ctx.expect_unit_silent(eid, "o: a repeated run call runs nothing on the unit")
    ctx.check("a repeat of the call is refused: success false, 'already started'",
              isinstance(again, dict) and again.get("success") is False
              and any("already started" in str(e).lower() for e in (again.get("errors") or [])),
              f"HTTP {code2}: {str(again)[:400]}")
    ctx.persisted_status(STATUS_COMPLETED, eid=eid)


# ----------------------------------------------------- f, f2: listed files


UDF_DIGEST = '''from pytexera import *
import hashlib


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        content = tuple_["line"].encode("utf-8")
        tuple_["n_bytes"] = len(content)
        tuple_["sha256"] = hashlib.sha256(content).hexdigest()
        yield tuple_
'''

#: A result table shows the first characters of a long string cell, then "..." (TupleUtils).
RESULT_CELL_CHARS = 100


def as_shown(value: str) -> str:
    """A string cell as a result table shows it."""
    return value if len(value) <= RESULT_CELL_CHARS else value[:RESULT_CELL_CHARS] + "..."


def scenario_f(ctx: Ctx) -> None:
    """File Lister (the e2e dataset's version) -> File Scan From Input (single
    string, with the file name) -> Python UDF (the content's size and SHA-256):
    the three files, read whole through links. The digest is taken in the run
    because a result table shows only the start of a long cell."""
    _need_create_ws(ctx)
    version_path = ctx.dataset.get("version_path")
    wf = ctx.workflow("f-file-lister-scan")
    lister = wf.add("dataset-files", "FileLister", file_lister(version_path), n_in=0)
    scan = wf.add("read-files", "FileScanOp", file_scan_from_input("single string", True))
    digest = wf.add("content-digest", "PythonUDFV2",
                    python_udf(UDF_DIGEST, out_columns=[("n_bytes", "integer"), ("sha256", "string")]))
    wf.link(lister, scan)
    wf.link(scan, digest)
    handle, res = run_to_completion(ctx, wf, digest)
    rows = res["rows"]
    ctx.check("three rows, one per file", len(rows) == len(ctx.paths), f"got {len(rows)}")
    want_names = sorted(ctx.paths.values())
    got_names = sorted(str(r.get("filename")) for r in rows)
    ctx.check("the file names are the three logical paths", got_names == want_names,
              f"got {got_names}, want {want_names}")
    ctx.check("no value contains http (no link leaks into the data)",
              not any("http" in str(v) for r in rows for v in r.values()), "")
    by_path = {p: ctx.data_bytes[f] for f, p in ctx.paths.items()}

    def differs(row: dict) -> str | None:
        content = by_path.get(row.get("filename"))
        if content is None:
            return "not a file of the dataset"
        if row.get("n_bytes") != len(content):
            return f"{row.get('n_bytes')} bytes, uploaded {len(content)}"
        if row.get("sha256") != hashlib.sha256(content).hexdigest():
            return "another SHA-256 than the uploaded bytes'"
        if row.get("line") != as_shown(content.decode("utf-8")):
            return f"shown as {str(row.get('line'))[:60]!r}"
        return None

    bad = {str(r.get("filename")): why for r in rows if (why := differs(r))}
    ctx.check("each file's content is the uploaded bytes (size and SHA-256 taken in the run; the "
              f"cell shows its first {RESULT_CELL_CHARS} characters)", not bad, f"differ: {bad}")
    ctx.persisted_status(STATUS_COMPLETED, eid=handle.eid)


def scenario_f2(ctx: Ctx) -> None:
    """Text Input of a dataset path -> File Scan From Input: refused at create,
    on the File Scan (it reads only files a File Lister upstream listed)."""
    _need_create_ws(ctx)
    wf = ctx.workflow("f2-file-scan-needs-lister")
    src = wf.add("a-path", "TextInput", text_input([ctx.paths["people.csv"]]), n_in=0)
    scan = wf.add("read-files", "FileScanOp", file_scan_from_input("single string", True))
    wf.link(src, scan)
    wid = ctx.create_workflow(wf)
    resp, body = ctx.create(wf, [scan], wid=wid)
    ctx.check("create answers 400", resp.status_code == 400, f"HTTP {resp.status_code}: {str(body)[:400]}")
    errors = (body or {}).get("operatorErrors") or {} if isinstance(body, dict) else {}
    ctx.check("operatorErrors names the File Scan", scan in errors, f"keys {list(errors)}; {str(errors)[:400]}")
    if isinstance(body, dict) and isinstance(body.get("eid"), int):
        ctx.rec.eid = body["eid"]
        ctx.expect_no_unit_statement(body["eid"], "a refused create never reaches the unit")


# ------------------------------------------------- g, h, i: environments


TABULATE_LINES = ["tabulate==0.9.0"]


def _installs_of(dirs: list[dict], requirements: list[str]) -> list[dict]:
    """The install directories whose marker lists exactly these canonical lines."""
    return [d for d in dirs if isinstance(d.get("marker"), dict)
            and d["marker"].get("requirements") == requirements]


def _console_texts(handle: RunHandle, op: str) -> list[str]:
    return [f"{m.get('title') or ''}\n{m.get('message') or ''}" for m in handle.console(op)]


def scenario_g(ctx: Ctx) -> None:
    """An environment from /api/environments, installed when the run starts; a
    second run (on a new workflow: installs are keyed by the requirements and the
    engine, not by the workflow) reuses it."""
    _need_create_ws(ctx)
    _precondition_no_tabulate(ctx)
    root = ctx.environments_root()
    # A unit that ran g before holds an install of these requirements (a --keep stack, a
    # rerun): reuse is decided by its marker (design 4, Environment install, step 3), so
    # remove it to see a first install again. Nothing else runs on the unit now.
    stale = _installs_of(ctx.environment_dirs(), TABULATE_LINES)
    for d in stale:
        p = ctx.unit_exec("rm", "-rf", d["path"])
        ctx.note(f"removed an earlier install of {TABULATE_LINES} at {d['path']} (exit {p.returncode}) so "
                 f"run 1 installs afresh")
    name = f"sce-env-{ctx.hex}"
    ctx.api.ensure_environment(name, {"tabulate": "==0.9.0"})
    timings = []
    for attempt in (1, 2):
        wf, udf = _tabulate_workflow(ctx, f"g-environment-install-run{attempt}", name)
        t0 = time.monotonic()
        handle = ctx.start(wf, view=[udf])
        handle.wait_for_state("Running", "Completed", timeout=max(ctx.timeout, 1800))
        t_running = time.monotonic() - t0
        handle.wait_for_state("Completed", timeout=ctx.timeout)
        timings.append(t_running)
        texts = _console_texts(handle, udf)
        res = handle.results(udf)
        ctx.check(f"run {attempt}: the row says tabulate 0.9.0",
                  [r.get("tabulate_version") for r in res["rows"]] == ["0.9.0"], f"{res['rows'][:2]}")
        ctx.persisted_status(STATUS_COMPLETED, eid=handle.eid)
        if attempt == 1:
            i_install = next((i for i, t in enumerate(texts) if "installing python environment" in t.lower()), None)
            i_ready = next((i for i, t in enumerate(texts) if "is ready" in t.lower()), None)
            ctx.check("run 1: the UDF's console says Installing, then ready with tabulate==0.9.0",
                      i_install is not None and i_ready is not None and i_install < i_ready
                      and "tabulate==0.9.0" in texts[i_ready], f"{[t[:120] for t in texts[:6]]}")
            ctx.check("run 1: Initializing until the install ended (Running only after 'ready')",
                      _running_after_message(handle, udf, "is ready"), f"states {handle.state_log[:8]}")
        else:
            ctx.check("run 2: the console says reused, and nothing about installing",
                      any("reused" in t.lower() for t in texts)
                      and not any("installing python environment" in t.lower() for t in texts),
                      f"{[t[:120] for t in texts[:6]]}")
            ctx.check("run 2: start-to-Running is shorter than run 1's", timings[1] < timings[0],
                      f"{timings[0]:.1f}s then {timings[1]:.1f}s")
    installs = _installs_of(ctx.environment_dirs(), TABULATE_LINES)
    ctx.check(f"one install directory with texera-environment.json listing {TABULATE_LINES} under {root}",
              len(installs) == 1, f"{[d.get('path') for d in installs]}")


def _running_after_message(handle: RunHandle, op: str, needle: str) -> bool:
    """Whether the first Running state arrived after the console message with `needle`."""
    msgs = [m for m in handle.console(op) if needle in f"{m.get('title') or ''}{m.get('message') or ''}".lower()]
    if not msgs or "_t" not in msgs[0]:
        return False
    t_msg = msgs[0]["_t"]
    t_run = next((t for t, s in handle.state_log if s == "Running"), None)
    return t_run is not None and t_run >= t_msg


def scenario_h(ctx: Ctx) -> None:
    """An environment pip cannot install: the run fails before it starts, with pip's
    message, and leaves no directory."""
    _need_create_ws(ctx)
    pkg = f"sce-e2e-nonexistent-{ctx.hex}"
    name = f"sce-env-broken-{ctx.hex}"
    ctx.api.ensure_environment(name, {pkg: "==1.0.0"})
    root = ctx.environments_root()
    before = {d["name"] for d in ctx.environment_dirs()}
    wf, udf = _tabulate_workflow(ctx, "h-environment-broken", name)
    handle = ctx.start(wf, view=[udf])
    state = handle.wait_for_state("Failed", timeout=max(ctx.timeout, 1800), fail_fast=False)
    ctx.check("the run fails", state == "Failed", f"states {handle.states}")
    ctx.check("the run fails before it starts (never Running)", "Running" not in handle.states,
              f"states {handle.states}")
    try:
        handle.wait_until(lambda: bool(handle.fatal_errors), 10, "the fatal error", fail_fast=False)
    except RunTimeout:
        pass
    messages = " | ".join(f"{e.get('message')} {e.get('details') or ''}" for e in handle.fatal_errors)
    ctx.check("the fatal error says 'could not be installed' and 'No matching distribution found'",
              "could not be installed" in messages and "No matching distribution found" in messages,
              messages[:600])
    ctx.check("the UDF emitted no row", handle.output_rows(udf) == 0, f"{handle.output_rows(udf)}")
    ctx.persisted_status(STATUS_FAILED, eid=handle.eid)
    after = ctx.environment_dirs()
    new = [d["path"] for d in after if d["name"] not in before]
    ctx.check(f"no install directory is left under {root} (a failed install removes its own)", not new,
              f"new entries {new}; {len(after)} entries now, {len(before)} before")


def scenario_i(ctx: Ctx) -> None:
    """A UDF naming an environment the user does not have: refused at create."""
    _need_create_ws(ctx)
    missing = f"sce-missing-{ctx.hex}"
    wf, udf = _tabulate_workflow(ctx, "i-environment-missing", missing)
    wid = ctx.create_workflow(wf)
    resp, body = ctx.create(wf, [udf], wid=wid)
    ctx.check("create answers 400", resp.status_code == 400, f"HTTP {resp.status_code}: {str(body)[:400]}")
    errors = (body.get("operatorErrors") or {}) if isinstance(body, dict) else {}
    ctx.check("the UDF's operator error names the environment",
              udf in errors and _contains(errors[udf], missing), f"{str(errors)[:400]}")
    eid = body.get("eid") if isinstance(body, dict) else None
    ctx.rec.eid = eid
    if isinstance(eid, int):
        entry = ctx.api.wait_entry_status(wid, eid, STATUS_FAILED, timeout=15)
        ctx.check("that execution's row is FAILED (4)", bool(entry) and entry.get("status") == STATUS_FAILED,
                  f"{entry}")
        ctx.expect_no_unit_statement(eid, "a create refused for a missing environment never reaches the unit")


# ===================================================================== step 3
# Scenarios of the step 3 design (section 7 H3): the record a run leaves in the lake,
# and what the Dashboard service makes of it. They wait on the unit's commit timer and
# on the Dashboard's closing job, so they need a stack started with --fast-record;
# every wait below is a multiple of the stack's timers (ctx.timing).

#: the states a log ends in
LOGGED_ENDINGS = ("COMPLETED", "FAILED", "KILLED")
SLOW_RUN_SLEEP_S = 0.1
UDF_SLOW_PRINT = f'''from pytexera import *
import time


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        print(f"sce-e2e slow run: {{tuple_['n']}}")
        time.sleep({SLOW_RUN_SLEEP_S})
        yield tuple_
'''
#: a state's row and label reach the lake a moment after the state reaches the socket
LABEL_WAIT_S = 10.0
#: the first commit of statistics or console output comes within this many commit intervals
FIRST_COMMIT_INTERVALS = 3
#: p reads the stored statistics twice, this many commit intervals apart (5 s with --fast-record)
STATS_GROWTH_INTERVALS = 2.5
#: an execution whose run ended is closed within this many closing intervals
CLOSE_INTERVALS = 3


def _need_fast_record(ctx: Ctx) -> None:
    if not ctx.timing.fast:
        raise RuntimeError(f"scenario {ctx.rec.key} waits on step 3's timers, which take minutes to a day "
                           f"with the product's defaults; start the stack with --fast-record "
                           f"(this stack: {ctx.timing.describe()})")


def _need_level(ctx: Ctx, level: str) -> None:
    if not ctx.at_least(level):
        has = f"gate 3{ctx.level}" if ctx.level else "step 2"
        raise RuntimeError(f"scenario {ctx.rec.key} needs what step 3's gate 3{level} brings; this run takes "
                           f"the product to be at {has} (--gate)")


def _need_stack(ctx: Ctx) -> None:
    if ctx.stack is None:
        raise RuntimeError(f"scenario {ctx.rec.key} takes the computing unit down, which needs the stack's "
                           f"control (driver/stack_control.py); this driver was given none")


def _part(ctx: Ctx, key: str, body: Callable[[Ctx], Any]) -> tuple[Any, int | None, int | None]:
    """Run another scenario's `body` as a part of this one: its checks join this
    scenario's, named after `key`. Returns what the body returns, and the workflow and
    the execution it left in the record."""
    kept = (ctx.rec.wid, ctx.rec.eid)
    ctx.rec.wid = ctx.rec.eid = None
    ctx.part = key
    try:
        out = body(ctx)
    finally:
        ctx.part = None
    # Check I judges the part's runs now: by the scenario's end their results, and with
    # them their console tables, may have expired by age.
    ctx.settle_records()
    wid, eid = ctx.rec.wid, ctx.rec.eid
    ctx.rec.wid, ctx.rec.eid = kept[0] or wid, kept[1] or eid
    return out, wid, eid


def _slow_run(ctx: Ctx, key: str) -> tuple[RunHandle, str]:
    """The step-3 scenarios' slow run, started and Running: numbers.csv -> a Python UDF
    that prints one line and sleeps 0.1 s per tuple (about 30 s). Returns the handle and
    the UDF's id."""
    wf = ctx.workflow(key)
    scan = wf.add("numbers", "CSVFileScan", csv_scan(ctx.paths["numbers.csv"]), n_in=0)
    udf = wf.add("slow-print", "PythonUDFV2", python_udf(UDF_SLOW_PRINT))
    wf.link(scan, udf)
    handle = ctx.start(wf, view=[udf])
    handle.wait_for_state("Running", timeout=ctx.timeout)
    return handle, udf


def _wait_closed(ctx: Ctx, eid: int) -> tuple[ExecutionState, float]:
    """The execution's state once the Dashboard has closed it (or as it is after
    CLOSE_INTERVALS closing intervals), and the seconds waited."""
    return poll(lambda: ctx.api.execution_state(eid), lambda state: not state.open,
                CLOSE_INTERVALS * ctx.timing.closing_interval_s, ctx.timing.poll_s)


def _is_time(value: Any) -> bool:
    """Whether `value` is a time as the Dashboard sends one: epoch milliseconds."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 1e12 < value < 1e13


# ----------------------------------------------------------- p: record in lake


def _wait_label(ctx: Ctx, wid: int, eid: int, state: str, after_seq: int = 0) -> Label:
    """The label of the execution's log once it names `state` at a seq above `after_seq`
    (or as it is after LABEL_WAIT_S)."""
    label, _ = poll(lambda: Label.of(ctx.lake_table("log", wid, eid)),
                    lambda l: l.state == state and (l.state_seq or 0) > after_seq, LABEL_WAIT_S, 0.25)
    return label


def _check_log_while_running(ctx: Ctx, wid: int, eid: int, labels: list[Label]) -> None:
    """The label, read after each state change, names RUNNING, PAUSED and RUNNING at rising
    seq. From gate 3B on the Dashboard serves the log: READY, RUNNING, PAUSED, RUNNING and
    nothing else (the log holds state changes only), seq rising by one, and no closing
    record. Before that the row count is all the catalog shows: one row per state change."""
    seen = [(l.state, l.state_seq) for l in labels]
    seqs = [l.state_seq or 0 for l in labels]
    ctx.check("while it runs the log's label names RUNNING, PAUSED, RUNNING at rising seq",
              [l.state for l in labels] == ["RUNNING", "PAUSED", "RUNNING"] and seqs == sorted(set(seqs))
              and seqs[0] >= 2, f"label after each state change: {seen}")
    if not ctx.at_least("B"):
        table = ctx.lake_table("log", wid, eid)
        ctx.check("the log holds one row per state change, 4 by now (READY, RUNNING, PAUSED, RUNNING), "
                  "the label's seq",
                  table.records == labels[-1].state_seq == 4, f"{table.describe()}; label {seen[-1]}")
        return
    log = ctx.api.execution_log(eid)
    ctx.check("while it runs /log shows READY, RUNNING, PAUSED, RUNNING and nothing else, with seq rising by one",
              log.states == ["READY", "RUNNING", "PAUSED", "RUNNING"] and log.whole,
              f"states {log.states}; seq {log.seqs}")
    ctx.check("/log has no closing record while the execution is open", not log.closed,
              f"closing: outcome {log.outcome}, reason {log.reason}")


def _check_statistics_grow(ctx: Ctx, handle: RunHandle, wid: int, eid: int, udf: str) -> None:
    commit = ctx.timing.commit_interval_s
    first, _ = poll(lambda: ctx.statistics(wid, eid), bool, FIRST_COMMIT_INTERVALS * commit, ctx.timing.poll_s)
    ctx.check("the statistics endpoint returns rows before the run ends",
              bool(first) and handle.last_state == "Running", f"{len(first)} row(s); state {handle.last_state}")
    gap = STATS_GROWTH_INTERVALS * commit
    time.sleep(gap)
    second = ctx.statistics(wid, eid)
    ctx.check(f"their count grows between two reads {gap:g} s apart, the run still going",
              len(second) > len(first) and handle.last_state == "Running",
              f"{len(first)} then {len(second)} row(s); state {handle.last_state}")
    times = [r.time_ms for r in second]
    ctx.check("the stored rows are per operator, with times in epoch milliseconds",
              udf in {r.operator_id for r in second} and all(_is_time(t) for t in times),
              f"operators {sorted({r.operator_id for r in second})}; times {times[:3]}")


def _check_console_stored(ctx: Ctx, handle: RunHandle, wid: int, eid: int, udf: str) -> None:
    table, _ = poll(lambda: ctx.lake_table("console", wid, eid), lambda t: bool(t.records),
                    FIRST_COMMIT_INTERVALS * ctx.timing.commit_interval_s, ctx.timing.poll_s)
    ctx.check("console lines are stored before the run ends (the console table has a snapshot with rows)",
              table.snapshots >= 1 and bool(table.records) and handle.last_state == "Running",
              f"{table.describe()}; state {handle.last_state}")
    if ctx.at_least("C"):
        page = ctx.api.execution_console(eid, operator_id=udf)
        ctx.check("the console route returns the UDF's stored lines before the run ends",
                  bool(page.messages) and all(m.get("msgType") == "PRINT" for m in page.messages)
                  and handle.last_state == "Running",
                  f"{len(page.messages)} message(s), lastSeq {page.last_seq}; state {handle.last_state}")


#: p reads the finished run's console output in pages of this many messages
CONSOLE_PAGE = 200


def _stored_console(ctx: Ctx, eid: int) -> tuple[list[dict], list[bool]]:
    """An execution's whole stored console output, read page by page, each page after the
    last seq of the one before; and whether each page said more follow."""
    messages: list[dict] = []
    more: list[bool] = []
    while not more or (more[-1] and len(more) < 100):
        page = ctx.api.execution_console(eid, after_seq=messages[-1]["seq"] if messages else 0, limit=CONSOLE_PAGE)
        messages += page.messages
        more.append(page.more and bool(page.messages))
    return messages, more


def _check_console_whole(ctx: Ctx, eid: int, lines: int) -> None:
    """After the run: the console route gives every line once, in order, over its pages.
    The run's last lines are stored a moment after its ending (the recorder writes the
    ending first), so the route is read until it has them all, for at most LABEL_WAIT_S."""
    (messages, more), _waited = poll(lambda: _stored_console(ctx, eid), lambda got: len(got[0]) >= lines,
                                     LABEL_WAIT_S, 0.25)
    seqs = [m.get("seq") for m in messages]
    pages = -(-lines // CONSOLE_PAGE)
    ctx.check(f"after the run the console route returns all {lines} lines in {pages} page(s), seq rising by one",
              seqs == list(range(1, lines + 1)) and more == [True] * (pages - 1) + [False],
              f"{len(messages)} message(s), seq {seqs[:3]} ... {seqs[-3:]}; more per page {more}")


def scenario_p(ctx: Ctx) -> None:
    """A slow run, paused and resumed once. While it runs, its log, statistics and console
    output are in the lake; after it, the log ends COMPLETED. Check I then judges the
    whole record."""
    _need_create_ws(ctx)
    _need_fast_record(ctx)
    handle, udf = _slow_run(ctx, "p-record-in-lake")
    wid, eid = ctx.rec.wid, handle.eid
    handle.wait_until(lambda: handle.output_rows(udf) >= 3, ctx.timeout, "the UDF to emit 3 rows")
    running = _wait_label(ctx, wid, eid, "RUNNING")
    handle.pause()
    handle.wait_for_state("Paused", timeout=120)
    paused = _wait_label(ctx, wid, eid, "PAUSED")
    handle.resume()
    handle.wait_for_state("Running", timeout=120)
    resumed = _wait_label(ctx, wid, eid, "RUNNING", after_seq=paused.state_seq or 0)
    _check_log_while_running(ctx, wid, eid, [running, paused, resumed])
    _check_statistics_grow(ctx, handle, wid, eid, udf)
    _check_console_stored(ctx, handle, wid, eid, udf)
    done = handle.wait_for_state("Completed", timeout=ctx.timeout)
    ctx.check("the run completes", done == "Completed", f"states {handle.states}")
    ended = _wait_label(ctx, wid, eid, "COMPLETED")
    ctx.check("after the run the log's newest state is COMPLETED, at the highest seq",
              ended.state == "COMPLETED" and (ended.state_seq or 0) > (resumed.state_seq or 0),
              f"label {(ended.state, ended.state_seq)}, {(resumed.state, resumed.state_seq)} while it ran")
    if ctx.at_least("B"):
        log = ctx.api.execution_log(eid)
        last = log.entries[-1] if log.entries else None
        ctx.check("after the run /log's last row is COMPLETED, with seq still rising by one",
                  last is not None and (last.kind, last.state) == ("state", "COMPLETED") and log.whole,
                  f"last {last}; seq {log.seqs}")
    if ctx.at_least("C"):
        _check_console_whole(ctx, eid, lines=len(ctx.data["numbers.csv"]))
    ctx.persisted_status(STATUS_COMPLETED, eid=eid)


# ------------------------------------------------------ q, s: the unit goes down


class _Background:
    """A call running beside the scenario. `result()` waits for it and gives what it
    returned, or raises what it raised."""

    def __init__(self, call: Callable[[], Any]):
        self._out: dict[str, Any] = {}
        self._t0 = time.monotonic()
        self._thread = threading.Thread(target=self._run, args=(call,), daemon=True)
        self._thread.start()

    def _run(self, call: Callable[[], Any]) -> None:
        try:
            self._out["value"] = call()
        except Exception as e:  # noqa: BLE001 -- raised again where the scenario asks for the result
            self._out["error"] = e
        self._out["seconds"] = time.monotonic() - self._t0

    def seconds(self) -> float | None:
        """How long the call took, None while it runs."""
        return self._out.get("seconds")

    def result(self) -> Any:
        self._thread.join()
        if "error" in self._out:
            raise self._out["error"]
        return self._out["value"]


def _stored(ctx: Ctx, wid: int, eid: int) -> dict:
    """How much of a run's output is stored: its statistics rows as the Dashboard serves
    them and the rows of its console table. In Kubernetes before gate 3C the unit serves
    the statistics, so only the table's row count can be read while it is down."""
    rows = None if ctx.stats_through_unit else [(r.operator_id, r.time_ms, r.output_count)
                                                for r in ctx.statistics(wid, eid)]
    statistics = len(rows) if rows is not None else ctx.lake_table("statistics", wid, eid).records or 0
    return {"statistics": statistics, "rows": rows, "console": ctx.lake_table("console", wid, eid).records or 0}


def _slow_run_with_stored_output(ctx: Ctx, key: str, label: str) -> tuple[RunHandle, int, int, dict]:
    """A slow run that is Running and has statistics and console output in the lake: what
    a unit can be taken down under. Returns it with its workflow, its execution and what
    is stored of it."""
    handle, _udf = _slow_run(ctx, key)
    wid, eid = ctx.rec.wid, handle.eid
    stored, _ = poll(lambda: _stored(ctx, wid, eid), lambda s: s["statistics"] > 0 and s["console"] > 0,
                     FIRST_COMMIT_INTERVALS * ctx.timing.commit_interval_s, ctx.timing.poll_s)
    ctx.check(f"{label}: the run is Running, with statistics and console output in the lake",
              stored["statistics"] > 0 and stored["console"] > 0 and handle.last_state == "Running",
              f"{stored['statistics']} statistics row(s), {stored['console']} console row(s); "
              f"state {handle.last_state}")
    return handle, wid, eid, stored


def _reading(ctx: Ctx, wid: int, eid: int, t: float) -> dict:
    """The execution's history entry, read `t` seconds after the scenario's event. A
    reading that got no answer says so and is no verdict: the gateway restarts when the
    unit comes back at another address."""
    try:
        entry = ctx.api.execution_entry(wid, eid) or {}
    except (TexeraApiError, requests.RequestException) as e:
        return {"t": round(t, 2), "status": None, "unanswered": f"{type(e).__name__}: {str(e)[:200]}"}
    return {"t": round(t, 2), "status": entry.get("status"), "reason": history_reason(entry),
            "completion": history_completion_ms(entry)}


def _before_verdict(seen: list[dict], verdict: dict | None) -> list[dict]:
    """The readings before the verdict that got an answer."""
    return [r for r in (seen[:-1] if verdict else seen) if "unanswered" not in r]


def _watch_history(ctx: Ctx, wid: int, eid: int, t0: float, give_up_s: float,
                   closed: Callable[[dict], bool] = lambda reading: reading["status"] == STATUS_FAILED) -> list[dict]:
    """Read the execution's history entry every poll interval until it reads as `closed`
    wants it (by default: status 4) or `give_up_s` seconds passed since `t0`. Every
    reading, with the seconds since `t0` at which it was taken."""
    seen = []
    while True:
        seen.append(_reading(ctx, wid, eid, time.monotonic() - t0))
        if closed(seen[-1]) or seen[-1]["t"] >= give_up_s:
            return seen
        time.sleep(ctx.timing.poll_s)


def _check_lost_verdict(ctx: Ctx, label: str, running: dict, seen: list[dict], deadline: float,
                        earliest: float | None) -> None:
    """The readings of a lost execution's history entry (`running`: the one taken before
    the kill): Running, with a completionTime that is a time, until it turns Failed,
    "unit lost", by the deadline and not before the Dashboard can know."""
    verdict = seen[-1] if seen[-1]["status"] == STATUS_FAILED else None
    before = [running] + _before_verdict(seen, verdict)
    ctx.check(f"{label}: until the verdict the history reads status 1, with a completionTime that is a time",
              all(s["status"] == STATUS_RUNNING and _is_time(s.get("completion")) for s in before),
              f"{len(before)} reading(s): {before[:2]} ... {before[-1:]}")
    ctx.check(f"{label}: the history turns status 4, \"{REASON_UNIT_LOST}\", within {deadline:g} s",
              verdict is not None and verdict["t"] <= deadline and verdict["reason"] == REASON_UNIT_LOST,
              f"last reading {seen[-1]}")
    if earliest is not None:
        ctx.check(f"{label}: the verdict does not come before the beat stood still for lost-after "
                  f"({earliest:.1f} s after the kill at the earliest)",
                  verdict is None or verdict["t"] >= earliest, f"verdict {verdict}")


def _check_read_back(ctx: Ctx, label: str, wid: int, eid: int, before: dict) -> None:
    """Right after the kill: what the run had stored is still there, with its unit gone.
    (Later its console table goes with its results: they expire by age, counted from the
    unit's last beat.)"""
    after = _stored(ctx, wid, eid)
    kept = after["rows"] is None or after["rows"][:len(before["rows"])] == before["rows"]
    ctx.check(f"{label}: statistics and console output written before the kill read back",
              kept and after["statistics"] >= before["statistics"] and after["console"] >= before["console"],
              f"statistics {before['statistics']} -> {after['statistics']} row(s), the earlier rows "
              f"{'kept' if kept else 'changed'}; console {before['console']} -> {after['console']} row(s)")


def _check_lost_record(ctx: Ctx, label: str, wid: int, eid: int, before: dict, killed_at_ms: float) -> dict | None:
    """What the Dashboard tells of an execution it closed as lost. Returns its history entry."""
    state = ctx.api.execution_state(eid)
    ctx.check(f"{label}: /state says closed, status 4, \"{REASON_UNIT_LOST}\"",
              (state.open, state.status, state.reason) == (False, STATUS_FAILED, REASON_UNIT_LOST), f"{state}")
    log = ctx.api.execution_log(eid)
    last = log.entries[-1] if log.entries else None
    ctx.check(f"{label}: /log has no ending row, and a closing record with the verdict",
              last is not None and last.state not in LOGGED_ENDINGS and log.closed
              and (log.outcome, log.reason) == (STATUS_FAILED, REASON_UNIT_LOST),
              f"last row {last}; closing: outcome {log.outcome}, reason {log.reason}")
    statistics = ctx.lake_table("statistics", wid, eid)
    ctx.check(f"{label}: its statistics are still in the lake once it is closed",
              (statistics.records or 0) >= before["statistics"],
              f"{statistics.describe()}; {before['statistics']} row(s) before the kill")
    entry = ctx.api.execution_entry(wid, eid)
    completion = history_completion_ms(entry or {})
    # The execution ended at its unit's last beat (design D43): after its last state change,
    # and before the kill (a commit interval is allowed for the clocks to differ).
    latest = killed_at_ms + 1000 * ctx.timing.commit_interval_s
    ctx.check(f"{label}: completionTime is the last beat: not before the last state change, not after the kill",
              last is not None and _is_time(completion) and (last.time_ms or 0) <= completion <= latest,
              f"completionTime {completion}; last state change {last.time_ms if last else None}; "
              f"the kill had returned at {killed_at_ms:.0f}")
    return entry


def _lose_unit(ctx: Ctx, label: str, key: str, *, back_at_once: bool = False, list_units: bool = False) -> dict:
    """Kill the unit under a slow run and follow the execution until the Dashboard closes
    it. The unit comes back after the verdict, or (`back_at_once`) is started again right
    after the kill. `list_units`: the units are listed once after the kill, as the
    workspace does when its socket drops, so the platform notices the unit is gone.
    Returns the workflow, the execution and its history entry.

    Under step 3's negative control the product is the old one, which stores nothing in
    the lake while a run goes and has none of step 3's routes: only how long the
    history keeps saying Running is followed."""
    timing = ctx.timing
    if ctx.negative_control:
        handle, _udf = _slow_run(ctx, key)
        wid, eid, before = ctx.rec.wid, handle.eid, None
    else:
        handle, wid, eid, before = _slow_run_with_stored_output(ctx, key, label)
    ctx.record_left_as_is(eid, "RUNNING", "its unit was killed under it")
    running = _reading(ctx, wid, eid, 0.0)
    asked = time.monotonic()
    ctx.log(f"  {label}: killing the unit: {ctx.stack.kill_unit()}")
    killed, killed_at_ms = time.monotonic(), time.time() * 1000
    restart = _Background(ctx.stack.start_unit) if back_at_once else None
    try:
        if before is not None:
            _check_read_back(ctx, label, wid, eid, before)
        if list_units:
            ctx.api.list_units()
            t0, deadline, earliest = time.monotonic(), 2 * timing.closing_interval_s, None
        else:
            # The Dashboard counts its own ticks while the beat stands still. The last beat
            # was up to a commit interval before the kill, and a tick is allowed for a job
            # that counts the tick at which it first saw that beat.
            t0, deadline = killed, timing.lost_verdict_s
            earliest = timing.lost_watch_s - timing.commit_interval_s - timing.closing_interval_s - (killed - asked)
        seen = _watch_history(ctx, wid, eid, t0, deadline + 2 * timing.closing_interval_s)
        ctx.rec.facts.setdefault("lost_verdicts", []).append(
            {"pass": label, "eid": eid, "deadline_s": deadline, "earliest_s": earliest, "before_the_kill": running,
             "readings": seen})
        _check_lost_verdict(ctx, label, running, seen, deadline, earliest)
        if restart is not None and restart.seconds() is not None:
            ctx.note(f"{label}: the unit was back {restart.seconds():.1f} s after the kill, the last reading "
                     f"of the history was taken at {seen[-1]['t']} s")
    finally:
        ctx.unit_is_back(restart.result() if restart is not None else ctx.stack.start_unit())
    entry = _check_lost_record(ctx, label, wid, eid, before, killed_at_ms) if before is not None else None
    return {"label": label, "wid": wid, "eid": eid, "entry": entry}


def stayed_running(rec: ScenarioRecord) -> tuple[bool, str]:
    """Step 3's negative control on q (design H5): on the old product nothing closes a lost
    unit's execution, so its history must still say Running past the deadline by which
    the new one says "unit lost". (Whether it held, what was seen.)"""
    verdict = next(iter(rec.facts.get("lost_verdicts") or []), None)
    if verdict is None:
        return False, "control inconclusive: the unit was never killed under a run (the scenario stopped before)"
    answered = [r for r in verdict["readings"] if "unanswered" not in r]
    statuses = sorted({r["status"] for r in answered}, key=str)
    last = answered[-1] if answered else {"t": 0}
    if statuses == [STATUS_RUNNING] and last["t"] >= verdict["deadline_s"]:
        return True, (f"failed as expected: the history still says status 1 {last['t']} s after the kill, past "
                      f"the deadline of {verdict['deadline_s']:g} s ({len(answered)} readings)")
    if STATUS_FAILED in statuses:
        return False, f"PASSED, so the control proves nothing: the execution was closed ({last})"
    return False, (f"control inconclusive: the history read status {statuses} over {len(answered)} reading(s), "
                   f"the last {last['t']} s after the kill (deadline {verdict['deadline_s']:g} s)")


def scenario_q(ctx: Ctx) -> None:
    """The unit is killed under a slow run, twice: left down until the verdict, and
    started again right after the kill. Both times the Dashboard closes the execution
    "failed: unit lost" once the beat has stood still for lost-after, and what the run
    had stored reads back. The unit that is back holds no run, runs a new one, and the
    lost executions stay as they were closed. Where the platform notices a unit that is
    gone (Kubernetes), a third pass lists the units after the kill and the verdict comes
    at once."""
    _need_create_ws(ctx)
    _need_fast_record(ctx)
    _need_level(ctx, "B")
    _need_stack(ctx)
    if ctx.negative_control:  # one pass tells: the old product closes nothing
        _lose_unit(ctx, "unit left down", "q-unit-lost")
        return
    lost = [_lose_unit(ctx, "unit left down", "q-unit-lost"),
            _lose_unit(ctx, "unit back at once", "q-unit-lost-and-back", back_at_once=True)]
    watcher = ctx.transport.open_socket(lost[-1]["wid"], ctx.cuid)
    ctx.handles.append(watcher)
    opened = watcher.replayed
    ctx.check("unit back at once: the unit holds no run of the workflow (a new socket is told Uninitialized, "
              "naming no execution)", opened.get("states") == ["Uninitialized"] and watcher.eid is None,
              f"{opened}")
    _part(ctx, "a", scenario_a)
    for run in lost:
        entry = ctx.api.execution_entry(run["wid"], run["eid"])
        ctx.check(f"{run['label']}: after a run on the unit that is back, the lost execution is unchanged",
                  entry is not None and entry == run["entry"], f"{run['entry']} -> {entry}")
    if ctx.stack.listing_notices_lost_unit:
        _lose_unit(ctx, "units listed after the kill", "q-unit-lost-and-listed", list_units=True)


def scenario_s(ctx: Ctx) -> None:
    """The unit is stopped politely under a slow run: it records the ending itself, so the
    Dashboard closes the execution "failed: the computing unit was stopped" at its next
    tick, long before it could call the unit lost."""
    _need_create_ws(ctx)
    _need_fast_record(ctx)
    _need_level(ctx, "B")
    _need_stack(ctx)
    handle, wid, eid, _stored_before = _slow_run_with_stored_output(ctx, "s-polite-stop", "s")
    ctx.record_left_as_is(eid, "FAILED", "its unit was stopped under it")
    ctx.log(f"  stopping the unit: {ctx.stack.stop_unit()}")
    try:
        # The history reads the ending from the log's label as soon as the unit wrote it;
        # why it ended is in the closing record, which the Dashboard writes at its next tick.
        deadline = 2 * ctx.timing.closing_interval_s
        seen = _watch_history(ctx, wid, eid, time.monotonic(), deadline + ctx.timing.closing_interval_s,
                              closed=lambda r: r["status"] == STATUS_FAILED and r.get("reason") is not None)
        ctx.rec.facts["stop_verdict"] = {"eid": eid, "deadline_s": deadline, "readings": seen}
        ctx.check(f"the history turns status 4, \"{REASON_UNIT_STOPPED}\", within 2 closing intervals "
                  f"({deadline:g} s) of the stop",
                  (seen[-1]["status"], seen[-1].get("reason")) == (STATUS_FAILED, REASON_UNIT_STOPPED)
                  and seen[-1]["t"] <= deadline, f"last reading {seen[-1]}")
        log = ctx.api.execution_log(eid)
        last = log.entries[-1] if log.entries else None
        ctx.check("/log ends with a FAILED row carrying that reason",
                  last is not None and (last.kind, last.state, last.reason) == ("state", "FAILED",
                                                                                  REASON_UNIT_STOPPED),
                  f"last row {last}")
    finally:
        ctx.unit_is_back(ctx.stack.start_unit())


# -------------------------------------------------------- r: never started


def scenario_r(ctx: Ctx) -> None:
    """An execution that is created and never started: the Dashboard closes it "failed:
    never started" once it is older than never-started-after, taking its one start, so a
    start that comes later is refused."""
    _need_create_ws(ctx)
    _need_fast_record(ctx)
    _need_level(ctx, "B")
    timing = ctx.timing
    wf, src = _tiny(ctx, "r-never-started")
    wid = ctx.create_workflow(wf)
    t0 = time.monotonic()
    created = _created(ctx, wf, [src], wid)
    eid = ctx.rec.eid = created["eid"]
    deadline = timing.never_started_verdict_s
    seen = _watch_history(ctx, wid, eid, t0, deadline + timing.closing_interval_s)
    ctx.rec.facts["never_started_verdict"] = {"eid": eid, "deadline_s": deadline, "readings": seen}
    verdict = seen[-1] if seen[-1]["status"] == STATUS_FAILED else None
    before = _before_verdict(seen, verdict)
    ctx.check(f"until then the history reads status {ctx.unstarted_status}: created, and not started",
              bool(before) and all(s["status"] == ctx.unstarted_status for s in before),
              f"{before[:2]} ... {before[-1:]}")
    ctx.check(f"the history turns status 4, \"{REASON_NEVER_STARTED}\", within never-started-after + 2 closing "
              f"intervals ({deadline:g} s) of the create",
              verdict is not None and verdict["t"] <= deadline and verdict["reason"] == REASON_NEVER_STARTED,
              f"last reading {seen[-1]}")
    # The row's age counts from its creation, which is after t0; a second is allowed for
    # a creation time kept to the second.
    earliest = timing.never_started_after_s - 1
    ctx.check(f"... and not before it is older than never-started-after ({earliest:g} s at the earliest)",
              verdict is None or verdict["t"] >= earliest, f"verdict {verdict}")
    state = ctx.api.execution_state(eid)
    ctx.check(f"/state says closed, status 4, \"{REASON_NEVER_STARTED}\"",
              (state.open, state.status, state.reason) == (False, STATUS_FAILED, REASON_NEVER_STARTED), f"{state}")
    plan = ctx.lake_table("plan", wid, eid)
    ctx.check("the plan table has the `started` tag: the Dashboard took the execution's one start",
              "started" in plan.refs, f"{plan.describe()}; refs {sorted(plan.refs)}")
    _refused_start(ctx, "a start after that", "already started", wid=wid, eid=eid, plan_uri=created["planUri"],
                   row_status=STATUS_FAILED)


# ---------------------------------------------------------------- t: expiry

#: an execution's tables that its expiry keeps, and the ones it drops (design D31)
KEPT_TABLES = ("plan", "log", "statistics")
DROPPED_TABLES = ("result", "state", "console")


def _dropped_tables(ctx: Ctx, wid: int, eid: int) -> dict[str, int | None]:
    """How many result tables, state tables and console tables the execution has in the
    lake (None: the namespace could not be listed)."""
    counts: dict[str, int | None] = {}
    for kind in ("result", "state"):
        names, _why = ctx.lake.port_tables(ctx.warehouse_name, wid, eid, kind)
        counts[kind] = None if names is None else len(names)
    counts["console"] = int(ctx.lake_table("console", wid, eid).exists)
    return counts


def _kept_tables(ctx: Ctx, wid: int, eid: int) -> dict[str, TableState]:
    return {kind: ctx.lake_table(kind, wid, eid) for kind in KEPT_TABLES}


def _wait_tidied(ctx: Ctx, wid: int, eid: int) -> None:
    """Wait (at most LABEL_WAIT_S) for the end tidy of the execution's log and statistics:
    their sizes, which the expiry adds up, do not change after it."""
    poll(lambda: [ctx.lake_table(kind, wid, eid) for kind in ("log", "statistics")],
         lambda tables: all((t.data_files, t.snapshots) == (1, 1) for t in tables), LABEL_WAIT_S, 0.25)


def _closed_with_results(ctx: Ctx, label: str, wid: int, eid: int) -> int | None:
    """A completed execution, once closed and before anything expired: closed Completed,
    its results in the lake, and a size. Returns the size."""
    state, _waited = _wait_closed(ctx, eid)
    ctx.check(f"{label}: closed, status 3", (state.open, state.status) == (False, STATUS_COMPLETED), f"{state}")
    tables = _dropped_tables(ctx, wid, eid)
    ctx.check(f"{label}: its result, state and console tables are in the lake",
              all(tables[kind] for kind in DROPPED_TABLES), f"{tables}")
    size = ctx.api.quota_sizes().get(eid)
    ctx.check(f"{label}: the quota page counts its stored bytes", bool(size), f"storedBytes {size}")
    _wait_tidied(ctx, wid, eid)
    return size


def _check_expired(ctx: Ctx, label: str, wid: int, eid: int, size_before: int | None, sink: str) -> None:
    """An execution whose results expired: the result, state and console tables are gone,
    the plan, the log and the statistics stay, it still reads Completed, and it holds
    what those three hold (design 4.4: the sizes the catalog keeps of them, added up).
    From gate 3C an export of its `sink` says so."""
    tables = _dropped_tables(ctx, wid, eid)
    ctx.check(f"{label}: its result and state tables are gone from the lake, and its console table",
              tables == dict.fromkeys(DROPPED_TABLES, 0), f"{tables}")
    kept = _kept_tables(ctx, wid, eid)
    ctx.check(f"{label}: its plan, log and statistics are still there", all(t.exists for t in kept.values()),
              "; ".join(t.describe() for t in kept.values()))
    state = ctx.api.execution_state(eid)
    ctx.check(f"{label}: /state still says Completed", (state.open, state.status) == (False, STATUS_COMPLETED),
              f"{state}")
    size = ctx.api.quota_sizes().get(eid)
    left = sum(t.size_bytes or 0 for t in kept.values())
    ctx.check(f"{label}: storedBytes fell, to what the plan, the log and the statistics hold",
              bool(size_before) and size == left and size < size_before,
              f"storedBytes {size_before} -> {size}; the three tables hold {left} bytes")
    if ctx.at_least("C"):
        answer = ctx.api.export_local(wid, eid, [sink])
        ctx.check(f"{label}: an export answers 410, the results of the execution have expired",
                  answer.status_code == 410 and f"execution {eid}" in answer.text and "expired" in answer.text,
                  f"HTTP {answer.status_code}: {answer.text[:300]}")


def _results_gone(ctx: Ctx, wid: int, eid: int, within_s: float) -> int | None:
    """How many result tables the execution has left, once it has none or `within_s` passed."""
    tables, _ = poll(lambda: _dropped_tables(ctx, wid, eid), lambda t: t["result"] == 0, within_s, ctx.timing.poll_s)
    return tables["result"]


def scenario_t(ctx: Ctx) -> None:
    """Scenario a's workflow as one workflow, three executions. The first one's results go
    once the second has started: a later run replaces them. The second one's results stay
    while the third is created and never started, and go by age. Either way the plan, the
    log and the statistics stay. (What replaces results is not the design's revision 2,
    where the next create did: docs/step3-notes/changes-since-rev2.md, section 4.)"""
    _need_create_ws(ctx)
    _need_fast_record(ctx)
    _need_level(ctx, "B")
    timing = ctx.timing
    wf, ops, expected, _passed = _workflow_a(ctx, "t-expiry")
    wid, sink = ctx.create_workflow(wf), ops["aggregate"]

    first, res = run_to_completion(ctx, wf, sink, wid=wid)
    first_ended = time.monotonic()
    _check_groups(ctx, res, expected)
    size = _closed_with_results(ctx, "first execution", wid, first.eid)
    ctx.settle_records()
    created = _created(ctx, wf, [sink], wid)
    second = ctx.transport.start_existing(wid=wid, cuid=ctx.cuid, eid=created["eid"], plan_uri=created["planUri"])
    ctx.handles.append(second)
    started = time.monotonic()
    left = _results_gone(ctx, wid, first.eid, timing.replaced_verdict_s)
    now = time.monotonic()
    ctx.check(f"first execution: the second, once started, replaces its results: they are gone within a commit "
              f"interval + one expiry pass + 2 closing intervals ({timing.replaced_verdict_s:g} s) of that start, "
              f"at an age under the TTL (it was not their age)",
              left == 0 and now - first_ended < timing.result_ttl_s,
              f"result tables {left} at {now - started:.1f} s after the start, {now - first_ended:.1f} s after "
              f"the first run ended; the TTL is {timing.result_ttl_s:g} s")
    _check_expired(ctx, "first execution, replaced", wid, first.eid, size, sink)

    done = second.wait_for_state("Completed", timeout=ctx.timeout)
    second_ended = time.monotonic()
    ctx.check("second execution: completes", done == "Completed", f"states {second.states}")
    size = _closed_with_results(ctx, "second execution", wid, second.eid)
    ctx.settle_records()
    third = _created(ctx, wf, [sink], wid)["eid"]
    ctx.allow_status_zero(third, "t: created and left unstarted on purpose")
    deadline = timing.expired_verdict_s
    left = _results_gone(ctx, wid, second.eid, deadline - (time.monotonic() - second_ended))
    gone_after = time.monotonic() - second_ended
    ctx.check(f"second execution: a third that is created and never started replaces nothing, and its results "
              f"expire by age: within the TTL + one expiry pass + 2 closing intervals ({deadline:g} s) of its "
              f"end, and not before the TTL",
              left == 0 and timing.result_ttl_s - 1 <= gone_after,
              f"result tables {left} at {gone_after:.1f} s after the run ended; execution {third} was created "
              f"and not started")
    _check_expired(ctx, "second execution, after the TTL", wid, second.eid, size, sink)
    ctx.rec.eid = second.eid


# ------------------------------------------------------ w: history outcomes


def udf_raises_on_load(message: str) -> str:
    """A UDF whose module raises as the worker loads it. The engine reports that as a
    fatal error and the run fails; a raise in process_tuple would only pause the worker
    and leave the run Running (see "Python exceptions do not end a run" in the README)."""
    return f'''from pytexera import *

raise RuntimeError("{message}")


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        yield tuple_
'''


def _run_that_raises(ctx: Ctx, message: str) -> None:
    wf = ctx.workflow("w-udf-raises")
    src = wf.add("one-line", "TextInput", text_input(["sce-e2e"]), n_in=0)
    udf = wf.add("raises", "PythonUDFV2", python_udf(udf_raises_on_load(message)))
    wf.link(src, udf)
    handle = ctx.start(wf, view=[udf])
    try:
        state = handle.wait_for_state("Failed", timeout=ctx.timeout, fail_fast=False)
        handle.wait_until(lambda: bool(handle.fatal_errors), 10, "the fatal error", fail_fast=False)
    except (RunFailed, RunTimeout):
        state = handle.last_state
    errors = [str(e.get("message")) for e in handle.fatal_errors]
    ctx.check("the run fails with the Python error", state == "Failed" and any(message in e for e in errors),
              f"states {handle.states}; errors {errors[:2]}")


def scenario_w(ctx: Ctx) -> None:
    """How runs ended, as the history and the admin's list tell it: after d (killed), k (a
    compile error), a (completed) and a UDF that raises as it is loaded."""
    _need_create_ws(ctx)
    _need_fast_record(ctx)
    _need_level(ctx, "B")
    raised = f"sce-e2e w {ctx.hex}: raised on purpose"
    parts: dict[str, Callable[[Ctx], Any]] = {
        "d": scenario_d, "k": scenario_k, "a": scenario_a, "a UDF that raises": lambda c: _run_that_raises(c, raised)}
    # what the history must say of each: its status, the admin list's name for it, and its reason
    expected: dict[str, tuple[int, str, str, Callable[[str | None], bool]]] = {
        "d": (STATUS_KILLED, "KILLED", f"\"{REASON_KILLED_BY_USER}\"", lambda r: r == REASON_KILLED_BY_USER),
        "k": (STATUS_FAILED, "FAILED", f"\"{REASON_COMPILE_ERROR}...\" naming the column",
              lambda r: bool(r) and r.startswith(REASON_COMPILE_ERROR) and "sce_no_such_column" in r),
        "a": (STATUS_COMPLETED, "COMPLETED", "no reason", lambda r: not r),
        "a UDF that raises": (STATUS_FAILED, "FAILED", "the Python error's first line",
                              lambda r: bool(r) and raised in r),
    }
    runs = {key: _part(ctx, key, body)[1:] for key, body in parts.items()}
    closed = {key: _wait_closed(ctx, eid)[0] for key, (_wid, eid) in runs.items() if eid is not None}
    admin = ctx.api.admin_executions(wid for wid, _eid in runs.values() if wid is not None)
    for key, (wid, eid) in runs.items():
        status, name, reason_says, reason_ok = expected[key]
        if key not in closed:
            ctx.check(f"{key}: left an execution to look at", False, f"workflow {wid}, execution {eid}")
            continue
        entry = ctx.api.execution_entry(wid, eid) or {}
        ctx.check(f"{key}: the history says {status}, {reason_says}",
                  not closed[key].open and entry.get("status") == status and reason_ok(history_reason(entry)),
                  f"status {entry.get('status')}, reason {history_reason(entry)!r}, open {closed[key].open}")
        listed = admin.get(wid)
        ctx.check(f"{key}: the admin's list agrees",
                  listed is not None and (listed.eid, listed.status_name) == (eid, name) and reason_ok(listed.reason),
                  f"{listed}")
    killed = runs["d"][1]
    log = ctx.api.execution_log(killed) if killed is not None else None
    last = log.entries[-1] if log and log.entries else None
    ctx.check("d's log is READY, RUNNING, PAUSED, RUNNING, KILLED, the kill by the user",
              log is not None and log.states == ["READY", "RUNNING", "PAUSED", "RUNNING", "KILLED"]
              and last.reason == REASON_KILLED_BY_USER,
              f"states {log.states if log else None}; last reason {last.reason if last else None}")


# ------------------------------------------ v: stored reads without the unit


def _answer(call: Callable[[], Any]) -> tuple[Any, str]:
    """What a route answers, or why it did not."""
    try:
        return call(), ""
    except (TexeraApiError, requests.RequestException) as e:
        return None, f"{type(e).__name__}: {str(e)[:300]}"


def _export_rows(text: str) -> tuple[list[str], list[dict]]:
    """The header and the rows of a CSV export; a cell that reads as a number is one."""
    def cell(value: str) -> Any:
        for number in (int, float):
            try:
                return number(value)
            except ValueError:
                pass
        return value
    table = list(csv.reader(io.StringIO(text)))
    header = table[0] if table else []
    return header, [dict(zip(header, map(cell, row))) for row in table[1:]]


def _check_unit_down(ctx: Ctx, wid: int) -> None:
    try:
        ctx.transport.open_socket(wid, ctx.cuid).close()
        refused = ""
    except Exception as e:  # noqa: BLE001 -- however the gateway refuses, the unit did not answer
        refused = f"{type(e).__name__}: {str(e)[:200]}"
    ctx.check("the unit is down: a new socket to it is refused", bool(refused),
              refused or "the unit answered a new socket")


def _check_stored_reads(ctx: Ctx, printed: dict, e_eid: int, e_ended: float, grouped: dict, a_wid: int,
                        a_eid: int, a_ended: float) -> None:
    """What the Dashboard serves of e's and a's executions while their unit is down. The
    console output and the export go first: they are gone once the results expire by
    age, so each check says how old they were when it read them."""
    def aged(ended: float) -> str:
        return (f"read {time.monotonic() - ended:.0f} s after the run ended; its results expire "
                f"{ctx.timing.result_ttl_s:g} s after it")
    marks = ctx.rec.facts.setdefault("gateway_markers", [])

    page, why = _answer(lambda: ctx.api.execution_console(e_eid))
    messages = page.messages if page else []
    texts = [f"{m.get('title') or ''}{m.get('message') or ''}" for m in messages]
    missing = [line for line in printed["lines"] if not any(line in t for t in texts)]
    ctx.check(f"console: the console route returns e's {len(printed['lines'])} lines, all PRINT, of its UDF",
              len(messages) == len(printed["lines"]) and not missing and not page.more
              and all((m.get("msgType"), m.get("operatorId")) == ("PRINT", printed["udf"]) for m in messages),
              why or f"{len(messages)} message(s), missing {missing[:2]}, "
                     f"types {sorted({str(m.get('msgType')) for m in messages})}; {aged(e_ended)}")

    marker = f"v-export-{ctx.run_id}-{ctx.hex}"
    answer = ctx.api.export_local(a_wid, a_eid, [grouped["ops"]["aggregate"]], "csv", probe=marker)
    marks.append({"what": "export", "marker": marker, "status": answer.status_code})
    header, rows = _export_rows(answer.text) if answer.status_code == 200 else ([], [])
    differ = diff_rows(rows, grouped["expected"], ordered=False)
    ctx.check("export: a local CSV export of a's aggregate gives its columns and exactly its groups",
              answer.status_code == 200 and header == ["department", "total_salary", "n"] and not differ,
              (f"HTTP {answer.status_code}: {answer.text[:300]}" if answer.status_code != 200
               else f"columns {header}; {differ or rows}") + f"; {aged(a_ended)}")

    marker = f"v-statistics-{ctx.run_id}-{ctx.hex}"
    stats, why = _answer(lambda: ctx.api.execution_statistics(a_wid, a_eid, probe=marker))
    marks.append({"what": "statistics", "marker": marker, "status": 200 if stats is not None else None})
    newest = max((r for r in stats or [] if r.operator_id == grouped["ops"]["filter"]),
                 key=lambda r: r.time_ms or 0, default=None)
    ctx.check(f"statistics: the Filter's newest stored row reports its {grouped['passed']} output rows",
              newest is not None and newest.output_count == grouped["passed"],
              why or f"{len(stats or [])} row(s); the Filter's newest {newest}")

    for key, eid in (("e", e_eid), ("a", a_eid)):
        state, why = _answer(lambda: _wait_closed(ctx, eid)[0])
        ctx.check(f"state: {key}'s execution is closed, Completed",
                  state is not None and (state.open, state.status) == (False, STATUS_COMPLETED), why or f"{state}")
    log, why = _answer(lambda: ctx.api.execution_log(a_eid))
    states = log.states if log else []
    ctx.check("log: a's log reads READY, RUNNING, COMPLETED, seq rising by one, with its closing record",
              states == ["READY", "RUNNING", "COMPLETED"] and log.whole and log.outcome == STATUS_COMPLETED,
              why or f"states {states}; seq {log.seqs}; closing outcome {log.outcome}")


def scenario_v(ctx: Ctx) -> None:
    """e and a run to their ends, then the unit is stopped. With the unit down the
    Dashboard still serves what the runs stored: e's console output, an export of a's
    result, a's statistics, both states and a's log. a runs last and e first (a is the
    quicker one): the console output and the result are gone once they expire by age."""
    _need_create_ws(ctx)
    _need_level(ctx, "C")
    _need_stack(ctx)
    printed, _e_wid, e_eid = _part(ctx, "e", scenario_e)
    e_ended = time.monotonic()
    grouped, a_wid, a_eid = _part(ctx, "a", scenario_a)
    a_ended = time.monotonic()
    if e_eid is None or a_eid is None:
        raise RuntimeError(f"v needs the executions of e and a to read back; got {e_eid} and {a_eid}")
    for handle in ctx.handles:  # as a browser's tabs closed: the unit has no socket to end when it stops
        handle.close()
    ctx.log(f"  stopping the unit: {ctx.stack.stop_unit()}")
    try:
        _check_unit_down(ctx, a_wid)
        _check_stored_reads(ctx, printed, e_eid, e_ended, grouped, a_wid, a_eid, a_ended)
    finally:
        ctx.unit_is_back(ctx.stack.start_unit())


SCENARIOS: dict[str, tuple[str, str, Callable[[Ctx], Any]]] = {
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
    # step 2 (design section 7 H3)
    "g0": ("environment-legacy",
           "environment built through /api/pve/db + /wsapi/pve; the UDF imports tabulate 0.9.0", scenario_g0),
    "j": ("modify-while-paused",
          "pause, change a UDF's code (v1 -> v2), resume; 403/409 refusals on create-ws", scenario_j),
    "k": ("compile-error-from-create",
          "Projection of a missing column: create 400 on that operator; row FAILED", scenario_k),
    "l1": ("refuse-unknown-unit", "create on an unknown unit: 403, no row", scenario_l1),
    "l2": ("refuse-other-user-workflow", "another user creates on texera's workflow: 403", scenario_l2),
    "l3": ("refuse-other-user-unit", "another user creates on texera's unit: 403", scenario_l3),
    "l4": ("refuse-terminated-unit", "create on a terminated unit: 409", scenario_l4),
    "l5": ("refuse-other-user-start", "another user starts texera's execution: refused", scenario_l5),
    "l6": ("refuse-other-plan-uri", "a start naming another execution's planUri: refused", scenario_l6),
    "l7": ("refuse-other-warehouse", "create naming another user's warehouse: 400", scenario_l7),
    "l8": ("refuse-second-start", "start a completed execution again: already started", scenario_l8),
    "l9": ("refuse-other-unit-socket", "start on texera's second unit a plan made for the first",
           scenario_l9),
    "l10": ("refuse-foreign-warehouse-uri", "a planUri in another user's warehouse: refused", scenario_l10),
    "m": ("replay", "replay refusals (400); with --with-replay-log a replay run", scenario_m),
    "o": ("agent-sync-run", "create with a target, then the unit's POST /api/execution/{eid}/run",
          scenario_o),
    "f": ("file-lister-scan", "File Lister -> File Scan From Input: the dataset's files", scenario_f),
    "f2": ("file-scan-needs-lister", "File Scan From Input without a File Lister: create 400", scenario_f2),
    "g": ("environment-install", "an environment installed at Run, reused by the next run", scenario_g),
    "h": ("environment-broken", "an environment pip cannot install: the run fails with pip's message",
          scenario_h),
    "i": ("environment-missing", "a UDF naming an environment the user lacks: create 400", scenario_i),
    # step 3 (design section 7 H3)
    "p": ("record-in-lake", "a slow run, paused and resumed: its log, statistics and console are in the "
                            "lake while it runs", scenario_p),
    "q": ("unit-lost", "the unit is killed under a slow run: the execution is closed \"unit lost\"",
          scenario_q),
    "r": ("never-started", "an execution nobody starts is closed \"never started\", and cannot be started",
          scenario_r),
    "s": ("polite-stop", "the unit is stopped under a slow run: it records \"the computing unit was stopped\"",
          scenario_s),
    "t": ("expiry", "results go once a later run has started, and by age; the plan, the log and the statistics stay",
          scenario_t),
    "w": ("history-outcomes", "the history and the admin's list say how runs ended, and why", scenario_w),
    "v": ("stored-reads-without-unit", "with the unit down the Dashboard serves statistics, console output, "
                                       "the log, the state and an export", scenario_v),
}

#: the scenarios run when none is selected (both transports): today's baseline
BASELINE = ["a", "b", "c", "d", "e", "u"]
#: scenarios that run only on create-ws (the Dashboard creates executions)
CREATE_WS_ONLY = {"k", "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10", "m", "o",
                  "f", "f2", "g", "h", "i", "p", "q", "r", "s", "t", "w", "v"}
#: step 3's scenarios: named, or selected by a step-3 gate; `all` stays what it was
STEP3 = {"p", "q", "r", "s", "t", "w", "v"}
#: group keys
GROUPS = {"l": [f"l{i}" for i in range(1, 11)]}
#: what each scenario needs from the driver's setup
NEEDS_OTHER_USER = {"j", "l2", "l3", "l5", "l7", "l10"}
NEEDS_UNIT2 = {"l9"}


def applicable(transport: str, legacy_env: bool) -> list[str]:
    """`--scenario all`: on ws the baseline as before (j runs on ws when named); on
    create-ws every scenario of step 2 (step 3's are named, or come with their gate).
    g0 only with --legacy-env."""
    keys = [k for k in SCENARIOS if k not in STEP3] if transport == "create-ws" else BASELINE + ["g0"]
    return [k for k in keys if k != "g0" or legacy_env]


def resolve(selection: list[str], transport: str = "ws", legacy_env: bool = False) -> list[str]:
    """Keys from --scenario items (keys, names, groups, `all`). Nothing selected: the
    baseline (plus g0 with --legacy-env); `all`: every scenario the transport runs."""
    if not selection:
        return BASELINE + (["g0"] if legacy_env else [])
    by_name = {v[0]: k for k, v in SCENARIOS.items()}
    keys = []
    for item in selection:
        for s in item.split(","):
            s = s.strip()
            if not s:
                continue
            if s == "all":
                keys.extend(applicable(transport, legacy_env))
            elif s in GROUPS:
                keys.extend(GROUPS[s])
            elif s in SCENARIOS:
                keys.append(s)
            elif s in by_name:
                keys.append(by_name[s])
            else:
                raise SystemExit(f"unknown scenario '{s}'; choose from "
                                 + ", ".join(f"{k} ({v[0]})" for k, v in SCENARIOS.items())
                                 + "; groups: " + ", ".join(GROUPS))
    keys = list(dict.fromkeys(keys))
    if "g0" in keys and not legacy_env:
        raise SystemExit("scenario g0 drives the legacy environment path; add --legacy-env")
    return keys


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
        # Check I reads the records of the scenario's runs while its sockets are open: the
        # unit lets go of a run, and of its console table, once nobody watches it.
        ctx.settle_records()
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
