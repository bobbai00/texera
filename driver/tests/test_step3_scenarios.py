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
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e  # noqa: E402
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
        self.assertEqual(frozenset({"3A"}), e2e.PORTABLE_GATES)
        self.assertEqual("A", gate["level"])
        self.assertNotIn("level", e2e.GATES["D"])

    def test_step_2s_gates_and_selections_are_what_they_were(self):
        self.assertEqual("all", e2e.GATES["D"]["evidence"])
        self.assertEqual(list("ABCDEF"), parse_checks("all"))
        self.assertNotIn("p", self.keys("all"))
        self.assertEqual(["p"], self.keys("p"))
        self.assertEqual(["p"], self.keys("record-in-lake"))


class Step3Case(ScenarioCase):
    step = "3A"
    level = "A"
    timing = FAST

    def setUp(self):
        super().setUp()
        # the slow run sleeps 10 ms a tuple instead of 100: about 4 s
        self.fake.sleep_scale = 0.1

    def fails_on(self, key: str, *checks: str):
        """Run `key`, which must fail, and exactly on the checks whose names start so."""
        rec = run_scenario(self.ctx, key)
        failed = [c.name for c in rec.checks if not c.ok]
        self.assertEqual("FAIL", rec.outcome, f"{key} passed; checks {self.names(rec)}")
        self.assertIsNone(rec.error, rec.error)
        self.assertEqual(len(checks), len(failed), failed)
        for want in checks:
            self.assertTrue(any(name.startswith(want) for name in failed), f"{want!r} not among {failed}")
        return rec


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


if __name__ == "__main__":
    unittest.main()
