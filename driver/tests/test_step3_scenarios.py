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

import dataclasses
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
        self.assertEqual(list("ABCDF") + ["I"], parse_checks(gate["evidence"]))
        self.assertEqual("create-ws", gate["transport"])
        self.assertEqual(list("abcdeu") + ["p"], self.keys(gate["other_modes"]))  # Kubernetes, local-dev
        self.assertEqual("A", gate["level"])
        self.assertNotIn("level", e2e.GATES["D"])

    def test_gate_3b_adds_the_closing_scenarios_and_check_k(self):
        gate = e2e.GATES["3B"]
        self.assertEqual(self.keys(e2e.GATES["3A"]["scenarios"]) + list("qrstw"), self.keys(gate["scenarios"]))
        self.assertEqual(list("ABCDF") + ["I", "K"], parse_checks(gate["evidence"]))
        # the other modes run what the design's H6 names: the unit taken down both ways, and the history
        self.assertEqual(list("abcdeu") + list("pqsw"), self.keys(gate["other_modes"]))
        self.assertEqual("B", gate["level"])

    def test_gate_3c_adds_v_and_the_checks_of_a_unit_off_postgres(self):
        gate = e2e.GATES["3C"]
        self.assertEqual(self.keys(e2e.GATES["3B"]["scenarios"]) + ["v"], self.keys(gate["scenarios"]))
        # A and B are retired; J is among them, and gates on a stack started with --unit-no-postgres
        self.assertEqual(list("CDFGHIJK"), parse_checks(gate["evidence"]))
        self.assertEqual(list("abcdeu") + list("pqsvw"), self.keys(gate["other_modes"]))
        self.assertEqual((e2e.FINISHED_LEVEL, "C"), (gate["level"], gate["level"]))
        self.assertEqual(frozenset({"3A", "3B", "3C"}), e2e.PORTABLE_GATES)

    def test_a_run_without_a_step_3_gate_is_as_it_was_unless_it_selects_a_step_3_scenario(self):
        """Step 2's images are still run (the negative controls, an ad hoc scenario): j must
        not ask them for step 3's routes."""
        self.assertIsNone(e2e.product_level({}, ["a", "j", "l8"]))
        self.assertIsNone(e2e.product_level(e2e.GATES["D"], self.keys(e2e.GATES["D"]["scenarios"])))
        self.assertEqual("C", e2e.product_level({}, ["j", "p"]))  # named: on the whole of step 3
        self.assertEqual("C", e2e.product_level({}, ["a", "q"]))  # as step 3's negative control selects
        self.assertEqual(["A", "B", "C"], [e2e.product_level(e2e.GATES[g], ["a"]) for g in ("3A", "3B", "3C")])

    def test_step_2s_gates_and_selections_are_what_they_were(self):
        self.assertEqual("all", e2e.GATES["D"]["evidence"])
        self.assertEqual(list("ABCDF"), parse_checks("all"))
        self.assertFalse(set("pqrstwv") & set(self.keys("all")))
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
        # the rows of its result tables are read from Postgres, with the evidence only
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
        rec = self.fails_on("p", "the log holds one row per state change")
        detail = next(c.detail for c in rec.checks if not c.ok)
        self.assertIn("4 row(s)", detail)  # READY, RUNNING, PAUSED, RUNNING ...
        self.assertIn("('RUNNING', 5)", detail)  # ... numbered up to 5

    def test_p_fails_when_the_log_holds_a_row_that_is_no_state_change(self):
        """The design's revision 2 had the log name each stored port; it no longer does."""
        rec = self.fails_on("p", "the log holds one row per state change", fault="output-rows")
        self.assertIn("5 row(s)", next(c.detail for c in rec.checks if not c.ok))


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
        # without the evidence, the rows of its result tables are not read
        self.assertEqual(11, len(rec.checks), self.names(rec))
        logs = [r for r in self.fake.rest_log if r["path"] == f"/api/executions/{rec.eid}/log"]
        self.assertEqual(2, len(logs))  # while it runs, and after
        # the log holds the run's five state changes and nothing else
        self.assertEqual(["state"] * 5, [r["kind"] for r in self.fake.closing.rows(rec.eid)])

    WHILE_IT_RUNS = "while it runs /log shows READY, RUNNING, PAUSED, RUNNING and nothing else"

    def test_p_fails_on_a_gap_in_seq(self):
        rec = self.fails_on("p", self.WHILE_IT_RUNS, "after the run /log's last row is COMPLETED", fault="seq-gap")
        self.assertIn("seq [1, 3, 4, 5]", self.detail(rec, self.WHILE_IT_RUNS))

    def test_p_fails_when_the_log_holds_a_row_that_is_no_state_change(self):
        rec = self.fails_on("p", self.WHILE_IT_RUNS, fault="output-rows")
        self.assertIn("states ['READY', None, 'RUNNING', 'PAUSED', 'RUNNING']", self.detail(rec, self.WHILE_IT_RUNS))

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
        self.assertEqual({6}, {r["status"] for r in verdict["readings"][:-1]})  # Created until it is closed
        self.assertGreaterEqual(verdict["readings"][-1]["t"], self.timing.never_started_after_s)
        # the late start's run replaced the verdict, from its log; the verdict had kept its results
        row = self.fake.executions[rec.eid]
        self.assertEqual((3, None, True, None), (row["outcome"], row["outcome_reason"], row["from_log"],
                                                 row["results_expired_at"]))
        # two starts, one run: the unit took the execution's start once
        starts = [w["msg"] for w in self.fake.ws_log if w["msg"]["type"] == "WorkflowStartRequest"]
        self.assertEqual([rec.eid, rec.eid], [s["executionId"] for s in starts])
        self.assertEqual([rec.eid], list(self.fake.runs))

    def test_r_fails_when_an_unstarted_execution_is_never_closed(self):
        """The late start's run then ends it, as any run's log does."""
        rec = self.fails_on("r", "the history turns status 4", "/state says closed",
                            fault="never-started-never-closed")
        self.assertIn("'status': 6", self.detail(rec, "the history turns status 4"))

    def test_r_fails_when_an_unstarted_execution_reads_as_one_that_is_starting(self):
        """Before step 2's review a created execution read Initializing, which locked its editor."""
        rec = self.fails_on("r", "until then the history reads status 6", fault="created-reads-initializing")
        self.assertIn("'status': 0", self.detail(rec, "until then the history reads status 6"))

    def test_r_fails_on_a_verdict_that_comes_too_early(self):
        self.fails_on("r", "... and not before it is older than never-started-after",
                      fault="never-started-too-early")

    def test_r_fails_when_the_verdict_stays_after_the_late_run_ended(self):
        self.addCleanup(setattr, scenarios, "LABEL_WAIT_S", scenarios.LABEL_WAIT_S)
        scenarios.LABEL_WAIT_S = 1.0  # the wait for the verdict to give way ends in nothing
        rec = self.fails_on("r", "the run's own ending takes the verdict's place",
                            "its log ends COMPLETED, and its closing record is the log's",
                            "a second start: the row stays 3", fault="verdict-not-revised")
        self.assertIn("status 4, reason 'never started'", self.detail(rec, "the run's own ending"))

    def test_r_fails_when_the_unit_starts_an_execution_twice(self):
        self.fails_on("r", "a second start: the starting socket gets a RequestRefusedEvent of its start",
                      "a second start: the first session gets no refusal, no error and no new state",
                      "a second start: never Running", fault="start-taken-twice")


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


