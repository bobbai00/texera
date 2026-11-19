"""Offline tests of the step-3 evidence (driver/evidence.py, Checks G to K of the step-3
design): first each check alone, against a fake `docker` whose catalog is a fake lake
that a fake recorder writes into, whose Postgres log holds the statements a test puts
there and whose Postgres answers the closing records a test gives it; then scenarios and
evidence together, as e2e.py runs them, on the fake Texera at a step-3 gate; then step
3's negative control, on the fake at the end of step 2.

Every check is shown to fail for the reason it exists: the fake is given one fault at a
time (fake_record.FAULTS, fake_closing.FAULTS, fake_texera.FAULTS) and the check must
name it.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import evidence as ev  # noqa: E402
from fake_lake import FakeLake  # noqa: E402
from fake_record import NAMESPACES, Recorder, table_name  # noqa: E402
from record_timing import RecordTiming  # noqa: E402
from test_evidence import DASH_IP, UNIT_IP, FakeDocker, Handle  # noqa: E402
from test_scenario_evidence import EvidenceCase, StackDocker  # noqa: E402
from test_step3_scenarios import FAST  # noqa: E402
from texera_api import ExecutionLog  # noqa: E402

WAREHOUSE = "user-1-7"


class LakeCatalog:
    """For a fake `docker`: `curl` of the catalog is answered by a fake lake (`self.lake`)."""

    def _call(self, args):
        if args[0] == "exec" and "curl" in args:
            status, body = self.lake.rest(args[-1].split("/catalog", 1)[1])
            return subprocess.CompletedProcess(args, 0, f"{json.dumps(body)}\n{status}", "")
        return super()._call(args)


class LakeDocker(LakeCatalog, FakeDocker):
    def __init__(self, lake: FakeLake, **kw):
        super().__init__(**kw)
        self.lake = lake


class StackLakeDocker(LakeCatalog, StackDocker):
    """The fake stack's `docker`, its catalog the fake Texera's lake."""

    @property
    def lake(self) -> FakeLake:
        return self.fake.lake


class SocketHandle(Handle):
    """A run handle as Check I sees it: its states, and whether it printed."""

    def __init__(self, states, printed: bool = False):
        super().__init__(states)
        self.printed = printed

    def console(self, operator_id=None):
        return [{"title": "a line"}] if self.printed else []


COMPLETED = ("Initializing", "Running", "Completed")


class RecordCheckCase(unittest.TestCase):
    """Check I alone: a fake lake, and what a recorder leaves in it."""

    #: what the evidence is asked for beyond Check I
    evidence_options: dict = {}

    def setUp(self):
        self.lake = FakeLake()
        self.docker = LakeDocker(self.lake)
        self.ev = ev.Evidence(run_id="t", runner=self.docker, log=lambda m: None, required=["I"],
                              record_settle_s=0.4, cleanup_wait_s=0.3, quiet_s=0.1, **self.evidence_options)
        self.ev.preflight()
        self.ev.warehouse_name = WAREHOUSE  # the warehouse the driver's runs use, as e2e.py sets it
        self.ev.begin_scenario("a")
        self.eid = 90

    def start(self, handle, eid=None, wid=5):
        eid = eid or self.eid
        self.ev.on_phase("create", {"wid": wid, "cuid": 1})
        self.ev.on_phase("created", {"eid": eid, "wid": wid})
        return self.ev.on_phase("start", {"wid": wid, "cuid": 1, "eid": eid, "handle": handle})

    def record(self, states=("READY", "RUNNING", "COMPLETED"), *, eid=None, faults=(), prints=0,
               statistics=True, final_tidy=True) -> Recorder:
        """What the unit's recorder leaves in the lake for a run through `states`. With the
        fault `output-rows` it also logs the run's stored port, before RUNNING."""
        eid = eid or self.eid
        self.lake.create(WAREHOUSE, NAMESPACES["result"], f"wid_5_eid_{eid}_globalportid_(port)_result")
        r = Recorder(self.lake, WAREHOUSE, 5, eid, interval_s=30, faults=set(faults), commit_delay_s=0)
        for state in states:
            if state == "RUNNING" and "output-rows" in faults:
                r.output("(port)", "vfs:///result", "SET_SNAPSHOT")
            if state in ("COMPLETED", "FAILED", "KILLED"):
                if statistics:
                    r.statistics({"op": {"output": 3, "state": "COMPLETED"}})
                for i in range(prints):
                    r.console("op", "PRINT", f"line {i}", "")
            r.state(state, final_tidy=final_tidy)
        self.assertTrue(r.await_idle(5))
        return r

    def check_i(self) -> ev.CheckResult:
        return self.ev.end_scenario()["checks"]["I"]


