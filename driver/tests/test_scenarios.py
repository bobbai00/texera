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
from fake_texera import FakeTexera  # noqa: E402
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


class CreateWsScenarios(ScenarioCase):
    def test_j_modify_while_paused(self):
        rec = self.run_key("j")
        self.assertIn("another user's change is refused (403)", self.names(rec))
        self.assertIn("a change after the run completed is refused (409)", self.names(rec))

    def test_k_compile_error(self):
        rec = self.run_key("k")
        self.assertEqual(4, self.fake.executions[rec.eid]["status"])
        self.assertTrue(any("not checked without --evidence" in n for n in rec.notes))

    def test_l_refusals(self):
        for key in ("l1", "l2", "l3", "l4", "l7"):
            rec = self.run_key(key)
            self.assertTrue(any("no execution row was written" in n for n in self.names(rec)), key)
        for key in ("l5", "l6", "l9", "l10"):
            rec = self.run_key(key)
            self.assertTrue(any("the row stays 0" in n for n in self.names(rec)), key)
            self.assertFalse(self.fake.executions[rec.eid]["started"], key)
        rec = self.run_key("l8")
        self.assertEqual(3, self.fake.executions[rec.eid]["status"])

    def test_l_messages_follow_the_design(self):
        self.run_key("l6")
        self.run_key("l9")
        self.run_key("l10")
        refusals = [w for w in self.fake.ws_log if w["msg"]["type"] == "WorkflowStartRequest"]
        self.assertEqual(3, len(refusals))

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
        create = next(r for r in self.fake.rest_log if r["path"] == "/api/executions")
        self.assertEqual(1, len(create["body"]["targetOperatorIds"]))
        self.assertEqual(3, self.fake.executions[rec.eid]["status"])

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

    def test_create_ws_only_scenarios_refuse_ws(self):
        rec = run_scenario(self.ctx, "k")
        self.assertEqual("FAIL", rec.outcome)
        self.assertIn("needs --transport create-ws", rec.error)


if __name__ == "__main__":
    unittest.main()