#: t's waits are a few scheduling delays away from the TTL at a tenth of --fast-record's
#: timers (as they are a few seconds away on a stack), so its tests get a longer one
EXPIRY_TIMING = dataclasses.replace(FAST, result_ttl_s=3.0)


class Expiry(Step3BCase):
    timing = EXPIRY_TIMING
    AFTER = ("first execution, replaced", "second execution, after the TTL")
    REPLACED = "first execution: the second, once started, replaces its results"
    AGED = "second execution: a third that is created and never started replaces nothing"

    def test_t(self):
        rec = self.run_key("t")
        first, second, third = sorted(e for e, x in self.fake.executions.items() if x["wid"] == rec.wid)
        self.assertEqual(second, rec.eid)
        ages = []
        for eid in (first, second):
            row = self.fake.executions[eid]
            self.assertEqual(3, row["outcome"])
            ages.append((row["results_expired_at"] - row["ended_at"]) / 1000)
        ttl = self.timing.result_ttl_s
        self.assertLess(ages[0], ttl)  # the second run replaced the first one's results
        self.assertGreaterEqual(ages[1], ttl)  # the second one's went by age ...
        self.assertNotIn(third, self.fake.runs)  # ... for nothing ever started the third

    def test_t_fails_when_results_outlive_their_expiry(self):
        self.fails_on("t", self.REPLACED, f"{self.AFTER[0]}: its result and state tables are gone", self.AGED,
                      f"{self.AFTER[1]}: its result and state tables are gone", fault="expiry-keeps-results")

    def test_t_fails_when_a_later_run_replaces_nothing(self):
        self.fails_on("t", self.REPLACED, f"{self.AFTER[0]}: its result and state tables are gone",
                      f"{self.AFTER[0]}: storedBytes fell", fault="no-replacement")

    def test_t_fails_when_a_create_alone_replaces_results(self):
        """The design's revision 2: the next create expired them, started or not."""
        rec = self.fails_on("t", self.AGED, fault="replaced-at-create")
        self.assertRegex(self.detail(rec, self.AGED), r"result tables 0 at [01]\.\d s after the run ended")

    def test_t_fails_when_the_expiry_takes_the_record_too(self):
        self.fails_on("t", *[f"{after}: its log and statistics are still there" for after in self.AFTER],
                      fault="expiry-drops-record")

    def test_t_fails_when_the_stored_bytes_do_not_fall(self):
        rec = self.fails_on("t", *[f"{after}: storedBytes fell" for after in self.AFTER],
                            fault="stored-bytes-unchanged")
        self.assertRegex(self.detail(rec, f"{self.AFTER[0]}: storedBytes fell"), r"storedBytes (\d+) -> \1;")

    def test_t_fails_when_results_never_expire_by_age(self):
        self.fails_on("t", self.AGED, f"{self.AFTER[1]}: its result and state tables are gone",
                      f"{self.AFTER[1]}: storedBytes fell", fault="no-expiry-by-age")

    def test_t_fails_when_results_expire_before_the_ttl(self):
        """The expiry looks every check interval, so what else fails depends on when."""
        self.fake.faults.add("expiry-too-early")
        rec = run_scenario(self.ctx, "t")
        expired = next(c for c in rec.checks if c.name.startswith(self.AGED))
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