class RecordCheckTest(RecordCheckCase):
    def test_a_whole_record_passes(self):
        self.start(SocketHandle(COMPLETED, printed=True))
        self.record(prints=2)
        r = self.check_i()
        self.assertTrue(r.ok, r.detail)
        self.assertIn("execution 90: COMPLETED at seq 3", r.detail)
        gates, _ = ev.evaluate({"I": r}, ["I"], negative_control=False)
        self.assertEqual([True], [ok for _, ok, _ in gates])

    def test_a_label_ahead_of_its_rows_fails(self):
        self.start(SocketHandle(COMPLETED))
        self.record(faults=["row-lost"])
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the label names seq 3 and the log holds 2 row(s): the label is ahead of its rows", r.detail)

    def test_a_gap_in_seq_fails(self):
        self.start(SocketHandle(COMPLETED))
        self.record(faults=["seq-gap"])
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the label names seq 4 and the log holds 3 row(s)", r.detail)
        self.assertIn("a seq was skipped", r.detail)

    def test_a_row_that_landed_twice_fails(self):
        self.start(SocketHandle(COMPLETED))
        self.record()
        log = self.lake.table(WAREHOUSE, NAMESPACES["log"], table_name(5, 90, "log"))
        log.rows.append(dict(log.rows[-1]))
        log.snapshots[-1]["summary"]["total-records"] = str(len(log.rows))
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("more rows than seq", r.detail)

    def test_two_data_files_after_the_end_fail(self):
        self.start(SocketHandle(COMPLETED))
        self.record(faults=["no-end-tidy"])
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the log holds 3 data file(s)", r.detail)
        self.assertIn("not one of each", r.detail)

    def test_an_ending_the_log_does_not_have_fails(self):
        self.start(SocketHandle(COMPLETED))
        self.record(states=("READY", "RUNNING"))
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the log's label says RUNNING, the run ended COMPLETED", r.detail)

    def test_a_run_without_a_log_fails(self):
        self.start(SocketHandle(COMPLETED))
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("no execution log", r.detail)

    def test_the_record_is_read_until_the_end_tidy_has_landed(self):
        self.ev.record_settle_s = 5
        self.start(SocketHandle(COMPLETED))
        late = threading.Timer(0.3, self.record)
        late.start()
        r = self.check_i()
        late.join()
        self.assertTrue(r.ok, r.detail)
        self.assertGreaterEqual(r.data["records"][0]["waited_s"], 0.2)

    def test_console_rows_of_a_run_that_printed_nothing_fail(self):
        """A console table left under the execution's name by an earlier database (m8)."""
        self.start(SocketHandle(COMPLETED, printed=False))
        self.record(prints=3)
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the console table holds 3 row(s) of a run that wrote none", r.detail)

    def test_a_console_table_gone_with_the_results_is_not_judged_and_one_gone_alone_fails(self):
        """The console table goes when the execution's results do (cleared by the unit once
        nobody watches, or expired by the Dashboard)."""
        self.start(SocketHandle(COMPLETED, printed=True))
        self.record(prints=2)
        self.lake.drop(WAREHOUSE, NAMESPACES["console"], table_name(5, 90, "console"))
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the console table is missing", r.detail)
        self.assertIn("1 result table(s) of the execution are still there", r.detail)

        self.ev.begin_scenario("b")
        self.start(SocketHandle(COMPLETED, printed=True), eid=91)
        self.record(prints=2, eid=91)
        self.lake.drop(WAREHOUSE, NAMESPACES["console"], table_name(5, 91, "console"))
        self.lake.drop(WAREHOUSE, NAMESPACES["result"], "wid_5_eid_91_globalportid_(port)_result")
        r = self.check_i()
        self.assertTrue(r.ok, r.detail)
        self.assertIn("not judged", r.data["records"][0]["console"])

    def test_a_run_that_never_ran_may_have_no_statistics(self):
        self.start(SocketHandle(("Initializing", "Failed")))
        self.record(states=("READY", "FAILED"), statistics=False)
        r = self.check_i()
        self.assertTrue(r.ok, r.detail)
        self.assertIn("FAILED at seq 2", r.detail)

    def test_a_run_that_ran_must_have_statistics(self):
        self.start(SocketHandle(COMPLETED))
        self.record(statistics=False)
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the statistics table holds 0 data file(s) and 0 snapshot(s)", r.detail)

    def test_a_stopped_units_tables_are_not_counted_but_its_label_is(self):
        """Its socket may have dropped before the ending reached it: the unit's word counts."""
        self.start(SocketHandle(("Initializing", "Running"), printed=True))
        self.record(states=("READY", "RUNNING", "FAILED"), prints=2, final_tidy=False)
        self.ev.record_left_as_is(90, "FAILED", "its unit was stopped under it")
        r = self.check_i()
        self.assertTrue(r.ok, r.detail)
        self.assertIn("execution 90: FAILED at seq 3, tables left as they were: its unit was stopped under it",
                      r.detail)

        self.ev.begin_scenario("b")
        self.start(SocketHandle(("Initializing", "Running", "Failed")), eid=91)
        self.record(states=("READY", "RUNNING"), eid=91)
        self.ev.record_left_as_is(91, "FAILED", "its unit was stopped under it")
        r = self.check_i()
        self.assertIs(False, r.ok)  # no FAILED row: the stop recorded nothing
        self.assertIn("the log's label says RUNNING, the last state its unit recorded must be FAILED", r.detail)

    def test_a_lost_units_record_stays_where_the_kill_found_it(self):
        self.start(SocketHandle(("Initializing", "Running"), printed=True))
        recorder = self.record(states=("READY", "RUNNING"), prints=2)
        recorder.kill()
        self.ev.record_left_as_is(90, "RUNNING", "its unit was killed under it")
        r = self.check_i()
        self.assertTrue(r.ok, r.detail)
        self.assertIn("RUNNING at seq 2, tables left as they were: its unit was killed under it", r.detail)

        self.ev.begin_scenario("b")  # ... and a label ahead of its rows is still caught there
        self.start(SocketHandle(("Initializing", "Running")), eid=91)
        self.record(states=("READY", "RUNNING"), eid=91)
        self.lake.table(WAREHOUSE, NAMESPACES["log"], table_name(5, 91, "log")).set_properties(
            {"texera.execution.state-seq": "9"})
        self.ev.record_left_as_is(91, "RUNNING", "its unit was killed under it")
        self.assertIn("the label is ahead of its rows", self.check_i().detail)

    def test_runs_that_have_not_ended_are_not_judged(self):
        self.start(SocketHandle(("Initializing", "Running")))
        self.record(states=("READY", "RUNNING"))
        r = self.check_i()
        self.assertTrue(r.ok and r.data.get("vacuous"), r.detail)

    def test_a_catalog_that_cannot_answer_is_not_a_verdict(self):
        self.start(SocketHandle(COMPLETED))
        self.record()
        self.lake.unreadable = True
        r = self.check_i()
        self.assertIsNone(r.ok, r.detail)
        gates, _ = ev.evaluate({"I": r}, ["I"], negative_control=False)
        self.assertEqual([False], [ok for _, ok, _ in gates])
        self.assertIn("not evaluable", gates[0][2])

    def test_a_record_judged_early_keeps_its_verdict(self):
        """A scenario (or the runner, before it closes the sockets) has the records judged
        while the unit still holds the runs; what happens to the tables later is not read."""
        self.start(SocketHandle(COMPLETED, printed=True))
        self.record(prints=2)
        self.ev.settle_records()
        self.lake.drop(WAREHOUSE, NAMESPACES["console"], table_name(5, 90, "console"))
        self.lake.drop(WAREHOUSE, NAMESPACES["log"], table_name(5, 90, "log"))
        r = self.check_i()
        self.assertTrue(r.ok, r.detail)

    def test_step_3_checks_are_evaluated_only_when_asked_for(self):
        self.assertEqual(("A", "B", "C", "D", "F"), ev.CHECKS)
        self.assertEqual(list(ev.CHECKS), ev.parse_checks("all"))
        self.assertEqual(["A", "I"], ev.parse_checks("i,a"))
        with self.assertRaises(SystemExit):
            ev.parse_checks("Z")
        plain = ev.Evidence(run_id="t", runner=self.docker, log=lambda m: None)
        plain.preflight()
        plain.begin_scenario("a")
        self.assertEqual(set(ev.CHECKS), set(plain.end_scenario()["checks"]))
        self.assertEqual(set(ev.CHECKS) | {"I"}, set(self.ev.end_scenario()["checks"]))


