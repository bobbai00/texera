"""Offline: scenarios and their evidence together, the way e2e.py runs them
(begin_scenario, run_scenario, _apply_evidence). The fake Texera reports the
Postgres statements the design's services would run and the requests a gateway
would log; a fake `docker` serves them as the Postgres, unit and nginx logs, and
answers the catalog (Check E) and the final check (the rows left at status 0, or
from gate 3B on the closing records of Check K) from the fake's executions.

The review's case: l8 opens a second socket on a completed run, and the unit
replays that run (state Completed, its console) to it about 0.1 s after the
handshake, before the refused start. With the old open_socket (it returned at the
first state) and the old has_started (any state but Uninitialized), Check A failed
on every correct unit ("no unit status UPDATE to 1/4/5"). Here l8 passes all six
checks and the silence check of its refused start.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e  # noqa: E402
import evidence as ev  # noqa: E402
from scenarios import run_scenario  # noqa: E402
from test_evidence import DASH_IP, HOST_GATEWAY, UNIT_IP, FakeDocker  # noqa: E402
from test_scenarios import ScenarioCase  # noqa: E402


class StackDocker(FakeDocker):
    """FakeDocker fed by the fake Texera: its statements, its requests, its plans."""

    def __init__(self, fake):
        super().__init__(isolated=True, cleanup="1")
        self.fake = fake

    def statement(self, who: str, sql: str, params: str | None) -> None:
        if who == "unit":
            self.execute(ev.UNIT_APP, UNIT_IP, sql, params, pid=300)
        else:
            self.execute(ev.DASHBOARD_APP, DASH_IP, sql, params, pid=400)

    def access(self, method: str, path: str, status: int) -> None:
        self.gateway_line(HOST_GATEWAY, method, path, status)

    def _call(self, args):
        if args[0] == "exec" and "curl" in args and "/tables/" in args[-1]:
            m = re.search(r"/tables/wid_(\d+)_eid_(\d+)_plan$", args[-1])
            e = self.fake.executions.get(int(m.group(2))) if m else None
            if e and e.get("plan_uri"):
                refs = {"main": {"snapshot-id": 1, "type": "branch"}}
                if e.get("started"):
                    refs["started"] = {"snapshot-id": 1, "type": "tag"}
                return subprocess.CompletedProcess(args, 0, json.dumps({"metadata": {"refs": refs}}) + "\n200", "")
        if args[0] == "exec" and "psql" in args and "status = 0" in args[-1]:
            wids = {int(w) for w in re.search(r"IN \(([^)]*)\)", args[-1]).group(1).split(",")}
            rows = [f"{eid}|{x['wid']}" for eid, x in sorted(self.fake.executions.items())
                    if x["status"] == 0 and x["wid"] in wids]
            return subprocess.CompletedProcess(args, 0, "\n".join(rows) + "\n", "")
        if args[0] == "exec" and "psql" in args and "ended_at IS NOT NULL" in args[-1]:  # Check K
            wids = {int(w) for w in re.search(r"IN \(([^)]*)\)", args[-1]).group(1).split(",")}
            rows = [f"{eid}|{x['wid']}|{'' if x['outcome'] is None else x['outcome']}|"
                    f"{int(x['ended_at'] is not None)}|{x['outcome_reason'] or ''}"
                    for eid, x in sorted(self.fake.executions.items()) if x["wid"] in wids]
            return subprocess.CompletedProcess(args, 0, "\n".join(rows) + "\n", "")
        return super()._call(args)


class EvidenceCase(ScenarioCase):
    """A scenario case whose scenarios run with evidence, as e2e.py runs them."""

    #: the fake `docker` of the stack, and what the evidence is asked for beyond its defaults
    docker_class = StackDocker
    evidence_options: dict = {}
    #: the negative control the scenarios run under: none, or the step it is of ("2", "3")
    negative: str | None = None

    def setUp(self):
        super().setUp()
        quiet = e2e.log
        e2e.log = lambda m: None
        self.addCleanup(setattr, e2e, "log", quiet)
        self.docker = self.docker_class(self.fake)
        self.fake.statement_sink = self.docker.statement
        self.fake.access_sink = self.docker.access
        self.fake.cleanup_s = 0.3
        self.messages: list[str] = []
        self.ev = ev.Evidence(run_id="t", runner=self.docker, log=self.messages.append,
                              cleanup_wait_s=8.0, quiet_s=0.4, **self.evidence_kwargs())
        self.ev.preflight()
        self.ctx.evidence = self.ev
        self.ctx.transport.phase_hook = self.ev.on_phase

    def evidence_kwargs(self) -> dict:
        return dict(self.evidence_options)

    def run_ev(self, key: str, expect: str = "PASS"):
        waited = self.ev.begin_scenario(key)
        rec = run_scenario(self.ctx, key)
        e2e._apply_evidence(self.ev, rec, waited, self.ctx.api, self.negative)
        failed = [(c.name, c.detail[:300]) for c in rec.checks if not c.ok]
        self.assertEqual(expect, rec.outcome, f"{key}: failed {failed}; error {rec.error}")
        return rec

    def gated(self, rec) -> set[str]:
        return {c.name.split(":")[0].removeprefix("evidence ") for c in rec.checks if c.name.startswith("evidence ")}


class ScenarioEvidence(EvidenceCase):
    def test_l8_second_start_on_a_replayed_run(self):
        rec = self.run_ev("l8")
        self.assertEqual(set("ABCDEF"), self.gated(rec))
        self.assertTrue(any(c.name.startswith("the unit ran no statement from the refused start") and c.ok
                            for c in rec.checks))
        runs = rec.evidence["runs"]
        self.assertEqual([True, False], [r["started"] for r in runs])
        # the second socket got the held run while it opened, and nothing of it after
        opened = rec.run["opened"]
        self.assertEqual("ClusterStatusUpdateEvent", opened["closed_by"])
        self.assertEqual(["Uninitialized", "Completed"], opened["states"])
        self.assertEqual([], rec.run["states"])
        win = rec.evidence["windows"][0]
        self.assertTrue(win["start_window_unit_statements"])

    def test_refused_starts_and_the_cleanup_between_scenarios(self):
        l8 = self.run_ev("l8")
        first_eid = l8.evidence["runs"][0]["eid"]
        rec = self.run_ev("l5")
        self.assertIsInstance(rec.evidence["cleanup_wait"]["cleanup_deletes"][str(first_eid)], float)
        self.assertTrue(rec.evidence["cleanup_wait"]["quiet"])
        # every statement of l8's cleanup precedes l5's begin mark
        self.ev.refresh_log()
        begin = next(s for s, m in self.ev.pg.marks() if m["scenario"] == "l5" and m["phase"] == "begin")
        cleanup = [s for s in self.ev.pg.stmts if s.relevant and s.refers_to_eid(first_eid)
                   and (s.verb == "delete" or "runtime_stats_uri" in s.norm)]
        self.assertEqual(3, len(cleanup))
        self.assertTrue(all(s.seq < begin.seq for s in cleanup))
        for key in ("l6", "l9", "l10"):
            rec = self.run_ev(key)
            self.assertTrue(any(c.name.startswith("the unit ran no statement from the refused start")
                                for c in rec.checks), key)
        final = self.ev.final_check(self.ctx.created_wids)
        self.assertTrue(final["ok"], final)
        self.assertTrue(final["left"])  # the refused starts' rows, allowed

    def test_o_repeat_call_is_silent(self):
        rec = self.run_ev("o")
        self.assertTrue(any("unit settled before the repeated call" in n for n in rec.notes), rec.notes)
        self.assertEqual([True, False], [r["started"] for r in rec.evidence["runs"]])
        self.assertTrue(rec.evidence["unit_silent_after_refused_start"][0]["ok"])

    def test_a_unit_that_reads_while_refusing_fails_the_silence_check(self):
        real = self.fake.start_checks

        def reading(user, eid, plan_uri, wid, cuid):
            # a refusal path that reads Postgres without naming the eid (the review's gap)
            self.fake.sql("unit", "select user_warehouse.whid from user_warehouse where user_warehouse.uid = $1",
                          f"$1 = '{user['uid']}'")
            return real(user, eid, plan_uri, wid, cuid)
        self.fake.start_checks = reading
        rec = self.run_ev("l5", expect="FAIL")
        failed = [c for c in rec.checks if not c.ok]
        self.assertEqual(1, len(failed), [c.name for c in failed])
        self.assertTrue(failed[0].name.startswith("the unit ran no statement from the refused start"))
        self.assertIn("user_warehouse", failed[0].detail)

    def test_the_old_has_started_rule_would_have_failed_l8(self):
        """Pins the review's diagnosis: counting the replayed state as a start puts the
        refused start into Check A and fails it."""
        original = ev.RunRecord.has_started

        def old_rule(run):
            if run.started is not None:
                return run.started
            if run.handle is None or run.start_mark is None:
                return False
            return any(s != "Uninitialized" for s in list(run.handle.replayed.get("states") or [])
                       + list(run.handle.states))
        ev.RunRecord.has_started = old_rule
        try:
            rec = self.run_ev("l8", expect="FAIL")
        finally:
            ev.RunRecord.has_started = original
        a = next(c for c in rec.checks if c.name.startswith("evidence A:"))
        self.assertFalse(a.ok)
        self.assertIn("no unit status UPDATE to 1/4/5", a.detail)


if __name__ == "__main__":
    unittest.main()
