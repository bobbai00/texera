"""Offline runs of the driver's own main (driver/e2e.py), from its command line to its
report, on the fake stack: the fake Texera at a step, a fake `docker` for the evidence,
the fake lake for the catalog and the fake stack's control. What the other tests cover
piece by piece (a gate's selection, the evidence, the final checks, the negative control)
is run here as the driver wires it together.

Nothing real is reached: the evidence is given the fake `docker`, and for the length of a
run the process's DOCKER_HOST is a socket that does not exist.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import functools
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e  # noqa: E402
import evidence as ev  # noqa: E402
import scenarios  # noqa: E402
from fake_stack import FakeStack  # noqa: E402
from fake_texera import FakeTexera  # noqa: E402
from lake import Catalog, Lake  # noqa: E402
from stack_control import NO_DOCKER  # noqa: E402
from test_scenarios import FILES, VERSION_PATH  # noqa: E402
from test_step3_evidence import StackLakeDocker  # noqa: E402
from test_step3_scenarios import FAST  # noqa: E402
from texera_api import TexeraApi  # noqa: E402

#: FAST as a stack's manifest records the timers it set (lib/record_env.py's keys)
FAST_IN_A_MANIFEST = {"commit_interval_ms": 200, "closing_interval_s": 0.2, "lost_after_s": 1.2,
                      "never_started_after_s": 1.5, "result_ttl_s": 2.0, "expiry_check_interval_s": 0.5}
DATASET = {"did": 1, "version": "v1", "reused": True, "paths": {f: f"{VERSION_PATH}/{f}" for f in FILES}}


class DriverMainTest(unittest.TestCase):
    def run_main(self, *argv: str, step: str, stack_options: dict | None = None, faults=()) -> tuple[int, dict]:
        """Run `driver/e2e.py <argv>` against the fake at `step`; (its exit code, its report)."""
        tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.fake = fake = FakeTexera(step=step, timing=FAST)
        fake.sleep_scale, fake.cleanup_s = 0.1, 0.3
        fake.faults |= set(faults)
        base = fake.start()
        self.addCleanup(fake.stop)
        docker = StackLakeDocker(fake)
        fake.statement_sink, fake.access_sink = docker.statement, docker.access
        manifest = tmp / "MANIFEST.json"
        manifest.write_text(json.dumps({"options": {"record_timing": FAST_IN_A_MANIFEST, **(stack_options or {})}}))
        report = tmp / "report.json"
        stand_ins = (
            mock.patch.object(e2e, "Evidence", functools.partial(ev.Evidence, runner=docker, cleanup_wait_s=8.0,
                                                                 quiet_s=0.4, record_settle_s=1.0)),
            mock.patch.object(e2e, "_stack_control", lambda a, api, containers, **kw: FakeStack(fake, api)),
            mock.patch.object(e2e, "_lake", lambda a, containers, env: Lake(Catalog(fake.lake.fetch))),
            mock.patch.object(TexeraApi, "ensure_dataset", lambda self, name, files, description="": dict(DATASET)),
            mock.patch.object(e2e, "log", lambda message: None),
            mock.patch.object(scenarios, "REFUSAL_SETTLE_S", 0.5),
            mock.patch.object(scenarios, "REFUSAL_WAIT_S", 1.0),
            mock.patch.dict("os.environ", {"DOCKER_HOST": NO_DOCKER}),
            mock.patch("sys.stdout", new_callable=io.StringIO),
            mock.patch.object(sys, "argv", ["e2e.py", "--base", base, "--stack-manifest", str(manifest),
                                            "--report", str(report), *argv]),
        )
        for stand_in in stand_ins:
            self.enterContext(stand_in)
        return e2e.main(), json.loads(report.read_text())

    @staticmethod
    def outcomes(report: dict) -> dict[str, str]:
        return {s["key"]: s["outcome"] for s in report["scenarios"]}

    @staticmethod
    def failed(report: dict, key: str) -> list[str]:
        return [c["name"] for s in report["scenarios"] if s["key"] == key for c in s["checks"] if not c["ok"]]

    def test_gate_3c_on_a_stack_whose_unit_has_no_postgres(self):
        rc, report = self.run_main("--gate", "3C", "--scenario", "a,v", step="3C",
                                   stack_options={"unit_no_postgres": True})
        self.assertEqual((0, {"a": "PASS", "v": "PASS"}), (rc, self.outcomes(report)), report["summary"])
        self.assertEqual(list("CDEFGHIJK"), report["evidence"]["required"])
        self.assertEqual(("3C", "create-ws"), (report["gate"], report["transport"]["name"]))
        self.assertTrue(report["setup"]["record_timing"]["fast"])
        finals = report["final_checks"]
        self.assertEqual([True, True], [f["ok"] for f in finals])
        self.assertTrue(finals[0]["name"].startswith("Check K") and finals[1]["name"].startswith("Check G"))
        self.assertEqual(finals[0], report["final_check"])
        gated = {c["name"].split(":")[0] for s in report["scenarios"] for c in s["checks"] if "evidence " in c["name"]}
        self.assertEqual({f"evidence {c}" for c in "CDEFGHIJ"}, gated)

    def test_gate_3c_on_a_stack_with_postgres_beside_the_unit_leaves_check_j_out(self):
        rc, report = self.run_main("--gate", "3C", "--scenario", "a", step="3C")
        self.assertEqual((0, list("CDEFGHIK")), (rc, report["evidence"]["required"]))
        self.assertNotIn("J", report["scenarios"][0]["evidence"]["checks"])

    def test_gate_3b_ends_with_check_k_and_closes_what_a_refused_start_left(self):
        rc, report = self.run_main("--gate", "3B", "--scenario", "a,l5", step="3B")
        self.assertEqual((0, {"a": "PASS", "l5": "PASS"}), (rc, self.outcomes(report)), report["summary"])
        self.assertEqual(list("ABCDEF") + ["I", "K"], report["evidence"]["required"])
        final = report["final_check"]
        self.assertTrue(final["name"].startswith("Check K"))
        self.assertNotIn("final_checks", report)  # one final check, where it always was
        self.assertEqual([(3, ""), (4, "never started")], [(r["outcome"], r["reason"]) for r in final["rows"]])

    def test_a_unit_that_still_writes_to_postgres_fails_gate_3c_twice(self):
        """In the scenario, and in the look at the whole log."""
        rc, report = self.run_main("--gate", "3C", "--scenario", "a", step="3C", faults=["unit-statement"])
        self.assertEqual((1, "FAIL"), (rc, report["summary"]["result"]))
        self.assertEqual(["evidence G: no statement at all comes from the unit"], self.failed(report, "a"))
        self.assertEqual([True, False], [f["ok"] for f in report["final_checks"]])

    def test_step_3s_negative_control_on_the_product_of_step_2s_end(self):
        rc, report = self.run_main("--transport", "create-ws", "--scenario", "a,q", "--negative-control", "3",
                                   step="2")
        self.assertEqual((0, {"a": "PASS", "q": "PASS"}), (rc, self.outcomes(report)), report["summary"])
        self.assertEqual({"required": [], "negative_control": True, "control_step": "3"}, report["evidence"])
        self.assertEqual("controls failed as expected", report["summary"]["controls"])
        controls = [c["name"] for s in report["scenarios"] if s["key"] == "q" for c in s["checks"]]
        self.assertEqual(3, len(controls), controls)  # G, H, and the execution that stays Running
        self.assertTrue(any(name.startswith("control q stays at status 1") for name in controls))
        self.assertTrue(report["final_check"]["name"].startswith("no row of this run's workflows"))

    def test_the_same_control_on_the_product_of_step_3_fails(self):
        rc, report = self.run_main("--transport", "create-ws", "--scenario", "a", "--negative-control", "3",
                                   step="3C")
        self.assertEqual(1, rc)
        self.assertEqual("a control did not fail as expected (or did not run)", report["summary"]["controls"])

    def test_a_run_without_a_step_3_gate_asks_step_2s_product_for_nothing_of_step_3(self):
        """j on step 2's product, as before step 3: it waits for no closing record, and the
        final check is the one on status 0."""
        rc, report = self.run_main("--transport", "create-ws", "--scenario", "j", "--evidence", "C,E,F", step="2")
        self.assertEqual((0, {"j": "PASS"}), (rc, self.outcomes(report)), report["summary"])
        self.assertFalse([r for r in self.fake.rest_log if r["path"].endswith(("/state", "/log"))])
        self.assertTrue(report["final_check"]["name"].startswith("no row of this run's workflows"))
        checks = report["scenarios"][0]["evidence"]["checks"]
        self.assertEqual(set("ABCDEF"), set(checks))  # A and B still looked at, and reported


if __name__ == "__main__":
    unittest.main()