class LogRowsTest(RecordCheckCase):
    """Check I from gate 3B on: the Dashboard serves the log, and its rows are read too."""

    evidence_options = {"level": "B"}

    def setUp(self):
        super().setUp()
        self.asked: list[int] = []
        self.ev._read_log = self.read_log

    def read_log(self, eid: int) -> ExecutionLog:
        """The log as the Dashboard serves it: the lake's rows by seq, one per seq."""
        self.asked.append(eid)
        table = self.lake.table(WAREHOUSE, NAMESPACES["log"], table_name(5, eid, "log"))
        first: dict[int, dict] = {}
        for row in table.rows if table else []:
            first.setdefault(row["seq"], row)
        return ExecutionLog.of({"eid": eid, "closing": None, "entries": [
            {"seq": r["seq"], "timeMs": r["timeMs"], "kind": r["kind"], "state": r["state"]}
            for _, r in sorted(first.items())]})

    def test_a_whole_log_passes(self):
        self.start(SocketHandle(("Initializing", "Running", "Pausing", "Paused", "Resuming", "Running", "Completed")))
        self.record(states=("READY", "RUNNING", "PAUSED", "RUNNING", "COMPLETED"))
        r = self.check_i()
        self.assertTrue(r.ok, r.detail)
        self.assertEqual({"seq": [1, 2, 3, 4, 5], "states": ["READY", "RUNNING", "PAUSED", "RUNNING", "COMPLETED"]},
                         r.data["records"][0]["log"])

    def test_a_gap_in_seq_is_named(self):
        self.start(SocketHandle(COMPLETED))
        self.record(faults=["seq-gap"])
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the log's seq are [1, 3, 4], not 1 to 3", r.detail)

    def test_a_row_that_is_no_state_change_is_named(self):
        """The log holds state changes only: a stored port's location is in the plan."""
        self.start(SocketHandle(COMPLETED))
        self.record(faults=["output-rows"])
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("execution 90: the log holds rows that are no state changes: seq 2 (output) (after", r.detail)

    def test_a_state_the_socket_was_told_and_the_log_lacks_fails(self):
        self.start(SocketHandle(("Initializing", "Running", "Paused", "Running", "Completed")))
        self.record()  # READY, RUNNING, COMPLETED: the pause was never recorded
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the log's states are ['READY', 'RUNNING', 'COMPLETED']; the run's socket was told "
                      "['READY', 'RUNNING', 'PAUSED', 'RUNNING', 'COMPLETED']", r.detail)

    def test_states_told_twice_are_one_row(self):
        self.assertEqual(["READY", "RUNNING", "COMPLETED"], ev.logged_states(
            ["Uninitialized", "Initializing", "Running", "Running", "Pausing", "Running", "Completed"]))

    def test_a_route_that_fails_is_a_finding(self):
        def refused(eid):
            raise RuntimeError("GET /api/executions/90/log -> HTTP 403")
        self.ev._read_log = refused
        self.start(SocketHandle(COMPLETED))
        self.record()
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("GET /api/executions/90/log failed: RuntimeError: GET /api/executions/90/log -> HTTP 403",
                      r.detail)

    def test_a_unit_taken_down_may_have_recorded_more_than_its_socket_heard(self):
        self.start(SocketHandle(("Initializing", "Running")))
        self.record(states=("READY", "RUNNING", "FAILED"), final_tidy=False)
        self.ev.record_left_as_is(90, "FAILED", "its unit was stopped under it")
        self.assertTrue(self.check_i().ok)

        self.ev.begin_scenario("b")  # but not something else than its socket heard
        self.start(SocketHandle(("Initializing", "Running", "Paused")), eid=91)
        self.record(states=("READY", "RUNNING", "FAILED"), eid=91, final_tidy=False)
        self.ev.record_left_as_is(91, "FAILED", "its unit was stopped under it")
        self.assertIn("the run's socket was told ['READY', 'RUNNING', 'PAUSED']", self.check_i().detail)

    def test_a_run_without_a_socket_has_only_its_seq_read(self):
        """The agent's REST run: the driver saw its ending, not its states."""
        run = self.start(None)
        run.started, run.final_state = True, "Completed"
        self.record()
        r = self.check_i()
        self.assertTrue(r.ok, r.detail)
        self.assertEqual([90], self.asked)

    def test_the_log_is_not_asked_for_before_gate_3b(self):
        self.ev.level = "A"
        self.start(SocketHandle(COMPLETED))
        self.record()
        self.assertTrue(self.check_i().ok)
        self.assertEqual([], self.asked)


