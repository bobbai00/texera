"""Offline tests of run-negative-control.sh with a stand-in stack and driver: what each
step's control asks of them, in what order, and what the script's exit code says. No
stack is started; the controls themselves are run on a real one.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[2]

#: logs what it was asked; `up --expect-unit-down` prints a verdict and exits as it is told
FAKE_STACK = r"""#!/usr/bin/env bash
echo "stack $*" >> "$(dirname "$0")/../calls.log"
case " $* " in
    *" --expect-unit-down "*)
        echo "[sce-stack] waiting for 12 service(s)"
        echo "{\"ok\": $([[ "${FAKE_UNIT_RC:-0}" == 0 ]] && echo true || echo false), \"verdict\": \"told\"}"
        exit "${FAKE_UNIT_RC:-0}" ;;
    *" up "*) exit "${FAKE_UP_RC:-0}" ;;
esac
exit 0
"""
#: logs what it was asked; --print-token prints one; a run exits as it is told
FAKE_DRIVER = r"""#!/usr/bin/env bash
echo "driver $*" >> "$(dirname "$0")/../calls.log"
if [[ "$1" == "--print-token" ]]; then echo "head.claims.signature"; exit 0; fi
exit "${FAKE_DRIVER_RC:-0}"
"""


class NegativeControlScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        for rel, text in (("run-negative-control.sh", (HARNESS / "run-negative-control.sh").read_text()),
                          ("stack/sce-stack.sh", FAKE_STACK), ("driver/run.sh", FAKE_DRIVER)):
            (self.home / rel).parent.mkdir(exist_ok=True)
            (self.home / rel).write_text(text)
            (self.home / rel).chmod(0o755)

    def run_it(self, *args: str, **env: str) -> tuple[int, str, list[str]]:
        p = subprocess.run([str(self.home / "run-negative-control.sh"), *args], stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True, timeout=60, env=dict(os.environ, **env))
        log = self.home / "calls.log"
        return p.returncode, p.stdout, log.read_text().splitlines() if log.exists() else []

    def test_step_2_is_what_it_was(self):
        rc, out, calls = self.run_it()
        self.assertEqual(0, rc, out)
        options = "--images ghcr.io/apache/latest --pg-statement-log --isolate-unit"
        self.assertEqual([f"stack up {options}", "driver --print-token",
                          f"stack up {options} --unit-env USER_JWT_TOKEN=head.claims.signature", "stack status"],
                         calls[:4])
        self.assertTrue(calls[4].startswith("driver --transport ws --scenario a --negative-control --report "),
                        calls[4])
        self.assertEqual(["stack down"], calls[5:])

    def test_step_3_runs_a_and_q_then_the_unit_without_postgres(self):
        rc, out, calls = self.run_it("--step", "3", "--images", "sce/step2d", "--source", "/w/src")
        self.assertEqual(0, rc, out)
        options = "--images sce/step2d --pg-statement-log --isolate-unit --fast-record"
        self.assertEqual([f"stack --source /w/src up {options}", "stack status"], calls[:2])
        self.assertTrue(calls[2].startswith("driver --transport create-ws --scenario a,q --negative-control 3 "),
                        calls[2])
        self.assertEqual(["stack down", f"stack --source /w/src up {options} --unit-no-postgres --expect-unit-down",
                          "stack down"], calls[3:])
        (verdict,) = (self.home / "reports").glob("negative-control-*-unit.json")
        self.assertEqual({"ok": True, "verdict": "told"}, json.loads(verdict.read_text()))  # the last line only

    def test_step_3_fails_when_the_unit_came_up_without_postgres(self):
        rc, out, calls = self.run_it("--step", "3", "--images", "sce/step2d", FAKE_UNIT_RC="1")
        self.assertEqual(1, rc, out)
        self.assertEqual("stack down", calls[-1])

    def test_step_3_keeps_the_drivers_verdict_and_still_asks_the_unit(self):
        rc, out, calls = self.run_it("--step", "3", "--images", "sce/step2d", FAKE_DRIVER_RC="2")
        self.assertEqual(2, rc, out)
        self.assertTrue(any("--expect-unit-down" in c for c in calls))

    def test_step_3_needs_the_images_of_step_2s_end(self):
        rc, out, calls = self.run_it("--step", "3")
        self.assertEqual((64, []), (rc, calls))
        self.assertIn("pass --images <registry>/<tag>", out)
        rc, out, calls = self.run_it("--step", "4")
        self.assertEqual((64, []), (rc, calls))

    def test_a_stack_that_does_not_come_up_is_exit_3(self):
        rc, out, calls = self.run_it("--step", "3", "--images", "sce/step2d", FAKE_UP_RC="1")
        self.assertEqual(3, rc, out)
        self.assertEqual("stack down", calls[-1])
        self.assertFalse(any(c.startswith("driver") for c in calls))


if __name__ == "__main__":
    unittest.main()
