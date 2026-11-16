"""Offline tests of driver/evidence.py: a fake `docker` serves a synthetic Postgres
log (docker timestamps, the --pg-statement-log prefix, extended-protocol DETAIL
lines of interleaved pids, continuation lines) and answers psql marks, inspect,
getent, the unit's log and the Lakekeeper catalog.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import evidence as ev  # noqa: E402

UNIT_IP = "172.30.0.7"
DASH_IP = "172.30.0.9"


class FakeDocker:
    """Just enough of `docker` for Evidence."""

    def __init__(self, isolated: bool = True, cleanup: str = "2"):
        self.t = 1_700_000_000_000_000_000  # ns
        self.pg: list[tuple[int, str]] = []
        self.unit: list[tuple[int, str]] = []
        self.isolated = isolated
        self.cleanup = cleanup
        self.tables: dict[str, dict] = {}  # "wid_1_eid_2_plan" -> refs
        self.getent = ""
        self.pid = 500

    def _ts(self) -> tuple[int, str]:
        self.t += 1_000_000  # 1 ms
        sec, ns = divmod(self.t, 1_000_000_000)
        import time
        base = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(sec))
        frac = f"{ns:09d}".rstrip("0") or "0"
        return self.t, f"{base}.{frac}Z"

    def pg_line(self, pid: int, app: str, host: str, level: str, msg: str, db: str = "texera_db") -> None:
        t, _ = self._ts()
        self.pg.append((t, f"2026-11-16 10:00:00.000 UTC [{pid}] app={app} db={db} host={host} {level}:  {msg}"))

    def pg_raw(self, line: str) -> None:
        t, _ = self._ts()
        self.pg.append((t, line))

    def unit_line(self, text: str) -> None:
        t, _ = self._ts()
        self.unit.append((t, text))

    # statements as pgjdbc sends them
    def execute(self, app: str, host: str, sql: str, params: str | None = None, pid: int | None = None) -> None:
        pid = pid or 100
        self.pg_line(pid, app, host, "LOG", f"execute <unnamed>: {sql}")
        if params is not None:
            self.pg_line(pid, app, host, "DETAIL", f"parameters: {params}")

    def __call__(self, args, timeout=60):
        args = list(args)
        out, rc = "", 0
        if args[0] == "exec" and "psql" in args:
            sql = args[-1]
            if sql.startswith("SELECT 'sce-mark"):
                self.pg_line(999, "psql", "[local]", "LOG", f"statement: {sql}")
                out = sql.split("'")[1]
            elif "status = 0" in sql:
                out = ""
        elif args[0] == "logs":
            container = args[-1]
            lines = self.pg if container == "sce-texera-postgres" else self.unit
            since = None
            if "--since" in args:
                since = ev.docker_ts_ns(args[args.index("--since") + 1])
            rendered = []
            for t, line in lines:
                if since is not None and t < since:
                    continue
                sec, ns = divmod(t, 1_000_000_000)
                import time
                base = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(sec))
                frac = f"{ns:09d}".rstrip("0") or "0"
                rendered.append(f"{base}.{frac}Z {line}")
            out = "\n".join(rendered) + ("\n" if rendered else "")
        elif args[0] == "inspect":
            nets = ({"sce-unit-net": {"IPAddress": UNIT_IP}} if self.isolated
                    else {"sce-net": {"IPAddress": UNIT_IP}})
            env = [f"WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS={self.cleanup}"]
            out = json.dumps(nets) + "|" + json.dumps(env)
        elif args[0] == "exec" and "getent" in args:
            out, rc = self.getent, (0 if self.getent else 2)
        elif args[0] == "exec" and "curl" in args:
            url = args[-1]
            if "/v1/config" in url:
                out = json.dumps({"overrides": {"prefix": "wh-uuid"}, "defaults": {}}) + "\n200"
            else:
                name = url.rsplit("/", 1)[-1]
                if name in self.tables:
                    out = json.dumps({"metadata": {"refs": self.tables[name]}}) + "\n200"
                elif url.endswith("/namespaces"):
                    out = json.dumps({"namespaces": [["operator-port-result"]]}) + "\n200"
                else:
                    out = json.dumps({"error": {"message": "Table does not exist"}}) + "\n404"
        return subprocess.CompletedProcess(args, rc, out, "")


class Handle:
    def __init__(self, states):
        self.states = states


def make(fake: FakeDocker, **kw) -> ev.Evidence:
    e = ev.Evidence(run_id="t", runner=fake, log=lambda m: None, cleanup_wait_s=0.5, **kw)
    e.preflight()
    return e


class ParsingTest(unittest.TestCase):
    def test_params_continuations_and_interleaving(self):
        log = ev.PgLog()
        log.feed([
            "2026-11-16 10:00:00.001 UTC [10] app=texera-computing-unit db=texera_db host=1.2.3.4 LOG:  "
            "execute S_1: update \"texera_db\".\"workflow_executions\" set \"status\" = $1, "
            "\"last_update_time\" = $2 where \"texera_db\".\"workflow_executions\".\"eid\" = $3",
            "2026-11-16 10:00:00.002 UTC [11] app=texera-dashboard db=texera_db host=5.6.7.8 LOG:  "
            "execute <unnamed>: select 1",
            "2026-11-16 10:00:00.003 UTC [10] app=texera-computing-unit db=texera_db host=1.2.3.4 DETAIL:  "
            "parameters: $1 = '1', $2 = '2026-11-16 10:00:00+00', $3 = '345'",
            "2026-11-16 10:00:00.004 UTC [12] app=PostgreSQL JDBC Driver db=texera_db host=1.2.3.4 LOG:  "
            "execute <unnamed>: insert into operator_executions (workflow_execution_id, operator_id)",
            "\tvalues ($1, $2)",
            "2026-11-16 10:00:00.005 UTC [12] app=PostgreSQL JDBC Driver db=texera_db host=1.2.3.4 DETAIL:  "
            "parameters: $1 = '345', $2 = 'it''s'",
            "2026-11-16 10:00:00.006 UTC [13] app= db= host= LOG:  checkpoint starting: time",
        ])
        log.finalize()
        self.assertEqual(3, len(log.stmts))
        upd, sel, ins = log.stmts
        self.assertEqual((1, 345), upd.status_update())
        self.assertEqual(frozenset({"workflow_executions"}), upd.tables)
        self.assertEqual("texera-dashboard", sel.app)
        self.assertEqual("PostgreSQL JDBC Driver", ins.app)
        self.assertIn("values ($1, $2)", ins.sql)
        self.assertEqual({1: "345", 2: "it's"}, ins.params)
        self.assertTrue(ins.refers_to_eid(345))
        self.assertFalse(ins.refers_to_eid(346))
        self.assertTrue(upd.refers_to_eid(345))

    def test_tables_and_verbs(self):
        st = ev.Stmt(0, "", 1, "a", "texera_db", "h", "execute",
                     'select "texera_db"."dataset"."did" from "texera_db"."dataset" join '
                     '"texera_db"."dataset_version" on x = y where a = $1')
        self.assertEqual("select", st.verb)
        self.assertEqual(frozenset({"dataset", "dataset_version"}), st.tables)
        up = ev.Stmt(0, "", 1, "a", "texera_db", "h", "execute",
                     "insert into t (a) values ($1) on conflict (a) do update set a = $1")
        self.assertEqual(frozenset({"t"}), up.tables)
        mark = ev.Stmt(0, "", 1, "psql", "texera_db", "[local]", "statement",
                       "SELECT 'sce-mark:a:start:12:r-3'")
        self.assertEqual({"scenario": "a", "phase": "start", "eid": "12", "id": "r-3"}, mark.mark)
        self.assertFalse(mark.relevant)
        empty = ev.Stmt(0, "", 1, "a", "texera_db", "h", "execute", "")
        self.assertFalse(empty.relevant)
        begin = ev.Stmt(0, "", 1, "a", "texera_db", "h", "statement", "BEGIN")
        self.assertFalse(begin.relevant)

    def test_failed_statement_folds_into_execute(self):
        log = ev.PgLog()
        log.feed([
            "2026-11-16 10:00:00.001 UTC [10] app=x db=texera_db host=h LOG:  execute <unnamed>: select * from nope",
            "2026-11-16 10:00:00.002 UTC [10] app=x db=texera_db host=h ERROR:  relation \"nope\" does not exist",
            "2026-11-16 10:00:00.003 UTC [10] app=x db=texera_db host=h STATEMENT:  select * from nope",
            "2026-11-16 10:00:00.004 UTC [11] app=x db=texera_db host=h ERROR:  syntax error",
            "2026-11-16 10:00:00.005 UTC [11] app=x db=texera_db host=h STATEMENT:  selec 1",
        ])
        log.finalize()
        relevant = [s for s in log.stmts if s.relevant]
        self.assertEqual(["select * from nope", "selec 1"], [s.sql for s in relevant])
        self.assertIn("does not exist", relevant[0].error)


class ContainerLogTest(unittest.TestCase):
    def test_incremental_reads_nothing_twice(self):
        fake = FakeDocker()
        fake.unit_line("one")
        fake.unit_line("two")
        cl = ev.ContainerLog("sce-workflow-runtime-coordinator-service", fake)
        self.assertEqual(["one", "two"], cl.poll())
        self.assertEqual([], cl.poll())
        fake.unit_line("three")
        self.assertEqual(["three"], cl.poll())
        cur = cl.cursor()
        fake.unit_line("four")
        self.assertEqual(["four"], cl.since(cur))


class ChecksTest(unittest.TestCase):
    def _old_unit_run(self, fake: FakeDocker, e: ev.Evidence, eid: int, app: str) -> None:
        """What the published unit does: insert, read, then a SELECT-then-UPDATE per state."""
        e.on_phase("create", {"wid": 1, "cuid": 1})
        e.on_phase("start", {"wid": 1, "cuid": 1, "handle": Handle(["Uninitialized", "Initializing",
                                                                     "Running", "Completed"])})
        fake.execute(app, UNIT_IP, "insert into workflow_executions (vid, uid, status) values ($1, $2, $3)",
                     "$1 = '1', $2 = '1', $3 = '1'")
        fake.execute(app, UNIT_IP, "select * from dataset where name = $1", "$1 = 'x'")
        fake.unit_line("WARN presign via http://file-service:9092/api/dataset/presign-download failed")
        fake.execute(app, UNIT_IP, "select * from workflow_executions where eid = $1", f"$1 = '{eid}'")
        fake.execute(app, UNIT_IP, 'update workflow_executions set eid = $1, status = $2 where '
                                   'workflow_executions.eid = $3', f"$1 = '{eid}', $2 = '1', $3 = '{eid}'")
        fake.execute(app, UNIT_IP, "select * from site_settings", None)
        fake.execute(app, UNIT_IP, 'update workflow_executions set status = $1 where workflow_executions.eid = $2',
                     f"$1 = '3', $2 = '{eid}'")

    def test_old_unit_fails_a_b_c_d_f(self):
        fake = FakeDocker(isolated=True)
        e = make(fake)
        e.begin_scenario("a")
        self._old_unit_run(fake, e, 77, "PostgreSQL JDBC Driver")
        out = e.end_scenario(resolve_eid=lambda run: 77)
        r = out["checks"]
        self.assertFalse(r["A"].ok, r["A"].detail)
        self.assertFalse(r["B"].ok, r["B"].detail)
        self.assertIn("dataset", r["B"].detail)
        self.assertFalse(r["C"].ok, r["C"].detail)
        self.assertFalse(r["D"].ok, r["D"].detail)
        self.assertIn("file-service", r["D"].detail)
        self.assertFalse(r["E"].ok)
        self.assertFalse(r["F"].ok, r["F"].detail)
        gates, info = ev.evaluate(r, [], negative_control=True)
        self.assertEqual(3, len(gates))
        self.assertTrue(all(ok for _, ok, _ in gates), gates)
        gates, _ = ev.evaluate(r, ["A", "F"], negative_control=False)
        self.assertEqual([False, False], [ok for _, ok, _ in gates])

    def test_named_but_reading_unit_passes_f_fails_a(self):
        fake = FakeDocker(isolated=False)
        e = make(fake)
        e.begin_scenario("a")
        self._old_unit_run(fake, e, 78, ev.UNIT_APP)
        r = e.end_scenario(resolve_eid=lambda run: 78)["checks"]
        self.assertTrue(r["F"].ok, r["F"].detail)
        self.assertFalse(r["A"].ok)
        self.assertIsNone(r["D"].ok)  # not isolated: not evaluable
        gates, _ = ev.evaluate(r, ["D"], negative_control=False)
        self.assertEqual([False], [ok for _, ok, _ in gates])

    def test_new_path_passes_everything(self):
        fake = FakeDocker(isolated=True)
        fake.tables["wid_5_eid_90_plan"] = {"main": {"snapshot-id": 1}, "started": {"snapshot-id": 1, "type": "tag"}}
        e = make(fake)
        e.begin_scenario("a")
        e.on_phase("create", {"wid": 5, "cuid": 1})
        fake.execute(ev.DASHBOARD_APP, DASH_IP, "insert into workflow_executions (vid, uid, status) values ($1, $2, $3)",
                     "$1 = '1', $2 = '1', $3 = '0'")
        fake.execute(ev.DASHBOARD_APP, DASH_IP, "select * from dataset where name = $1", "$1 = 'x'")
        e.on_phase("created", {"eid": 90, "plan_uri": "vfs:///wh/user-1-7/wid/5/eid/90/plan", "wid": 5})
        e.on_phase("start", {"wid": 5, "cuid": 1, "eid": 90, "plan_uri": "vfs:///wh/user-1-7/wid/5/eid/90/plan",
                             "handle": Handle(["Uninitialized", "Initializing", "Running", "Completed"])})
        fake.execute(ev.UNIT_APP, UNIT_IP, 'update workflow_executions set status = $1, last_update_time = $2 '
                                           'where workflow_executions.eid = $3', "$1 = '0', $2 = 'now', $3 = '90'")
        fake.execute(ev.UNIT_APP, UNIT_IP, "insert into operator_executions (workflow_execution_id, operator_id) "
                                           "values ($1, $2)", "$1 = '90', $2 = 'op'")
        fake.execute(ev.UNIT_APP, UNIT_IP, 'update workflow_executions set status = $1, last_update_time = $2 '
                                           'where workflow_executions.eid = $3', "$1 = '1', $2 = 'now', $3 = '90'")
        # after RUNNING the result service may read the run-state tables (B allows it, A is over)
        fake.execute(ev.UNIT_APP, UNIT_IP, "select * from operator_port_executions where workflow_execution_id = $1",
                     "$1 = '90'")
        fake.execute(ev.UNIT_APP, UNIT_IP, 'update workflow_executions set status = $1, last_update_time = $2 '
                                           'where workflow_executions.eid = $3', "$1 = '3', $2 = 'now', $3 = '90'")
        out = e.end_scenario()
        r = out["checks"]
        for key in ev.CHECKS:
            self.assertTrue(r[key].ok, f"{key}: {r[key].detail}")
        win = out["report"]["windows"][0]
        # READY, the operator row and the closing RUNNING update
        self.assertEqual(3, len(win["start_window_unit_statements"]))
        gates, _ = ev.evaluate(r, ev.CHECKS, negative_control=False)
        self.assertTrue(all(ok for _, ok, _ in gates))
        gates, _ = ev.evaluate(r, [], negative_control=True)
        self.assertFalse(any(ok for _, ok, _ in gates))  # controls that pass prove nothing

    def test_refused_start_and_no_statement_expectation(self):
        fake = FakeDocker(isolated=True)
        e = make(fake)
        e.begin_scenario("l5")
        e.on_phase("create", {"wid": 6, "cuid": 1})
        fake.execute(ev.DASHBOARD_APP, DASH_IP, "insert into workflow_executions (status) values ($1)", "$1 = '0'")
        e.on_phase("created", {"eid": 91, "plan_uri": "vfs:///wid/6/eid/91/plan", "wid": 6})
        e.on_phase("start", {"wid": 6, "cuid": 1, "eid": 91, "handle": Handle(["Uninitialized"])})
        e.expect_no_unit_statement(91, "refused")
        e.expect_no_unit_statement(92, "another")
        fake.execute(ev.UNIT_APP, UNIT_IP, "delete from operator_executions where workflow_execution_id = $1",
                     "$1 = '92'")
        out = e.end_scenario()
        r = out["checks"]
        self.assertTrue(r["A"].ok and r["A"].data.get("vacuous"))
        self.assertTrue(r["C"].ok)
        exp = {x["eid"]: x["ok"] for x in out["report"]["no_unit_statement_for"]}
        self.assertEqual({91: True, 92: False}, exp)

    def test_cleanup_wait_sees_the_delete(self):
        fake = FakeDocker(isolated=True)
        e = make(fake)
        e.begin_scenario("a")
        e.on_phase("create", {"wid": 5, "cuid": 1})
        e.on_phase("created", {"eid": 93, "plan_uri": None, "wid": 5})
        e.on_phase("start", {"wid": 5, "cuid": 1, "eid": 93, "handle": Handle(["Running"])})
        e.end_scenario()
        fake.execute(ev.UNIT_APP, UNIT_IP, "delete from operator_executions where workflow_execution_id = $1",
                     "$1 = '93'")
        waited = e.begin_scenario("b")
        self.assertIsInstance(waited["93"], float)

    def test_unavailable_without_statement_log(self):
        class NoLog(FakeDocker):
            def pg_line(self, *a, **k):  # statements are not logged
                pass
        e = ev.Evidence(run_id="t", runner=NoLog(), log=lambda m: None)
        e._mark_stmt = lambda mark_id, wait_s=10.0: None
        with self.assertRaises(ev.EvidenceUnavailable):
            e.preflight()


if __name__ == "__main__":
    unittest.main()