class ClosingDocker(FakeDocker):
    """A fake `docker` whose Postgres answers Check K's query from `rows`: eid -> {wid,
    outcome, reason, closed}."""

    def __init__(self):
        super().__init__()
        self.rows: dict[int, dict] = {}
        self.psql_fails = ""
        self.queries: list[str] = []

    def _call(self, args):
        if args[0] == "exec" and "psql" in args and "ended_at IS NOT NULL" in args[-1]:
            self.queries.append(args[-1])
            if self.psql_fails:
                return subprocess.CompletedProcess(args, 1, self.psql_fails, "")
            lines = [f"{eid}|{r['wid']}|{r.get('outcome', '')}|{int(r['closed'])}|{r.get('reason', '')}"
                     for eid, r in sorted(self.rows.items())]
            return subprocess.CompletedProcess(args, 0, "\n".join(lines) + "\n", "")
        return super()._call(args)


class ClosingCheckTest(unittest.TestCase):
    """Check K alone."""

    #: a run's execution is closed within 0.5 s of the last scenario, an unstarted one within 0.8 s
    TIMING = RecordTiming(commit_interval_s=0.05, closing_interval_s=0.1, lost_after_s=0.2,
                          never_started_after_s=0.6)

    def setUp(self):
        self.docker = ClosingDocker()
        self.ev = ev.Evidence(run_id="t", runner=self.docker, log=lambda m: None, required=["K"],
                              timing=self.TIMING, level="B")
        self.ev.preflight()
        self.docker.rows = {90: {"wid": 5, "outcome": 3, "closed": True},
                            91: {"wid": 6, "outcome": 4, "reason": "unit lost", "closed": True}}

    def close_later(self, eid: int, after_s: float, **row) -> None:
        timer = threading.Timer(after_s, lambda: self.docker.rows[eid].update(closed=True, **row))
        timer.start()
        self.addCleanup(timer.join)

    def test_closed_executions_pass(self):
        final = self.ev.final_check([5, 6, 6, None])
        self.assertTrue(final["ok"], final)
        self.assertEqual("Check K: every execution of this run's workflows is closed", final["name"])
        self.assertIn("2 execution(s), each with its closing record", final["detail"])
        self.assertIn("WHERE v.wid IN (5,6)", self.docker.queries[0])
        self.assertEqual([(90, 3, ""), (91, 4, "unit lost")],
                         [(r["eid"], r["outcome"], r["reason"]) for r in final["rows"]])

    def test_a_row_left_open_fails(self):
        self.docker.rows[92] = {"wid": 6, "closed": False}
        final = self.ev.final_check([5, 6])
        self.assertIs(False, final["ok"])
        self.assertEqual("execution 92 has no closing record (deadline 0.5 s after the last scenario)",
                         final["detail"])
        self.assertGreater(len(self.docker.queries), 5)  # it was watched until the later deadline

    def test_a_row_is_watched_until_it_is_closed(self):
        self.docker.rows[92] = {"wid": 6, "closed": False}
        self.close_later(92, 0.2, outcome=3)
        final = self.ev.final_check([5, 6])
        self.assertTrue(final["ok"], final)
        row = final["rows"][-1]
        self.assertTrue(0.2 <= row["closed_after_s"] <= 0.5, row)

    def test_a_row_closed_after_its_deadline_fails(self):
        self.docker.rows[92] = {"wid": 6, "closed": False}
        self.close_later(92, 0.65, outcome=4, reason="unit lost")
        final = self.ev.final_check([5, 6])
        self.assertIs(False, final["ok"])
        self.assertRegex(final["detail"], r"execution 92 was closed after 0\.[67] s \(deadline 0\.5 s after")

    def test_a_row_left_unstarted_on_purpose_has_until_it_is_old_enough(self):
        self.docker.rows[92] = {"wid": 6, "closed": False}
        self.ev.leave_unstarted(92, "l5: start refused on purpose")
        self.close_later(92, 0.65, outcome=4, reason="never started")
        final = self.ev.final_check([5, 6])
        self.assertTrue(final["ok"], final)
        self.assertEqual((0.8, "l5: start refused on purpose"),
                         (final["rows"][-1]["deadline_s"], final["rows"][-1]["unstarted_on_purpose"]))

    def test_a_row_left_unstarted_on_purpose_must_be_closed_as_never_started(self):
        self.docker.rows[92] = {"wid": 6, "outcome": 4, "reason": "unit lost", "closed": True}
        self.ev.leave_unstarted(92, "l5: start refused on purpose")
        final = self.ev.final_check([5, 6])
        self.assertIs(False, final["ok"])
        self.assertEqual('execution 92, left unstarted on purpose, is closed 4 "unit lost", not 4 "never started"',
                         final["detail"])

    def test_the_deadlines_count_from_the_last_scenarios_end(self):
        self.docker.rows[92] = {"wid": 6, "closed": False}
        self.ev.begin_scenario("a")
        self.ev.end_scenario()
        time.sleep(0.6)  # the driver came late: the row was open past its deadline
        self.docker.rows[92].update(closed=True, outcome=3)
        final = self.ev.final_check([5, 6])
        self.assertIs(False, final["ok"])
        self.assertIn("execution 92 was closed after", final["detail"])

    def test_a_reason_may_hold_the_separator(self):
        self.docker.rows[91]["reason"] = "compile error: column a|b does not exist"
        final = self.ev.final_check([6])
        self.assertEqual("compile error: column a|b does not exist", final["rows"][-1]["reason"])

    def test_postgres_that_cannot_answer_fails(self):
        self.docker.psql_fails = 'ERROR:  column e.ended_at does not exist'
        final = self.ev.final_check([5])
        self.assertIs(False, final["ok"])
        self.assertIn("psql failed: ERROR:  column e.ended_at does not exist", final["detail"])

    def test_without_check_k_the_final_check_is_step_2s(self):
        plain = ev.Evidence(run_id="t", runner=self.docker, log=lambda m: None)
        plain.preflight()
        final = plain.final_check([5])
        self.assertTrue(final["name"].startswith("no row of this run's workflows is left at status 0"))
        self.assertEqual([], self.docker.queries)
        self.assertTrue(self.ev.final_check([])["ok"])  # no workflows: nothing to close
        # K is the run's check, not a scenario's
        self.ev.begin_scenario("a")
        self.assertNotIn("K", self.ev.end_scenario()["checks"])


