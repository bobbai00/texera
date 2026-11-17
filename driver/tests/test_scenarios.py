"""Offline runs of the step-2 scenarios (j, k, l1-l10, m, o, f, f2, g, h, i, g0)
through the real driver code (Ctx, scenarios.py, transport.py, texera_api.py)
against the fake Texera of tests/fake_texera.py, which follows the design's data
shapes. `docker exec <unit>` (curl for o, python3/ls/grep for the environment
scenarios) is answered by a fake too.

These prove the scenarios drive the design's protocol and judge its answers the
way the design says; they do not prove any branch implements it.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import scenarios  # noqa: E402
from fake_stack import FakeStack  # noqa: E402
from fake_texera import FAULTS, FakeTexera  # noqa: E402
from lake import Catalog, Lake  # noqa: E402
from scenarios import Ctx, OtherUser, run_scenario  # noqa: E402
from texera_api import TexeraApi  # noqa: E402
from transport import CreateStartTransport, WebSocketTransport  # noqa: E402

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
FILES = ["people.csv", "depts.csv", "numbers.csv"]
URI = "http://workflow-runtime-coordinator-service:8085"
VERSION_PATH = "/dataset/texera@texera.io/sce-e2e-x/v1"


class FakeUnitExec:
    """`docker exec <unit> ...` as the scenarios use it. The fake's installed
    environments live under ROOT, one directory per requirement set."""

    ROOT = "/tmp/texera-python-environments"

    def __init__(self, fake: FakeTexera, base: str):
        self.fake, self.base = fake, base
        self.calls: list[list[str]] = []

    def path_of(self, key: str) -> str:
        return f"{self.ROOT}/{hashlib.sha256(key.encode()).hexdigest()[:32]}"

    def __call__(self, *cmd: str, timeout: float = 120, stdin: str | None = None):
        cmd = list(cmd)
        self.calls.append(cmd)
        if cmd[:2] == ["python3", "-c"] and "texera-environment.json" in cmd[2]:
            assert cmd[3] == self.ROOT, cmd
            out = [{"name": self.path_of(k).rsplit("/", 1)[1], "path": self.path_of(k), "dir": True,
                    "marker": {"requirements": m["requirements"], "digest": "x"}}
                   for k, m in self.fake.installed_envs.items()]
            return subprocess.CompletedProcess(cmd, 0, json.dumps(out) + "\n")
        if cmd[:2] == ["python3", "-c"]:
            return subprocess.CompletedProcess(cmd, 1, "ModuleNotFoundError: No module named 'tabulate'")
        if cmd[:2] == ["sh", "-c"] and "UDF_PYTHON_ENVIRONMENTS_ROOT" in cmd[2]:
            return subprocess.CompletedProcess(cmd, 0, self.ROOT)
        if cmd[:2] == ["rm", "-rf"]:
            for k in [k for k in self.fake.installed_envs if self.path_of(k) == cmd[2]]:
                del self.fake.installed_envs[k]
            return subprocess.CompletedProcess(cmd, 0, "")
        if cmd[0] == "curl":
            url = next(c for c in cmd if c.startswith("http://localhost:8085"))
            auth = cmd[cmd.index("-H") + 1]
            r = requests.post(self.base + url.removeprefix("http://localhost:8085"), data=stdin,
                              headers={"Authorization": auth.split(": ", 1)[1],
                                       "Content-Type": "application/json"}, timeout=60)
            return subprocess.CompletedProcess(cmd, 0, f"{r.text}\n{r.status_code}")
        raise AssertionError(f"unexpected unit command {cmd}")


class ScenarioCase(unittest.TestCase):
    transport_name = "create-ws"
    replay_log = False
    #: the product the fake models, the step-3 timers it and the driver run on, and how
    #: far the driver takes the product to be (Ctx.level)
    step = "2"
    timing = None
    level = None

    def setUp(self):
        self._settle = scenarios.REFUSAL_SETTLE_S
        scenarios.REFUSAL_SETTLE_S = 0.5  # the fake answers at once
        self.addCleanup(setattr, scenarios, "REFUSAL_SETTLE_S", self._settle)
        self.fake = FakeTexera(warehouses=True, replay_log=self.replay_log, step=self.step, timing=self.timing)
        base = self.fake.start()
        api = TexeraApi(base)
        api.login("texera", "texera")
        whid, _ = api.ensure_warehouse("sce-e2e")
        cuid = int(api.create_local_unit("sce-e2e-unit", URI)["cuid"])
        other_api = api.ensure_user("sce-e2e-other", "sce-e2e-other@example.com", "pw")
        o_cuid = int(other_api.create_local_unit("sce-e2e-other-unit", URI)["cuid"])
        o_whid, _ = other_api.ensure_warehouse("sce-e2e-other-wh")
        unit2 = int(api.create_local_unit("sce-e2e-unit-2", URI)["cuid"])
        cls = CreateStartTransport if self.transport_name == "create-ws" else WebSocketTransport
        transport = cls(base, lambda: api.token, lambda: api.uid, api=api, log=lambda m: None)
        self.log: list[str] = []
        self.ctx = Ctx(api, transport, run_id="t", cuid=cuid, whid=whid,
                       paths={f: f"{VERSION_PATH}/{f}" for f in FILES}, data_dir=DATA_DIR, timeout=30,
                       log=self.log.append, transport_name=self.transport_name,
                       dataset={"version_path": VERSION_PATH}, warehouse_name=f"user-1-{whid}",
                       with_replay_log=self.replay_log,
                       other=OtherUser(other_api, o_cuid, o_whid, f"user-{other_api.uid}-{o_whid}"),
                       unit2_cuid=unit2, unit_uri=URI, timing=self.timing,
                       lake=Lake(Catalog(self.fake.lake.fetch)), level=self.level,
                       stack=FakeStack(self.fake, api))
        self.unit = FakeUnitExec(self.fake, base)
        self.ctx.unit_exec = self.unit

    def tearDown(self):
        self.fake.stop()

    def run_key(self, key: str):
        rec = run_scenario(self.ctx, key)
        failed = [(c.name, c.detail) for c in rec.checks if not c.ok]
        self.assertEqual("PASS", rec.outcome, f"{key}: failed {failed}; error {rec.error}")
        return rec

    def names(self, rec) -> list[str]:
        return [c.name for c in rec.checks]

    def failed_with(self, key: str, fault: str) -> list[str]:
        """Run `key` against the fake with `fault` turned on; the checks that failed."""
        self.assertIn(fault, FAULTS)
        self.fake.faults.add(fault)
        rec = run_scenario(self.ctx, key)
        self.assertEqual("FAIL", rec.outcome, f"{key} passed with {fault}")
        return [c.name for c in rec.checks if not c.ok]


class CreateWsScenarios(ScenarioCase):
    def test_j_modify_while_paused(self):
        rec = self.run_key("j")
        self.assertIn("another user's change is refused (403)", self.names(rec))
        self.assertIn("a change after the run completed is refused (409)", self.names(rec))

    def test_k_compile_error(self):
        rec = self.run_key("k")
        self.assertEqual(4, self.fake.executions[rec.eid]["status"])
        self.assertTrue(any("not checked without --evidence" in n for n in rec.notes))
        self.assertIn("the 400 says so as every refusal does, in {code, message}", self.names(rec))

    def test_l_refusals(self):
        for key in ("l1", "l2", "l3", "l4", "l7"):
            rec = self.run_key(key)
            self.assertTrue(any("no execution row was written" in n for n in self.names(rec)), key)
        for key in ("l5", "l6", "l9", "l10"):
            rec = self.run_key(key)
            self.assertTrue(any("the row stays 6" in n for n in self.names(rec)), key)  # Created
            self.assertFalse(self.fake.executions[rec.eid]["started"], key)
        rec = self.run_key("l8")
        self.assertEqual(3, self.fake.executions[rec.eid]["status"])

    def test_l_refusals_are_the_units_sentences(self):
        said = {}
        for key in ("l5", "l6", "l9", "l10", "l8"):
            rec = self.run_key(key)
            said[key] = next(n for n in self.names(rec) if "gets a RequestRefusedEvent of its start" in n)
        starts = [w["msg"] for w in self.fake.ws_log if w["msg"]["type"] == "WorkflowStartRequest"]
        self.assertEqual(6, len(starts))  # l8's first start ran
        first, second = starts[1]["executionId"], starts[1]["executionId"] + 1  # l6's two creates
        self.assertIn(f"\"The plan is execution {second}'s, not {first}'s.\"", said["l6"])
        self.assertIn(f"\"Execution {starts[2]['executionId']} was created for computing unit "
                      f"{self.ctx.cuid}, not {self.ctx.unit2_cuid}.\"", said["l9"])
        self.assertIn("\"The plan is in another user's warehouse.\"", said["l5"])
        self.assertIn("\"The plan is in another user's warehouse.\"", said["l10"])
        self.assertIn(f"\"Execution {starts[4]['executionId']} was already started.\"", said["l8"])

    def test_a_refusal_that_comes_as_a_runs_error_fails_the_refused_starts(self):
        """The unit of before step 2's review answered a refused start with a WorkflowErrorEvent."""
        for key, label in (("l5", "l5 another user's socket"), ("l8", "l8 second start")):
            failed = self.failed_with(key, "refusal-as-error-event")
            self.assertEqual([f"{label}: the starting socket gets a RequestRefusedEvent of its start",
                              f"{label}: ... and no WorkflowErrorEvent (a refusal is not a run's error)"],
                             [name.split(": \"")[0] for name in failed], key)

    def test_an_unstarted_execution_that_reads_initializing_fails_a_refused_start(self):
        """The Dashboard of before step 2's review created a row as Initializing (0)."""
        self.assertEqual([f"l9 socket of unit {self.ctx.unit2_cuid}: the row stays 6"],
                         self.failed_with("l9", "created-reads-initializing"))

    def test_m_refusals_without_replay_log(self):
        rec = self.run_key("m")
        self.assertTrue(any("--with-replay-log" in n for n in rec.notes))
        posts = [r for r in self.fake.rest_log if r["path"] == "/api/executions"]
        self.assertTrue(any((r["body"] or {}).get("replayFromExecution") for r in posts))

    def test_o_agent_sync_run(self):
        rec = self.run_key("o")
        curls = [c for c in self.unit.calls if c[0] == "curl"]
        self.assertEqual(2, len(curls))
        self.assertTrue(curls[0][-1] == "@-")
        # the create is the agent service's: the part of the workflow up to the Filter, cut by
        # the client; no operator named to cut at, and no workflow settings
        body = next(r for r in self.fake.rest_log if r["path"] == "/api/executions")["body"]
        self.assertEqual({"wid", "executionName", "engineVersion", "logicalPlan", "computingUnitId",
                          "emailNotificationEnabled", "warehouseId"}, set(body))
        self.assertEqual("agent", body["engineVersion"])
        plan = body["logicalPlan"]
        self.assertEqual(["CSVFileScan", "Filter"], [o["operatorType"] for o in plan["operators"]])
        self.assertEqual(1, len(plan["links"]))
        self.assertEqual([plan["operators"][1]["operatorID"]], plan["opsToViewResult"])
        # the run names its target to the unit, which answers that operator's result
        run = next(r for r in self.fake.rest_log if r["path"] == f"/api/execution/{rec.eid}/run")["body"]
        self.assertEqual(plan["opsToViewResult"], run["targetOperatorIds"])
        self.assertEqual(3, self.fake.executions[rec.eid]["status"])
        self.assertIn(f"a repeat of the call is refused: success false, \"Execution {rec.eid} was already "
                      f"started.\"", self.names(rec))

    def test_f_and_f2(self):
        self.run_key("f")
        self.run_key("f2")

    def test_g_h_i_environments(self):
        rec = self.run_key("g")
        starts = [w for w in self.fake.ws_log if w["msg"]["type"] == "WorkflowStartRequest"]
        self.assertEqual(2, len(starts))
        # run 2 on a workflow of its own: no replay of run 1's console can reach it
        self.assertEqual(2, len({w["wid"] for w in starts}))
        self.assertEqual(1, len(self.fake.installed_envs))
        self.assertFalse(any("removed an earlier install" in n for n in rec.notes))
        rec = self.run_key("h")
        self.assertIn("the run fails before it starts (never Running)", self.names(rec))
        self.assertTrue(any(n.startswith("no install directory is left") for n in self.names(rec)))
        self.run_key("i")

    def test_h_fails_when_a_failed_install_is_also_a_console_error(self):
        """The unit of before step 2's review wrote the failed install to the consoles too."""
        self.assertEqual(["the failure is the run's error only: no console holds an ERROR message of it"],
                         self.failed_with("h", "install-failure-on-console"))

    def test_g_removes_an_earlier_install_of_the_same_requirements(self):
        """A unit that ran g before (a --keep stack, a rerun) holds the install; g removes
        it so run 1 sees a fresh install, not "reused"."""
        self.fake.installed_envs["tabulate==0.9.0"] = {"requirements": ["tabulate==0.9.0"], "name": "old"}
        rec = self.run_key("g")
        self.assertTrue(any("removed an earlier install" in n for n in rec.notes), rec.notes)
        self.assertIn(["rm", "-rf", self.unit.path_of("tabulate==0.9.0")], self.unit.calls)

    def test_g_fails_when_run_1_reuses_an_install(self):
        """The check that matters: if the stale install were still there, run 1 would say
        'reused' and g must fail (here the removal is skipped)."""
        self.fake.installed_envs["tabulate==0.9.0"] = {"requirements": ["tabulate==0.9.0"], "name": "old"}
        real = self.unit

        def no_rm(*cmd, **kw):
            if list(cmd[:2]) == ["rm", "-rf"]:
                return subprocess.CompletedProcess(list(cmd), 0, "")
            return real(*cmd, **kw)
        self.ctx.unit_exec = no_rm
        rec = run_scenario(self.ctx, "g")
        self.assertEqual("FAIL", rec.outcome)
        failed = [c.name for c in rec.checks if not c.ok]
        self.assertIn("run 1: the UDF's console says Installing, then ready with tabulate==0.9.0", failed)

    def test_g0_legacy(self):
        rec = self.run_key("g0")
        self.assertTrue(any(r["path"] == "/api/pve/db" for r in self.fake.rest_log))


