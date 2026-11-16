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

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_texera import FakeTexera  # noqa: E402
from scenarios import Ctx, OtherUser, run_scenario  # noqa: E402
from texera_api import TexeraApi  # noqa: E402
from transport import CreateStartTransport, WebSocketTransport  # noqa: E402

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
FILES = ["people.csv", "depts.csv", "numbers.csv"]
URI = "http://workflow-runtime-coordinator-service:8085"
VERSION_PATH = "/dataset/texera@texera.io/sce-e2e-x/v1"


class FakeUnitExec:
    """`docker exec <unit> ...` as the scenarios use it."""

    def __init__(self, fake: FakeTexera, base: str):
        self.fake, self.base = fake, base
        self.calls: list[list[str]] = []

    def __call__(self, *cmd: str, timeout: float = 120, stdin: str | None = None):
        cmd = list(cmd)
        self.calls.append(cmd)
        if cmd[:2] == ["python3", "-c"]:
            return subprocess.CompletedProcess(cmd, 1, "ModuleNotFoundError: No module named 'tabulate'")
        if cmd[0] == "curl":
            url = next(c for c in cmd if c.startswith("http://localhost:8085"))
            auth = cmd[cmd.index("-H") + 1]
            r = requests.post(self.base + url.removeprefix("http://localhost:8085"), data=stdin,
                              headers={"Authorization": auth.split(": ", 1)[1],
                                       "Content-Type": "application/json"}, timeout=60)
            return subprocess.CompletedProcess(cmd, 0, f"{r.text}\n{r.status_code}")
        if cmd[:2] == ["sh", "-c"] and "texera-environment.json" in cmd[2]:
            out = "".join(f"== /tmp/texera-python-environments/{i:032x}/texera-environment.json\n"
                          f"{json.dumps(m)}\n" for i, m in enumerate(self.fake.installed_envs.values()))
            return subprocess.CompletedProcess(cmd, 0, out)
        if cmd[:2] == ["sh", "-c"] and "grep -l" in cmd[2]:
            return subprocess.CompletedProcess(cmd, 0, "")
        raise AssertionError(f"unexpected unit command {cmd}")


class ScenarioCase(unittest.TestCase):
    transport_name = "create-ws"
    replay_log = False

    def setUp(self):
        self.fake = FakeTexera(warehouses=True, replay_log=self.replay_log)
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
                       unit2_cuid=unit2, unit_uri=URI)
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
        self.assertEqual(2, len([w for w in self.fake.ws_log if w["msg"]["type"] == "WorkflowStartRequest"]))
        self.assertEqual(1, len(self.fake.installed_envs))
        self.run_key("h")
        self.run_key("i")

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