STATUS_UPDATE = ("update workflow_executions set status = $1, last_update_time = $2 "
                 "where workflow_executions.eid = $3")


def connection(pid: int, app: str, address: str, state: str = "idle") -> dict:
    return {"pid": pid, "application_name": app, "client_addr": address, "datname": "texera_db", "state": state}


class UnitOffPostgresTest(unittest.TestCase):
    """Checks G, H and J alone: a fake `docker` whose Postgres log holds what a test puts
    there, and a Postgres whose connections a test lists."""

    def setUp(self):
        self.docker = FakeDocker()
        self.connections = [connection(401, ev.DASHBOARD_APP, DASH_IP)]
        self.ev = self.evidence(required=list("GHJ"))

    def evidence(self, **options) -> ev.Evidence:
        evidence = ev.Evidence(run_id="t", runner=self.docker, log=lambda m: None, level="C",
                               connections=lambda: list(self.connections), cleanup_wait_s=0.3, quiet_s=0.1,
                               **options)
        evidence.preflight()
        return evidence

    def scenario(self, during=lambda: None, evidence: ev.Evidence | None = None) -> dict:
        evidence = evidence or self.ev
        evidence.begin_scenario("a")
        during()
        return evidence.end_scenario()["checks"]

    def unit_writes_its_status(self):
        self.docker.execute(ev.UNIT_APP, UNIT_IP, STATUS_UPDATE, "$1 = '1', $2 = '2026-11-17', $3 = '5'", pid=300)

    def test_a_unit_that_sends_postgres_nothing_passes(self):
        checks = self.scenario(lambda: self.docker.execute(ev.DASHBOARD_APP, DASH_IP, STATUS_UPDATE,
                                                           "$1 = '1', $2 = 'x', $3 = '5'", pid=400))
        self.assertEqual({"G": True, "H": True, "J": True}, {k: checks[k].ok for k in "GHJ"})
        self.assertIn(f"no statement from the unit (texera-computing-unit, or from ['{UNIT_IP}']) between the "
                      f"scenario's marks", checks["G"].detail)
        self.assertEqual("no connection of the unit among 1 at the scenario's start and 1 at its end",
                         checks["H"].detail)
        self.assertEqual("the unit resolves texera-postgres to nothing and is healthy", checks["J"].detail)

    def test_any_statement_of_the_unit_fails_g(self):
        """Whatever it is: a write of its status; a setting, sent under the unit's name from
        an address the driver does not know; a statement on another database, from the
        unit's address under another name. The step-2 checks look at none of the last two."""
        def during():
            self.unit_writes_its_status()
            self.docker.pg_line(301, ev.UNIT_APP, "10.9.9.9", "LOG", "statement: SET search_path = texera_db")
            self.docker.pg_line(302, "PostgreSQL JDBC Driver", UNIT_IP, "LOG", "statement: SELECT 1", db="postgres")
        g = self.scenario(during)["G"]
        self.assertIs(False, g.ok)
        self.assertIn("3 statement(s) from the unit between the scenario's marks, 1 of them UPDATEs of an "
                      "execution's status", g.detail)
        self.assertEqual(1, g.data["status_updates"])
        self.assertEqual([300, 301, 302], [s["pid"] for s in g.data["statements"]])

    def test_a_statement_between_scenarios_fails_the_whole_runs_check(self):
        self.assertTrue(self.scenario()["G"].ok)
        self.unit_writes_its_status()  # after the scenario's end mark: no scenario's
        self.assertTrue(self.scenario()["G"].ok)
        finals = self.ev.final_checks([])
        self.assertEqual("Check G, the whole run: no statement from the unit since its container started",
                         finals[-1]["name"])
        self.assertIs(False, finals[-1]["ok"])
        self.assertIn("1 statement(s) from the unit since its container started (2023-11-14T22:13:20Z)",
                      finals[-1]["detail"])

    def test_a_line_from_before_the_unit_started_is_another_containers(self):
        """An init job that had the unit's address before the unit got it."""
        self.docker.pg_line(77, "lakekeeper-migrate", UNIT_IP, "LOG", "statement: CREATE TABLE x ()", db="lakekeeper")
        _, self.docker.started_at = self.docker._ts()
        evidence = self.evidence(required=["G"])
        self.assertTrue(self.scenario(evidence=evidence)["G"].ok)
        self.assertTrue(evidence.final_checks([])[-1]["ok"])
        self.unit_writes_its_status()
        self.assertIs(False, evidence.final_checks([])[-1]["ok"])

    def test_a_connection_of_the_unit_fails_h(self):
        self.connections.append(connection(300, ev.UNIT_APP, "10.9.9.9"))  # by its name, from anywhere
        h = self.scenario()["H"]
        self.assertIs(False, h.ok)
        self.assertIn("2 connection(s) of the unit in pg_stat_activity: at the start: pid 300 "
                      "app=texera-computing-unit from 10.9.9.9, idle; at the end: pid 300", h.detail)
        self.connections[-1] = connection(301, "PostgreSQL JDBC Driver", UNIT_IP, "active")  # by its address
        self.assertIs(False, self.scenario()["H"].ok)

    def test_h_looks_at_the_scenarios_start_and_at_its_end(self):
        h = self.scenario(lambda: self.connections.append(connection(300, ev.UNIT_APP, UNIT_IP)))["H"]
        self.assertIs(False, h.ok)
        self.assertEqual(["end"], [c["when"] for c in h.data["connections"]])

    def test_h_is_not_evaluable_when_postgres_cannot_be_asked(self):
        def refused():
            raise RuntimeError("docker exec sce-texera-postgres psql: exit 2")
        self.ev._connections = refused
        h = self.scenario()["H"]
        self.assertIsNone(h.ok)
        self.assertIn("at the scenario's start: RuntimeError: docker exec sce-texera-postgres psql: exit 2", h.detail)
        gates, _ = ev.evaluate({"H": h}, ["H"], negative_control=False)
        self.assertEqual([False], [ok for _, ok, _ in gates])

    def test_j_fails_for_a_unit_that_resolves_postgres_or_is_not_healthy(self):
        self.docker.health = "unhealthy"
        j = self.scenario()["J"]
        self.assertIs(False, j.ok)
        self.assertIn("is unhealthy", j.detail)
        self.docker.health, self.docker.getent_postgres = "healthy", "172.30.0.2      texera-postgres"
        j = self.scenario()["J"]
        self.assertIs(False, j.ok)
        self.assertIn("resolves texera-postgres to ['172.30.0.2      texera-postgres']", j.detail)

    def test_j_refuses_a_stack_whose_unit_can_find_postgres(self):
        self.docker.getent_postgres = "172.30.0.2      texera-postgres"
        with self.assertRaisesRegex(ev.EvidenceUnavailable, "Check J needs a stack started with --unit-no-postgres"):
            self.evidence(required=["J"])
        self.evidence(required=["G", "H"])  # without J the stack may hold Postgres for the unit

    def test_the_name_of_postgres_is_the_stacks(self):
        named = ev.Evidence(run_id="t", runner=self.docker, log=lambda m: None,
                            env={"STORAGE_JDBC_URL": "jdbc:postgresql://pg.internal:5432/texera_db"})
        self.assertEqual(("pg.internal", "texera-postgres"), (named.postgres_host, self.ev.postgres_host))

    def test_checks_a_and_b_are_retired_at_gate_3c(self):
        """Their windows end at the unit's status UPDATE, which no longer exists."""
        self.assertEqual(set("CDFGHJ"), set(self.scenario()))
        earlier = ev.Evidence(run_id="t", runner=self.docker, log=lambda m: None, level="B", cleanup_wait_s=0.3,
                              quiet_s=0.1)
        earlier.preflight()
        self.assertEqual(set("ABCDF"), set(self.scenario(evidence=earlier)))
        asked = self.evidence(required=["A", "G"])  # ... unless a run asks for one by name
        self.assertEqual(set("ACDFG"), set(self.scenario(evidence=asked)))

    def test_step_3s_controls_must_fail_each_for_its_reason(self):
        self.assertEqual(((), (), ("A", "D", "F"), ("A", "D", "F"), ("G", "H")),
                         tuple(ev.controls_of(c) for c in (False, None, True, "2", "3")))
        control = self.evidence(required=[], negative_control="3")

        def gates(during) -> dict[str, tuple[bool, str]]:
            found, _ = ev.evaluate(self.scenario(during, evidence=control), [], negative_control="3")
            return {name.split()[1]: (ok, detail) for name, ok, detail in found}

        # the old unit: it writes its status, and its pool idles
        self.connections.append(connection(300, ev.UNIT_APP, UNIT_IP, "idle"))
        old = gates(self.unit_writes_its_status)
        self.assertEqual({"G": True, "H": True}, {k: ok for k, (ok, _) in old.items()})
        self.assertTrue(old["G"][1].startswith("failed as expected: 1 statement(s) from the unit"))
        # a unit that fails them for another reason proves nothing about the reason
        self.connections[-1] = connection(300, ev.UNIT_APP, UNIT_IP, "active")
        other = gates(lambda: self.docker.execute(ev.UNIT_APP, UNIT_IP, "select 1", pid=300))
        self.assertEqual((False, False), (other["G"][0], other["H"][0]))
        self.assertIn("control inconclusive (G failed, but on no status UPDATE of the unit)", other["G"][1])
        self.assertIn("control inconclusive (H failed, but on no idle connection of the unit)", other["H"][1])
        # and the new unit passes them, so the control did not control
        self.connections.pop()
        new = gates(lambda: None)
        self.assertTrue(all(detail.startswith("PASSED, so the control proves nothing") for _, detail in new.values()))
        self.assertEqual({"G": False, "H": False}, {k: ok for k, (ok, _) in new.items()})