class PauseResumeKill(ScenarioCase):
    """d against the fake: a UDF that sleeps, as the fake engine sleeps it."""

    STALE_KILL = "a kill naming another execution"

    def setUp(self):
        super().setUp()
        self.fake.sleep_scale = 1.0  # d's bound on work done while paused counts real seconds per tuple
        self.addCleanup(setattr, scenarios, "PAUSE_HOLD_S", scenarios.PAUSE_HOLD_S)
        scenarios.PAUSE_HOLD_S = 0.5

    def test_d_names_its_execution_and_a_kill_of_another_is_refused(self):
        rec = self.run_key("d")
        self.assertTrue(any(n.startswith(self.STALE_KILL) for n in self.names(rec)))
        sent = [w["msg"] for w in self.fake.ws_log if w["msg"]["type"] != "WorkflowStartRequest"
                and w["msg"]["type"].startswith("Workflow")]
        self.assertEqual([("WorkflowKillRequest", rec.eid + 1_000_000), ("WorkflowPauseRequest", rec.eid),
                          ("WorkflowResumeRequest", rec.eid), ("WorkflowKillRequest", rec.eid)],
                         [(m["type"], m.get("executionId")) for m in sent])
        self.assertEqual(5, self.fake.executions[rec.eid]["status"])

    def test_d_fails_when_a_kill_of_another_execution_reaches_the_run(self):
        """The unit of before step 2's review took a pause or a kill for the run it held."""
        failed = self.failed_with("d", "stale-control")
        self.assertTrue(failed and failed[0].startswith(self.STALE_KILL), failed)


class ReplayScenario(ScenarioCase):
    replay_log = True

    def test_m_replay_run(self):
        rec = self.run_key("m")
        self.assertIn("m replay create answers 201", self.names(rec))
        self.assertTrue(any("does not exist" in n for n in rec.notes))


class WsScenarios(ScenarioCase):
    transport_name = "ws"

    def test_j_on_ws_uses_modify_logic_request(self):
        rec = self.run_key("j")
        self.assertTrue(any(w["msg"]["type"] == "ModifyLogicRequest" for w in self.fake.ws_log))
        self.assertTrue(any("checked on create-ws only" in n for n in rec.notes))
        # the old unit takes the old frames, which name no execution
        self.assertEqual([{"type": "WorkflowPauseRequest"}, {"type": "WorkflowResumeRequest"}],
                         [w["msg"] for w in self.fake.ws_log if w["msg"]["type"].startswith(("WorkflowPause",
                                                                                              "WorkflowResume"))])

    def test_create_ws_only_scenarios_refuse_ws(self):
        rec = run_scenario(self.ctx, "k")
        self.assertEqual("FAIL", rec.outcome)
        self.assertIn("needs --transport create-ws", rec.error)


if __name__ == "__main__":
    unittest.main()