class Step3CCase(Step3BCase):
    """The product at gate 3C: stored output is served by execution, with or without a unit."""

    step = "3C"
    level = "C"


class StoredReadsWithoutTheUnit(Step3CCase):
    def test_v(self):
        rec = self.run_key("v")
        self.assertEqual(["stop", "start"], self.ctx.stack.calls)
        own = [name for name in self.names(rec) if not name.startswith(("e: ", "a: "))]
        self.assertEqual(7, len(own), own)
        # every read was made while the unit was down
        self.assertEqual("the unit is down: a new socket to it is refused", own[0])
        # the statistics and the export carry the marks a Kubernetes run looks for in Envoy's log
        marks = {m["what"]: m for m in rec.facts["gateway_markers"]}
        self.assertEqual({"export": 200, "statistics": 200}, {what: m["status"] for what, m in marks.items()})
        asked = {r["path"]: r["query"]["sce-probe"] for r in self.fake.rest_log if "sce-probe" in r["query"]}
        self.assertEqual([marks["export"]["marker"]], asked.pop("/api/executions/result/export/local"))
        ((path, mark),) = asked.items()  # the other marked request: a's statistics
        self.assertRegex(path, r"^/api/executions/\d+/stats/\d+$")
        self.assertEqual([marks["statistics"]["marker"]], mark)
        # from gate 3C a statistics request names no unit
        self.assertFalse(any("cuid" in r["query"] for r in self.fake.rest_log if "/stats/" in r["path"]))
        # the export named the execution, not a unit, and carried the user's token in its form
        form = next(r["body"] for r in self.fake.rest_log if r["path"].endswith("/export/local"))
        self.assertIn("executionId", form)
        self.assertNotIn("computingUnitId", form)
        self.assertIn("token=", form)

    def test_v_fails_when_stored_output_needs_the_unit(self):
        rec = self.fails_on("v", "console: the console route returns", "export: a local CSV export",
                            "statistics: the Filter's newest stored row", fault="stored-reads-need-unit")
        self.assertIn("HTTP 503", self.detail(rec, "export: a local CSV export"))
        self.assertEqual(["stop", "start"], self.ctx.stack.calls)  # the unit is back all the same

    def test_v_needs_gate_3c(self):
        self.ctx.level = "B"
        rec = run_scenario(self.ctx, "v")
        self.assertIn("needs what step 3's gate 3C brings", rec.error)
        self.assertEqual([], self.ctx.stack.calls)

    def test_an_export_reads_as_rows(self):
        header, rows = scenarios._export_rows("department,total_salary,n\r\neng,320000.5,3\r\nops,9E4,1\r\n")
        self.assertEqual((["department", "total_salary", "n"],
                          [{"department": "eng", "total_salary": 320000.5, "n": 3},
                           {"department": "ops", "total_salary": 90000.0, "n": 1}]), (header, rows))
        self.assertEqual(([], []), scenarios._export_rows(""))


