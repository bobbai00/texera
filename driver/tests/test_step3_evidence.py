"""Offline tests of the step-3 evidence (driver/evidence.py, Checks G to K of the step-3
design; Check I so far): first each check alone, against a fake `docker` whose catalog is
a fake lake that a fake recorder writes into; then scenarios and evidence together, as
e2e.py runs them, on the fake Texera at a step-3 gate.

Every check is shown to fail for the reason it exists: the fake recorder is given one
fault at a time (fake_record.FAULTS) and the check must name it.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import evidence as ev  # noqa: E402
from fake_lake import FakeLake  # noqa: E402
from fake_record import NAMESPACES, Recorder, table_name  # noqa: E402
from test_evidence import FakeDocker, Handle  # noqa: E402
from test_scenario_evidence import EvidenceCase, StackDocker  # noqa: E402
from test_step3_scenarios import FAST  # noqa: E402

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


class RecordCheckTest(unittest.TestCase):
    """Check I alone."""

    def setUp(self):
        self.lake = FakeLake()
        self.docker = LakeDocker(self.lake)
        self.ev = ev.Evidence(run_id="t", runner=self.docker, log=lambda m: None, required=["I"],
                              record_settle_s=0.4, cleanup_wait_s=0.3, quiet_s=0.1)
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
        self.start(SocketHandle(("Initializing", "Running", "Failed"), printed=True))
        self.record(states=("READY", "RUNNING", "FAILED"), prints=2, final_tidy=False)
        self.ev.allow_untidied(90, "its unit was stopped")
        r = self.check_i()
        self.assertTrue(r.ok, r.detail)
        self.assertIn("tables left as they were: its unit was stopped", r.detail)

        self.ev.begin_scenario("b")
        self.start(SocketHandle(("Initializing", "Running", "Failed")), eid=91)
        self.record(states=("READY", "RUNNING"), eid=91)
        self.ev.allow_untidied(91, "its unit was stopped")
        self.assertIs(False, self.check_i().ok)  # no FAILED row: the stop recorded nothing

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


if __name__ == "__main__":
    unittest.main()
