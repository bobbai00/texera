"""Offline runs of the step-3 scenarios through the real driver code against the fake
Texera at a step-3 gate (fake_texera.py with `step`, its recorder in fake_record.py and
its lake in fake_lake.py), with the stack's timers a tenth of --fast-record's.

Each scenario is run twice over: once against the product as the design has it, where
it must pass, and once per way the product can be wrong that the scenario exists to
catch (a fault of the fake), where it must fail on the check that names it. As with the
step-2 scenarios, a pass here says the driver follows the design, not that a branch does.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e  # noqa: E402
import fake_closing  # noqa: E402
import fake_record  # noqa: E402
import fake_texera  # noqa: E402
import scenarios  # noqa: E402
import texera_api  # noqa: E402
from evidence import parse_checks  # noqa: E402
from record_timing import RecordTiming  # noqa: E402
from scenarios import resolve, run_scenario  # noqa: E402
from test_scenarios import ScenarioCase  # noqa: E402

#: --fast-record's timers, ten times shorter
FAST = RecordTiming(commit_interval_s=0.2, closing_interval_s=0.2, lost_after_s=1.2,
                    never_started_after_s=1.5, result_ttl_s=2.0, expiry_check_interval_s=0.5)


class GateTest(unittest.TestCase):
    """What a step-3 gate selects (design sections 5 and 7 H6)."""

    @staticmethod
    def keys(spec: str) -> list[str]:
        return resolve([spec], "create-ws", False)

    def test_gate_3a_is_step_2s_last_gate_plus_p_with_check_i(self):
        gate = e2e.GATES["3A"]
        self.assertEqual(self.keys(e2e.GATES["D"]["scenarios"]) + ["p"], self.keys(gate["scenarios"]))
        self.assertEqual(list("ABCDEF") + ["I"], parse_checks(gate["evidence"]))
        self.assertEqual("create-ws", gate["transport"])
        self.assertEqual(list("abcdeu") + ["p"], self.keys(gate["other_modes"]))  # Kubernetes, local-dev
        self.assertEqual("A", gate["level"])
        self.assertNotIn("level", e2e.GATES["D"])

    def test_gate_3b_adds_the_closing_scenarios_and_check_k(self):
        gate = e2e.GATES["3B"]
        self.assertEqual(self.keys(e2e.GATES["3A"]["scenarios"]) + list("qrstw"), self.keys(gate["scenarios"]))
        self.assertEqual(list("ABCDEF") + ["I", "K"], parse_checks(gate["evidence"]))
        # the other modes run what the design's H6 names: the unit taken down both ways, and the history
        self.assertEqual(list("abcdeu") + list("pqsw"), self.keys(gate["other_modes"]))
        self.assertEqual("B", gate["level"])
        self.assertEqual(frozenset({"3A", "3B"}), e2e.PORTABLE_GATES)

    def test_step_2s_gates_and_selections_are_what_they_were(self):
        self.assertEqual("all", e2e.GATES["D"]["evidence"])
        self.assertEqual(list("ABCDEF"), parse_checks("all"))
        self.assertFalse(set("pqrstw") & set(self.keys("all")))
        self.assertEqual(["p"], self.keys("p"))
        self.assertEqual(["p"], self.keys("record-in-lake"))
        self.assertEqual(["q", "s"], self.keys("unit-lost,polite-stop"))

    def test_every_fault_of_the_fake_is_documented_once(self):
        names = [*fake_record.FAULTS, *fake_closing.FAULTS, *fake_texera.FAULTS]
        self.assertEqual(len(names), len(set(names)))


class Step3Case(ScenarioCase):
    step = "3A"
    level = "A"
    timing = FAST

    def setUp(self):
        super().setUp()
        # the slow run sleeps 10 ms a tuple instead of 100: about 4 s
        self.fake.sleep_scale = 0.1

    def fails_on(self, key: str, *checks: str, fault: str | None = None):
        """Run `key` (with `fault` turned on in the fake), which must fail, and exactly on
        the checks whose names start so."""
        if fault is not None:
            self.assertIn(fault, {**fake_record.FAULTS, **fake_closing.FAULTS, **fake_texera.FAULTS})
            self.fake.faults.add(fault)
        rec = run_scenario(self.ctx, key)
        failed = [c.name for c in rec.checks if not c.ok]
        self.assertEqual("FAIL", rec.outcome, f"{key} passed; checks {self.names(rec)}")
        self.assertIsNone(rec.error, rec.error)
        self.assertEqual(len(checks), len(failed), failed)
        for want in checks:
            self.assertTrue(any(name.startswith(want) for name in failed), f"{want!r} not among {failed}")
        return rec

    def detail(self, rec, check: str) -> str:
        return next(c.detail for c in rec.checks if c.name.startswith(check))


class RecordInLake(Step3Case):
    """p at gate 3A: the Dashboard does not serve the log yet, so the label is read."""

    def test_p_reads_the_record_while_the_run_goes(self):
        rec = self.run_key("p")
        self.assertEqual(9, len(rec.checks), self.names(rec))
        states = [w["msg"]["type"] for w in self.fake.ws_log]
        self.assertEqual(["WorkflowStartRequest", "WorkflowPauseRequest", "WorkflowResumeRequest"],
                         [s for s in states if s != "ResultPaginationRequest"])
        # the run printed a line per tuple, and all of them are in the lake once it ended
        self.assertEqual(300, len(self.fake.execution_table(rec.eid, "console").rows))
        # until gate 3C the statistics request names the unit, as the browser's does
        stats = [r for r in self.fake.rest_log if r["path"].endswith(f"/stats/{rec.eid}")]
        self.assertTrue(stats and all(r["query"] == {"cuid": [str(self.ctx.cuid)]} for r in stats), stats)

    def test_p_needs_a_stack_with_fast_record(self):
        self.ctx.timing = RecordTiming()
        rec = run_scenario(self.ctx, "p")
        self.assertEqual("FAIL", rec.outcome)
        self.assertIn("--fast-record", rec.error)
        self.assertEqual([], self.fake.ws_log)  # refused before anything ran

    def test_p_fails_when_statistics_reach_the_lake_only_at_the_end(self):
        self.fake.faults.add("statistics-at-end-only")
        self.fails_on("p", "the statistics endpoint returns rows before the run ends",
                      "their count grows between two reads", "the stored rows are per operator")

    def test_p_fails_when_console_output_reaches_the_lake_only_at_the_end(self):
        self.fake.faults.add("console-at-end-only")
        self.fails_on("p", "console lines are stored before the run ends")

    def test_p_fails_on_a_gap_in_seq(self):
        self.fake.faults.add("seq-gap")
        rec = self.fails_on("p", "the log holds one row per seq")
        detail = next(c.detail for c in rec.checks if not c.ok)
        self.assertIn("5 row(s)", detail)  # READY, the output, RUNNING, PAUSED, RUNNING ...
        self.assertIn("('RUNNING', 6)", detail)  # ... numbered up to 6


class Step3BCase(Step3Case):
    """The product at gate 3B: the Dashboard closes executions."""

    step = "3B"
    level = "B"

    def setUp(self):
        super().setUp()
        self._refusal_wait = scenarios.REFUSAL_WAIT_S
        scenarios.REFUSAL_WAIT_S = 1.0  # the fake answers at once
        self.addCleanup(setattr, scenarios, "REFUSAL_WAIT_S", self._refusal_wait)


class RecordServedByTheDashboard(Step3BCase):
    """p and j at gate 3B: the log comes from /api/executions/{eid}/log, and the Dashboard
    refuses a late change by the closing record."""

    def test_p_reads_the_log_from_the_dashboard(self):
        rec = self.run_key("p")
        self.assertEqual(12, len(rec.checks), self.names(rec))
        self.assertIn("/log names the stored output port: its id, its result table (of this execution) and "
                      "its output mode", self.names(rec))
        logs = [r for r in self.fake.rest_log if r["path"] == f"/api/executions/{rec.eid}/log"]
        self.assertEqual(2, len(logs))  # while it runs, and after

    def test_p_fails_on_a_gap_in_seq(self):
        rec = self.fails_on("p", "while it runs /log shows READY, RUNNING, PAUSED, RUNNING, with seq rising by one",
                            "after the run /log's last row is COMPLETED", fault="seq-gap")
        self.assertIn("seq [1, 3, 4, 5, 6]", self.detail(rec, "while it runs /log"))

    def test_p_asks_nothing_of_output_rows_once_the_plan_names_the_ports(self):
        """The one switch for a log without `output` rows (the owner may move the stored
        ports' locations into the plan): with it off, p does not look for them."""
        self.addCleanup(setattr, scenarios, "LOG_NAMES_STORED_PORTS", texera_api.LOG_NAMES_STORED_PORTS)
        scenarios.LOG_NAMES_STORED_PORTS = False
        self.fake.log_names_stored_ports = False
        rec = self.run_key("p")
        self.assertEqual(11, len(rec.checks), self.names(rec))
        self.assertFalse(any("stored output port" in name for name in self.names(rec)))
        self.assertEqual(["state"] * 5, [r["kind"] for r in self.fake.closing.rows(rec.eid)])

    def test_j_waits_for_the_closing_record_before_its_late_change(self):
        rec = self.run_key("j")
        self.assertTrue(any(n.startswith("waited") and "(closed)" in n for n in rec.notes), rec.notes)

    def test_j_fails_when_an_ended_execution_stays_open(self):
        self.fails_on("j", "a change after the run completed is refused (409)", fault="row-left-open")


class UnitLost(Step3BCase):
    """q: the unit is killed under a run."""

    PASSES = ("unit left down", "unit back at once")

    def test_q_both_passes(self):
        rec = self.run_key("q")
        self.assertEqual(["kill", "start", "kill", "start"], self.ctx.stack.calls)
        verdicts = rec.facts["lost_verdicts"]
        self.assertEqual(list(self.PASSES), [v["pass"] for v in verdicts])
        for verdict in verdicts:
            # Running at every reading until the last, which is the verdict, inside its bounds
            self.assertEqual({1}, {r["status"] for r in verdict["readings"][:-1]}, verdict)
            last = verdict["readings"][-1]
            self.assertEqual((4, "unit lost"), (last["status"], last["reason"]))
            self.assertTrue(verdict["earliest_s"] <= last["t"] <= verdict["deadline_s"], verdict)
            # the log was left where the kill found it: no ending
            self.assertEqual("RUNNING", self.fake.closing.label(verdict["eid"])["state"])
        # the units were never listed: in Kubernetes a listing would end the wait at once
        self.assertFalse([r for r in self.fake.rest_log if (r["method"], r["path"]) == ("GET", "/api/computing-unit")])
        self.assertTrue(any(name.startswith("a: exact rows") for name in self.names(rec)))

    def test_q_fails_when_a_lost_unit_is_never_closed(self):
        rec = self.fails_on("q", *[f"{p}: {check}" for p in self.PASSES for check in (
            "the history turns status 4", "/state says closed", "/log has no ending row")],
            fault="lost-never-closed")
        self.assertIn("'status': 1", self.detail(rec, "unit left down: the history turns status 4"))

    def test_q_fails_on_a_verdict_that_comes_too_early(self):
        rec = self.fails_on("q", *[f"{p}: the verdict does not come before" for p in self.PASSES],
                            fault="verdict-too-early")
        self.assertIn("'reason': 'unit lost'", self.detail(rec, "unit left down: the verdict does not come"))

    def test_q_fails_when_a_lost_execution_ends_at_the_verdict_not_at_the_last_beat(self):
        self.fails_on("q", *[f"{p}: completionTime is the last beat" for p in self.PASSES], fault="ended-at-now")

    def test_q_fails_when_an_open_execution_has_no_completion_time(self):
        self.fails_on("q", *[f"{p}: until the verdict the history reads status 1" for p in self.PASSES],
                      fault="completion-null-while-open")

    def test_a_reading_the_gateway_did_not_answer_is_no_verdict(self):
        """nginx restarts when the unit comes back at another address; the history is then
        unreachable for a moment, which says nothing about the execution."""
        real = self.ctx.api.execution_entry
        answers = iter([requests.ConnectionError("gateway restarting"), {"status": 1, "completionTime": 5},
                        texera_api.TexeraApiError("GET", "/api/executions/1", 502, "Bad Gateway"),
                        {"status": 4, "reason": "unit lost", "completionTime": 6}])

        def entry(wid, eid):
            answer = next(answers)
            if isinstance(answer, Exception):
                raise answer
            return answer
        self.ctx.api.execution_entry = entry
        self.addCleanup(setattr, self.ctx.api, "execution_entry", real)
        seen = scenarios._watch_history(self.ctx, 1, 2, time.monotonic(), give_up_s=5)
        self.assertEqual([None, 1, None, 4], [r["status"] for r in seen])
        self.assertIn("ConnectionError: gateway restarting", seen[0]["unanswered"])
        self.assertEqual([1], [r["status"] for r in scenarios._before_verdict(seen, seen[-1])])

    def test_q_needs_the_stacks_control_and_gate_3b(self):
        self.ctx.stack = None
        rec = run_scenario(self.ctx, "q")
        self.assertIn("needs the stack's control", rec.error)
        self.ctx.level = "A"
        rec = run_scenario(self.ctx, "q")
        self.assertIn("needs what step 3's gate 3B brings", rec.error)
        self.assertEqual([], self.fake.ws_log)  # refused before anything ran


class UnitLostInKubernetes(Step3BCase):
    """q where a unit is a pod of its own: the unit that comes back is another one, and a
    listing of the units makes the platform notice the one that is gone."""

    def setUp(self):
        super().setUp()
        self.fake.kubernetes = True
        unit = self.ctx.api.post_json("/api/computing-unit/create",
                                      {"name": "k8s-unit", "unitType": "kubernetes", "uri": ""})["computingUnit"]
        self.first = self.ctx.cuid = self.ctx.stack.cuid = int(unit["cuid"])
        self.ctx.stats_through_unit = True  # until gate 3C the gateway sends statistics requests to the unit

    def test_q_has_a_third_pass_that_lists_the_units(self):
        rec = self.run_key("q")
        verdicts = {v["pass"]: v for v in rec.facts["lost_verdicts"]}
        self.assertEqual(["unit left down", "unit back at once", "units listed after the kill"], list(verdicts))
        listed = verdicts["units listed after the kill"]
        self.assertIsNone(listed["earliest_s"])
        self.assertLessEqual(listed["readings"][-1]["t"], 2 * self.timing.closing_interval_s)
        # every pass ran on a unit of its own, and the scenarios after q get the newest
        units = {self.fake.executions[v["eid"]]["cuid"] for v in verdicts.values()}
        self.assertEqual(3, len(units))
        self.assertNotIn(self.ctx.cuid, units)
        self.assertEqual(self.ctx.stack.cuid, self.ctx.cuid)
        # only the third pass listed the units, and only its unit was stamped by the listing
        listings = [r for r in self.fake.rest_log if (r["method"], r["path"]) == ("GET", "/api/computing-unit")]
        self.assertEqual(1, len(listings))
        self.assertEqual(listed["eid"], max(v["eid"] for v in verdicts.values()))
        # that one listing stamped every unit whose pod was gone; the first two executions
        # were closed by the beat before it, with their units' rows still unstamped
        stamped = {c: u.get("terminationReason") for c, u in self.fake.units.items() if u.get("terminateTime")}
        self.assertEqual(dict.fromkeys(units, "GARBAGE_COLLECTED"), stamped)

    def test_stored_statistics_cannot_be_asked_for_while_the_unit_is_down(self):
        """Why q counts the table's rows there: the route goes to the unit until gate 3C."""
        self.fake.take_unit_down(polite=False, cuid=self.first)
        with self.assertRaises(texera_api.TexeraApiError) as cm:
            self.ctx.statistics(10, 100)
        self.assertEqual(503, cm.exception.status)


class NeverStarted(Step3BCase):
    def test_r(self):
        rec = self.run_key("r")
        verdict = rec.facts["never_started_verdict"]
        self.assertEqual({0}, {r["status"] for r in verdict["readings"][:-1]})
        self.assertGreaterEqual(verdict["readings"][-1]["t"], self.timing.never_started_after_s)
        self.assertTrue(self.fake.executions[rec.eid]["started"])  # the Dashboard took the start
        self.assertFalse(self.fake.runs)  # and nothing ever ran

    def test_r_fails_when_an_unstarted_execution_is_never_closed(self):
        rec = self.fails_on("r", "the history turns status 4", "/state says closed", "the plan table has",
                            "a start after that: the starting socket", "a start after that: never Running",
                            "a start after that: the row stays 4", fault="never-started-never-closed")
        self.assertIn("'status': 0", self.detail(rec, "the history turns status 4"))

    def test_r_fails_on_a_verdict_that_comes_too_early(self):
        self.fails_on("r", "... and not before it is older than never-started-after",
                      fault="never-started-too-early")

    def test_r_fails_when_the_closed_execution_can_still_be_started(self):
        self.fails_on("r", "the plan table has the `started` tag", "a start after that: the starting socket",
                      "a start after that: never Running", fault="start-after-never-started")


class PoliteStop(Step3BCase):
    def test_s(self):
        rec = self.run_key("s")
        self.assertEqual(["stop", "start"], self.ctx.stack.calls)
        readings = rec.facts["stop_verdict"]["readings"]
        self.assertEqual("the computing unit was stopped", readings[-1]["reason"])
        # the unit left its tables as they were: no end tidy
        self.assertGreater(len(self.fake.execution_table(rec.eid, "log").files), 1)

    def test_s_fails_when_the_stop_records_nothing(self):
        rec = self.fails_on("s", "the history turns status 4", "/log ends with a FAILED row",
                            fault="stop-unrecorded")
        self.assertIn("'status': 1", self.detail(rec, "the history turns status 4"))


class Expiry(Step3BCase):
    AFTER = ("first execution, after the second create", "second execution, after the TTL")

    def test_t(self):
        rec = self.run_key("t")
        first, second = sorted(e for e, x in self.fake.executions.items() if x["wid"] == rec.wid)
        self.assertEqual(second, rec.eid)
        for eid in (first, second):
            row = self.fake.executions[eid]
            self.assertIsNotNone(row["results_expired_at"])
            self.assertEqual(3, row["outcome"])
        # no third execution was created: the second one's results went by age
        creates = [r for r in self.fake.rest_log if (r["method"], r["path"]) == ("POST", "/api/executions")]
        self.assertEqual(2, len(creates))

    def test_t_fails_when_results_outlive_their_expiry(self):
        self.fails_on("t", f"{self.AFTER[0]}: its result and state tables are gone",
                      "second execution: its results expire by age",
                      f"{self.AFTER[1]}: its result and state tables are gone", fault="expiry-keeps-results")

    def test_t_fails_when_the_expiry_takes_the_record_too(self):
        self.fails_on("t", *[f"{after}: its plan, log and statistics are still there" for after in self.AFTER],
                      fault="expiry-drops-record")

    def test_t_fails_when_the_stored_bytes_do_not_fall(self):
        rec = self.fails_on("t", *[f"{after}: storedBytes fell" for after in self.AFTER],
                            fault="stored-bytes-unchanged")
        self.assertRegex(self.detail(rec, f"{self.AFTER[0]}: storedBytes fell"), r"storedBytes (\d+) -> \1;")

    def test_t_fails_when_results_never_expire_by_age(self):
        self.fails_on("t", "second execution: its results expire by age",
                      f"{self.AFTER[1]}: its result and state tables are gone", f"{self.AFTER[1]}: storedBytes fell",
                      fault="no-expiry-by-age")

    def test_t_fails_when_results_expire_before_the_ttl(self):
        """The pass by age runs every expiry interval, so what else fails depends on when."""
        self.fake.faults.add("expiry-too-early")
        rec = run_scenario(self.ctx, "t")
        expired = next(c for c in rec.checks if c.name.startswith("second execution: its results expire by age"))
        self.assertFalse(expired.ok)
        self.assertRegex(expired.detail, r"result tables 0 at [01]\.\d s after the run ended")


class HistoryOutcomes(Step3BCase):
    def setUp(self):
        super().setUp()
        self.fake.sleep_scale = 1.0  # d's bound on work done while paused counts real seconds per tuple
        self.addCleanup(setattr, scenarios, "PAUSE_HOLD_S", scenarios.PAUSE_HOLD_S)
        scenarios.PAUSE_HOLD_S = 0.5

    REASONS = ("d: the history says 5", "d: the admin's list agrees", "k: the history says 4",
               "k: the admin's list agrees", "a UDF that raises: the history says 4",
               "a UDF that raises: the admin's list agrees", "d's log is READY, RUNNING, PAUSED, RUNNING, KILLED")

    def test_w(self):
        rec = self.run_key("w")
        reasons = {x["outcome"]: x["outcome_reason"] for x in self.fake.executions.values()}
        self.assertEqual("killed by the user", reasons[5])
        self.assertIsNone(reasons[3])
        self.assertEqual({5, 4, 3}, set(reasons))
        for part in ("d", "k", "a", "a UDF that raises"):
            self.assertTrue(any(name.startswith(f"{part}: ") for name in self.names(rec)), part)
        # the admin's list was asked for once, after the four were closed
        self.assertEqual(1, len([r for r in self.fake.rest_log if "/admin/execution/executionList/" in r["path"]]))

    def test_w_fails_when_the_record_does_not_say_why(self):
        """a's entries hold: a completed run has no reason to give."""
        self.fails_on("w", *self.REASONS[:6], fault="no-reason")


if __name__ == "__main__":
    unittest.main()