class RecordEvidence(EvidenceCase):
    """Scenarios and evidence together at gate 3A: step 2's checks and Check I."""

    step = "3A"
    level = "A"
    timing = FAST
    docker_class = StackLakeDocker
    evidence_options = {"required": list(ev.CHECKS) + ["I"], "record_settle_s": 1.0}

    def setUp(self):
        super().setUp()
        self.fake.sleep_scale = 0.1

    def record_check(self, rec):
        return next(c for c in rec.checks if c.name.startswith("evidence I:"))

    def test_p_passes_step_2s_checks_and_check_i(self):
        rec = self.run_ev("p")
        self.assertEqual(set("ABCDFI"), self.gated(rec))
        # READY, RUNNING, PAUSED, RUNNING, COMPLETED
        self.assertIn("COMPLETED at seq 5", self.record_check(rec).detail)

    def test_every_kind_of_run_leaves_a_whole_record(self):
        """A refused second start (two records of one execution), the agent's run (no
        socket), a run that fails before it runs, and a run that prints while it installs."""
        details = {key: self.record_check(self.run_ev(key)).detail for key in ("l8", "o", "h", "g")}
        self.assertIn("COMPLETED at seq 3", details["l8"])  # READY, RUNNING, COMPLETED
        self.assertIn("COMPLETED at seq 3", details["o"])
        self.assertIn("FAILED at seq 2", details["h"])
        self.assertEqual(2, details["g"].count("COMPLETED at seq 3"))  # both runs

    def test_a_label_ahead_of_its_rows_fails_check_i(self):
        self.fake.faults.add("row-lost")
        rec = self.run_ev("f", expect="FAIL")
        self.assertEqual(["evidence I"], [c.name.split(":")[0] for c in rec.checks if not c.ok])
        self.assertIn("the label is ahead of its rows", self.record_check(rec).detail)

    def test_a_gap_in_seq_fails_check_i(self):
        self.fake.faults.add("seq-gap")
        rec = self.run_ev("f", expect="FAIL")
        self.assertEqual(["evidence I"], [c.name.split(":")[0] for c in rec.checks if not c.ok])
        self.assertIn("a seq was skipped", self.record_check(rec).detail)

    def test_two_data_files_after_the_end_fail_check_i(self):
        self.fake.faults.add("no-end-tidy")
        rec = self.run_ev("f", expect="FAIL")
        self.assertEqual(["evidence I"], [c.name.split(":")[0] for c in rec.checks if not c.ok])
        self.assertIn("data file(s) and", self.record_check(rec).detail)


