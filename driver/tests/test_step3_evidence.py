"""Offline tests of the step-3 evidence (driver/evidence.py, Checks G to K of the step-3
design; Checks I and K so far): first each check alone, against a fake `docker` whose
catalog is a fake lake that a fake recorder writes into and whose Postgres answers the
closing records a test gives it; then scenarios and evidence together, as e2e.py runs
them, on the fake Texera at a step-3 gate.

Every check is shown to fail for the reason it exists: the fake is given one fault at a
time (fake_record.FAULTS, fake_closing.FAULTS) and the check must name it.

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
from test_evidence import FakeDocker, Handle  # noqa: E402
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
        self.ev.begin_scenario("a")
        self.eid = 90

    def start(self, handle, eid=None, wid=5):
        eid = eid or self.eid
        uri = f"vfs:///wh/{WAREHOUSE}/wid/{wid}/eid/{eid}/plan"
        self.ev.on_phase("create", {"wid": wid, "cuid": 1})
        self.ev.on_phase("created", {"eid": eid, "plan_uri": uri, "wid": wid})
        return self.ev.on_phase("start", {"wid": wid, "cuid": 1, "eid": eid, "plan_uri": uri, "handle": handle})

    def record(self, states=("READY", "RUNNING", "COMPLETED"), *, eid=None, faults=(), prints=0,
               statistics=True, final_tidy=True) -> Recorder:
        """What the unit's recorder leaves in the lake for a run through `states`."""
        eid = eid or self.eid
        self.lake.create(WAREHOUSE, NAMESPACES["result"], f"wid_5_eid_{eid}_globalportid_(port)_result")
        r = Recorder(self.lake, WAREHOUSE, 5, eid, interval_s=30, faults=set(faults), commit_delay_s=0)
        for state in states:
            if state == "RUNNING":
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
        self.assertIn("execution 90: COMPLETED at seq 4", r.detail)
        gates, _ = ev.evaluate({"I": r}, ["I"], negative_control=False)
        self.assertEqual([True], [ok for _, ok, _ in gates])

    def test_a_label_ahead_of_its_rows_fails(self):
        self.start(SocketHandle(COMPLETED))
        self.record(faults=["row-lost"])
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the label names seq 4 and the log holds 3 row(s): the label is ahead of its rows", r.detail)

    def test_a_gap_in_seq_fails(self):
        self.start(SocketHandle(COMPLETED))
        self.record(faults=["seq-gap"])
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the label names seq 5 and the log holds 4 row(s)", r.detail)
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
        self.assertIn("the log holds 4 data file(s)", r.detail)
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
        self.assertIn("execution 90: FAILED at seq 4, tables left as they were: its unit was stopped under it",
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
        self.assertIn("RUNNING at seq 3, tables left as they were: its unit was killed under it", r.detail)

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
        self.assertEqual(("A", "B", "C", "D", "E", "F"), ev.CHECKS)
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
        self.assertEqual({"seq": [1, 2, 3, 4, 5, 6], "states": ["READY", "RUNNING", "PAUSED", "RUNNING", "COMPLETED"]},
                         r.data["records"][0]["log"])

    def test_a_gap_in_seq_is_named(self):
        self.start(SocketHandle(COMPLETED))
        self.record(faults=["seq-gap"])
        r = self.check_i()
        self.assertIs(False, r.ok)
        self.assertIn("the log's seq are [1, 3, 4, 5], not 1 to 4", r.detail)

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
        self.ev.allow_status_zero(92, "l5: start refused on purpose")
        self.close_later(92, 0.65, outcome=4, reason="never started")
        final = self.ev.final_check([5, 6])
        self.assertTrue(final["ok"], final)
        self.assertEqual((0.8, "l5: start refused on purpose"),
                         (final["rows"][-1]["deadline_s"], final["rows"][-1]["unstarted_on_purpose"]))

    def test_a_row_left_unstarted_on_purpose_must_be_closed_as_never_started(self):
        self.docker.rows[92] = {"wid": 6, "outcome": 4, "reason": "unit lost", "closed": True}
        self.ev.allow_status_zero(92, "l5: start refused on purpose")
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


class RecordEvidence(EvidenceCase):
    """Scenarios and evidence together at gate 3A: step 2's six checks and Check I."""

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
        self.assertEqual(set("ABCDEFI"), self.gated(rec))
        # READY, the output, RUNNING, PAUSED, RUNNING, COMPLETED
        self.assertIn("COMPLETED at seq 6", self.record_check(rec).detail)

    def test_every_kind_of_run_leaves_a_whole_record(self):
        """A refused second start (two records of one execution), the agent's run (no
        socket), a run that fails before it runs, and a run that prints while it installs."""
        details = {key: self.record_check(self.run_ev(key)).detail for key in ("l8", "o", "h", "g")}
        self.assertIn("COMPLETED at seq 4", details["l8"])  # READY, the output, RUNNING, COMPLETED
        self.assertIn("COMPLETED at seq 4", details["o"])
        self.assertIn("FAILED at seq 2", details["h"])
        self.assertEqual(2, details["g"].count("COMPLETED at seq 4"))  # both runs

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
    """Scenarios and evidence together at gate 3B: step 2's six checks, Check I with the
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
        self.assertEqual(set("ABCDEFI"), self.gated(first))
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
        self.assertEqual(set("ABCDEFI"), self.gated(lost))
        detail = self.record_check(lost).detail
        self.assertEqual(2, detail.count("RUNNING at seq 3, tables left as they were: its unit was killed under it"))
        self.assertEqual(1, detail.count("COMPLETED at seq"))  # a's run on the unit that is back
        stopped = self.run_ev("s")
        self.assertIn("FAILED at seq 4, tables left as they were: its unit was stopped under it",
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
        self.assertIn("the log's seq are [1, 3, 4, 5], not 1 to 4", self.record_check(rec).detail)


if __name__ == "__main__":
    unittest.main()