class RecordByExecutionAtGate3C(Step3CCase):
    """p at gate 3C: the console route."""

    def test_p_reads_the_console_route_while_the_run_goes_and_after(self):
        rec = self.run_key("p")
        # without the evidence, the rows of its result tables are not read
        self.assertEqual(13, len(rec.checks), self.names(rec))
        self.assertIn("after the run the console route returns all 300 lines in 2 page(s), seq rising by one",
                      self.names(rec))
        pages = [r["query"] for r in self.fake.rest_log if r["path"].endswith("/console") and "afterSeq" in r["query"]]
        self.assertEqual([["0"], ["200"]], [q["afterSeq"] for q in pages[-2:]])

    def test_p_fails_when_console_output_reaches_the_lake_only_at_the_end(self):
        self.fails_on("p", "console lines are stored before the run ends",
                      "the console route returns the UDF's stored lines before the run ends",
                      fault="console-at-end-only")


class ExpiryAtGate3C(Step3CCase):
    """t at gate 3C: an export of results that have expired."""

    timing = EXPIRY_TIMING

    def test_t_asks_for_an_export_of_expired_results(self):
        rec = self.run_key("t")
        self.assertEqual(2, len([n for n in self.names(rec) if "an export answers 410" in n]))

    def test_t_fails_when_an_export_of_expired_results_is_not_410(self):
        rec = self.fails_on("t", *[f"{after}: an export answers 410" for after in Expiry.AFTER],
                            fault="export-after-expiry")
        self.assertIn("HTTP 500", self.detail(rec, f"{Expiry.AFTER[0]}: an export answers 410"))