class ClosingEvidence(EvidenceCase):
    """Scenarios and evidence together at gate 3B: step 2's checks, Check I with the
    log the Dashboard serves, and Check K after the last scenario."""

    step = "3B"
    level = "B"
    timing = FAST
    docker_class = StackLakeDocker
    evidence_options = {"required": list(ev.CHECKS) + ["I", "K"], "record_settle_s": 1.0, "level": "B",
                        "timing": FAST}

    def setUp(self):
        super().setUp()
        self.fake.sleep_scale = 0.1

    def evidence_kwargs(self) -> dict:
        return {**self.evidence_options, "read_log": self.ctx.api.execution_log}

    def record_check(self, rec):
        return next(c for c in rec.checks if c.name.startswith("evidence I:"))

    def test_a_run_and_a_refused_start_end_closed(self):
        first = self.run_ev("f")
        self.assertEqual(set("ABCDFI"), self.gated(first))
        refused = self.run_ev("l5")
        # sub-part 14: the unit deletes nothing when it lets go of a run, so none is waited for
        self.assertEqual({}, refused.evidence["cleanup_wait"]["cleanup_deletes"])
        self.assertGreaterEqual(refused.evidence["cleanup_wait"]["waited_s"], 1.0)
        final = self.ev.final_check(self.ctx.created_wids)
        self.assertTrue(final["ok"], final)
        rows = {r["eid"]: r for r in final["rows"]}
        self.assertEqual((3, ""), (rows[first.eid]["outcome"], rows[first.eid]["reason"]))
        # the refused start's execution: closed by the job once it was old enough
        self.assertEqual((4, "never started"), (rows[refused.eid]["outcome"], rows[refused.eid]["reason"]))
        self.assertGreater(rows[refused.eid]["closed_after_s"], 0.2)
        self.assertEqual(FAST.never_started_verdict_s, rows[refused.eid]["deadline_s"])

    def test_a_unit_taken_down_passes_every_check(self):
        """q and s: Check B's window runs to the scenario's end for a run that never ended,
        over the statements of the runs after it; Check I reads the records as they were left."""
        lost = self.run_ev("q")
        self.assertEqual(set("ABCDFI"), self.gated(lost))
        detail = self.record_check(lost).detail
        self.assertEqual(2, detail.count("RUNNING at seq 2, tables left as they were: its unit was killed under it"))
        self.assertEqual(1, detail.count("COMPLETED at seq"))  # a's run on the unit that is back
        stopped = self.run_ev("s")
        self.assertIn("FAILED at seq 3, tables left as they were: its unit was stopped under it",
                      self.record_check(stopped).detail)
        self.assertTrue(self.ev.final_check(self.ctx.created_wids)["ok"])

    def test_a_row_left_open_fails_check_k(self):
        self.fake.faults.add("row-left-open")
        rec = self.run_ev("f")  # the run and its record are fine; only the Dashboard does nothing
        final = self.ev.final_check(self.ctx.created_wids)
        self.assertIs(False, final["ok"])
        self.assertEqual(f"execution {rec.eid} has no closing record (deadline {FAST.lost_verdict_s:g} s after "
                         f"the last scenario)", final["detail"])

    def test_a_lost_unit_never_closed_fails_check_k(self):
        self.fake.faults.add("lost-never-closed")
        rec = self.run_ev("q", expect="FAIL")
        final = self.ev.final_check(self.ctx.created_wids)
        self.assertIs(False, final["ok"])
        for verdict in rec.facts["lost_verdicts"]:
            self.assertIn(f"execution {verdict['eid']} has no closing record", final["detail"])
        self.assertEqual(2, final["detail"].count("has no closing record"))

    def test_an_unstarted_execution_never_closed_fails_check_k(self):
        self.fake.faults.add("never-started-never-closed")
        rec = self.run_ev("l5")
        final = self.ev.final_check(self.ctx.created_wids)
        self.assertIs(False, final["ok"])
        self.assertEqual(f"execution {rec.eid} has no closing record (deadline {FAST.never_started_verdict_s:g} s "
                         f"after the last scenario)", final["detail"])

    def test_a_gap_in_seq_fails_check_i_by_the_log(self):
        self.fake.faults.add("seq-gap")
        rec = self.run_ev("f", expect="FAIL")
        self.assertEqual(["evidence I"], [c.name.split(":")[0] for c in rec.checks if not c.ok])
        self.assertIn("the log's seq are [1, 3, 4], not 1 to 3", self.record_check(rec).detail)

    def test_a_row_that_is_no_state_change_fails_check_i_by_the_log(self):
        self.fake.faults.add("output-rows")
        rec = self.run_ev("f", expect="FAIL")
        self.assertEqual(["evidence I"], [c.name.split(":")[0] for c in rec.checks if not c.ok])
        self.assertIn("the log holds rows that are no state changes: seq 2 (output)", self.record_check(rec).detail)