class UnitWithoutPostgresInTheOtherModes(Step3CCase):
    """What Kubernetes and local-dev mode show of a unit off Postgres (design H6), where no
    statement log is read: the driver asks the stack's control (e2e._unit_without_postgres)."""

    def proof(self, env_names: bool = False) -> dict:
        return e2e._unit_without_postgres(self.ctx.stack, "after the setup", env_names=env_names)

    def test_a_unit_off_postgres(self):
        proof = self.proof()
        self.assertEqual((True, "after the setup", "Postgres holds no connection of the unit"),
                         (proof["ok"], proof["when"], proof["detail"]))

    def test_a_unit_that_keeps_its_pool_is_found_by_its_name(self):
        """local-dev: every JVM reaches Postgres from 127.0.0.1, so the name is all there is."""
        self.fake.faults.add("unit-pool")
        self.fake.unit_address = "127.0.0.1"
        self.ctx.stack.unit_addresses = lambda: []
        proof = self.proof()
        self.assertFalse(proof["ok"])
        self.assertIn("2 connection(s) of the unit in pg_stat_activity: pid 300 app=texera-computing-unit "
                      "from 127.0.0.1", proof["detail"])

    def test_a_kubernetes_unit_must_not_be_given_the_database_login(self):
        self.fake.kubernetes = True
        proof = self.proof(env_names=True)
        self.assertTrue(proof["ok"], proof)
        self.assertIn("the unit was given no STORAGE_JDBC_* setting", proof["detail"])
        self.fake.step = "3B"  # before sub-part 19 the manager hands the login over, and the unit uses it
        proof = self.proof(env_names=True)
        self.assertFalse(proof["ok"])
        self.assertEqual(["STORAGE_JDBC_PASSWORD", "STORAGE_JDBC_URL", "STORAGE_JDBC_USERNAME"],
                         proof["database_login"])
        self.assertEqual(2, len(proof["connections"]))

    def test_a_stack_that_cannot_be_asked_proves_nothing(self):
        def refused():
            raise RuntimeError("k8s-stack.sh pg-activity: exit 1")
        self.ctx.stack.pg_activity = refused
        proof = self.proof()
        self.assertFalse(proof["ok"])
        self.assertIn("not evaluable: RuntimeError: k8s-stack.sh pg-activity: exit 1", proof["detail"])


class ControlOnQ(unittest.TestCase):
    """What step 3's negative control reads of q (scenarios.stayed_running)."""

    @staticmethod
    def record(*statuses: int, deadline: float = 18.0, step: float = 5.0, unanswered: int = 0):
        rec = scenarios.ScenarioRecord("q", "unit-lost", "")
        readings = [{"t": i * step, "status": status, "reason": None} for i, status in enumerate(statuses)]
        readings += [{"t": 1.0, "status": None, "unanswered": "ConnectionError"}] * unanswered
        if statuses:
            rec.facts["lost_verdicts"] = [{"pass": "unit left down", "deadline_s": deadline, "readings": readings}]
        return rec

    def test_running_past_the_deadline_is_the_old_products_way(self):
        held, detail = scenarios.stayed_running(self.record(1, 1, 1, 1, 1))
        self.assertTrue(held)
        self.assertIn("still says status 1 20.0 s after the kill, past the deadline of 18 s", detail)

    def test_a_closed_execution_means_the_control_proved_nothing(self):
        held, detail = scenarios.stayed_running(self.record(1, 1, 4))
        self.assertFalse(held)
        self.assertTrue(detail.startswith("PASSED, so the control proves nothing: the execution was closed"))

    def test_anything_else_is_inconclusive(self):
        for rec, why in ((self.record(), "the unit was never killed under a run"),
                         # not watched long enough
                         (self.record(1, 1), "the last 5.0 s after the kill (deadline 18 s)"),
                         (self.record(1, 0, 1, 1, 1), "the history read status [0, 1]"),
                         (self.record(1, 1, 1, 1, unanswered=1), "over 4 reading(s)")):
            held, detail = scenarios.stayed_running(rec)
            self.assertFalse(held)
            self.assertTrue(detail.startswith("control inconclusive"), detail)
            self.assertIn(why, detail)


if __name__ == "__main__":
    unittest.main()