class OffPostgresEvidence(EvidenceCase):
    """Scenarios and evidence together at gate 3C, on a stack whose unit has no Postgres to
    find: Checks C to K (A and B are retired)."""

    step = "3C"
    level = "C"
    timing = FAST
    docker_class = StackLakeDocker
    evidence_options = {"required": list("CDFGHIJK"), "record_settle_s": 1.0, "level": "C", "timing": FAST}

    def setUp(self):
        super().setUp()
        self.fake.sleep_scale = 0.1

    def evidence_kwargs(self) -> dict:
        return {**self.evidence_options, "read_log": self.ctx.api.execution_log,
                "connections": self.ctx.stack.pg_activity}

    def failed(self, rec) -> list[str]:
        return [c.name.split(":")[0] for c in rec.checks if not c.ok]

    def test_v_passes_every_check_of_the_gate(self):
        rec = self.run_ev("v")
        self.assertEqual(set("CDFGHIJ"), self.gated(rec))
        self.assertFalse({"A", "B"} & set(rec.evidence["checks"]))  # retired: not even reported
        finals = self.ev.final_checks(self.ctx.created_wids)
        self.assertEqual([True, True], [f["ok"] for f in finals], finals)
        self.assertTrue(finals[0]["name"].startswith("Check K"))
        self.assertTrue(finals[1]["name"].startswith("Check G, the whole run"))

    def test_the_unit_taken_down_and_back_passes_them_too(self):
        self.assertEqual(set("CDFGHIJ"), self.gated(self.run_ev("q")))
        self.assertTrue(all(f["ok"] for f in self.ev.final_checks(self.ctx.created_wids)))

    def test_a_unit_that_still_writes_its_status_fails_check_g(self):
        self.fake.faults.add("unit-statement")
        rec = self.run_ev("a", expect="FAIL")
        self.assertEqual(["evidence G"], self.failed(rec))
        g = next(c for c in rec.checks if c.name.startswith("evidence G:"))
        self.assertRegex(g.detail, r"\d+ statement\(s\) from the unit between the scenario's marks, \d+ of them "
                                   r"UPDATEs of an execution's status")
        whole_run = self.ev.final_checks(self.ctx.created_wids)[-1]
        self.assertIs(False, whole_run["ok"])
        self.assertGreater(whole_run["status_updates"], 0)

    def test_a_unit_that_still_opens_its_pool_fails_check_h(self):
        self.fake.faults.add("unit-pool")
        rec = self.run_ev("a", expect="FAIL")
        self.assertEqual(["evidence H"], self.failed(rec))
        h = next(c for c in rec.checks if c.name.startswith("evidence H:"))
        self.assertIn("4 connection(s) of the unit in pg_stat_activity", h.detail)  # two at the start, two at the end
        self.assertIn("app=texera-computing-unit", h.detail)

    def test_a_unit_that_is_not_healthy_fails_check_j(self):
        self.docker.health = "unhealthy"
        rec = self.run_ev("a", expect="FAIL")
        self.assertEqual(["evidence J"], self.failed(rec))


class Step3Control(EvidenceCase):
    """Step 3's negative control (design H5), against the product at the end of step 2: its
    unit writes its status to Postgres and keeps a pool, and nothing closes an execution."""

    step = "2"
    level = "C"  # the driver asks what the whole of step 3 would answer
    timing = FAST
    docker_class = StackLakeDocker
    evidence_options = {"required": [], "negative_control": "3", "level": "C", "timing": FAST}
    negative = "3"

    def setUp(self):
        super().setUp()
        self.fake.sleep_scale = 0.1
        self.ctx.negative_control = True

    def evidence_kwargs(self) -> dict:
        return {**self.evidence_options, "connections": self.ctx.stack.pg_activity}

    def controls(self, rec) -> dict[str, tuple[bool, str]]:
        return {c.name.split(" ")[1]: (c.ok, c.detail) for c in rec.checks if c.name.startswith("control ")}

    def test_a_fails_g_and_h_as_expected(self):
        rec = self.run_ev("a")
        controls = self.controls(rec)
        self.assertEqual({"G": True, "H": True}, {k: ok for k, (ok, _) in controls.items()})
        self.assertIn("UPDATEs of an execution's status", controls["G"][1])
        self.assertIn("app=texera-computing-unit", controls["H"][1])
        self.assertEqual(2, len(rec.checks))  # the scenario's own checks are information only
        self.assertTrue(rec.functional_checks)

    def test_qs_execution_stays_running_past_its_deadline(self):
        rec = self.run_ev("q")
        controls = self.controls(rec)
        self.assertEqual({"G", "H", "q"}, set(controls))
        self.assertTrue(all(ok for ok, _ in controls.values()), controls)
        self.assertRegex(controls["q"][1], r"failed as expected: the history still says status 1 [\d.]+ s after "
                                           r"the kill, past the deadline of 1\.8 s")
        self.assertEqual(["kill", "start"], self.ctx.stack.calls)  # one pass, and the unit is back


class Step3ControlOnTheNewProduct(Step3Control):
    """The same control on a unit that is off Postgres: it must say that it proved nothing."""

    step = "3C"

    def test_a_fails_g_and_h_as_expected(self):
        rec = self.run_ev("a", expect="FAIL")
        controls = self.controls(rec)
        self.assertEqual({"G": False, "H": False}, {k: ok for k, (ok, _) in controls.items()})
        self.assertTrue(all(d.startswith("PASSED, so the control proves nothing") for _, d in controls.values()))

    def test_qs_execution_stays_running_past_its_deadline(self):
        rec = self.run_ev("q", expect="FAIL")
        ok, detail = self.controls(rec)["q"]
        self.assertFalse(ok)
        self.assertIn("PASSED, so the control proves nothing: the execution was closed", detail)


if __name__ == "__main__":
    unittest.main()
