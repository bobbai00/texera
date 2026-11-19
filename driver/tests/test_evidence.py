"""Offline tests of driver/evidence.py: a fake `docker` serves a synthetic Postgres
log (docker timestamps, the --pg-statement-log prefix, extended-protocol DETAIL
lines of interleaved pids, continuation lines) and answers psql marks, inspect,
getent and the unit's log.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
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
        self.gateway: list[tuple[int, str]] = []
        self.isolated = isolated
        self.cleanup = cleanup
        self.getent = ""
        #: what `getent hosts texera-postgres` answers in the unit, its health, and when it started
        self.getent_postgres = ""
        self.health = "healthy"
        self.started_at = "2023-11-14T22:13:20Z"  # the moment this fake's clock starts
        #: the final check's rows: (eid, wid, status) of the executions left at status 0 or 6
        self.never_ran: list[tuple[int, int, int]] = []
        self.pid = 500
        # the fake stack's threads log while the driver reads: append and stamp in order
        self.lock = threading.RLock()

    def _ts(self) -> tuple[int, str]:
        self.t += 1_000_000  # 1 ms
        sec, ns = divmod(self.t, 1_000_000_000)
        import time
        base = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(sec))
        frac = f"{ns:09d}".rstrip("0") or "0"
        return self.t, f"{base}.{frac}Z"

    def pg_line(self, pid: int, app: str, host: str, level: str, msg: str, db: str = "texera_db") -> None:
        with self.lock:
            t, _ = self._ts()
            self.pg.append((t, f"2026-11-16 10:00:00.000 UTC [{pid}] app={app} db={db} host={host} {level}:  {msg}"))

    def pg_raw(self, line: str) -> None:
        with self.lock:
            t, _ = self._ts()
            self.pg.append((t, line))

    def unit_line(self, text: str) -> None:
        with self.lock:
            t, _ = self._ts()
            self.unit.append((t, text))

    # statements as pgjdbc sends them
    def execute(self, app: str, host: str, sql: str, params: str | None = None, pid: int | None = None) -> None:
        pid = pid or 100
        with self.lock:
            self.pg_line(pid, app, host, "LOG", f"execute <unnamed>: {sql}")
            if params is not None:
                self.pg_line(pid, app, host, "DETAIL", f"parameters: {params}")

    def gateway_line(self, addr: str, method: str, uri: str, status: int = 200) -> None:
        with self.lock:
            t, _ = self._ts()
            self.gateway.append((t, f'sce-access {addr} "{method} {uri}" {status}'))

    def __call__(self, args, timeout=60):
        with self.lock:
            return self._call(list(args))

    def _call(self, args):
        out, rc = "", 0
        if args[0] == "exec" and "psql" in args:
            sql = args[-1]
            if sql.startswith("SELECT 'sce-mark"):
                self.pg_line(999, "psql", "[local]", "LOG", f"statement: {sql}")
                out = sql.split("'")[1]
            elif "e.status IN (0, 6)" in sql:
                out = "".join(f"{eid}|{wid}|{status}\n" for eid, wid, status in self.never_ran)
        elif args[0] == "logs":
            container = args[-1]
            lines = {"sce-texera-postgres": self.pg, "sce-texera-nginx": self.gateway}.get(container, self.unit)
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
        elif args[0] == "inspect" and "{{.State.StartedAt}}" in args:
            out = self.started_at
        elif args[0] == "inspect" and "{{.State.Health.Status}}" in args:
            out = self.health
        elif args[0] == "inspect":
            nets = ({"sce-unit-net": {"IPAddress": UNIT_IP}} if self.isolated
                    else {"sce-net": {"IPAddress": UNIT_IP}})
            env = [f"WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS={self.cleanup}"]
            out = json.dumps(nets) + "|" + json.dumps(env)
        elif args[0] == "exec" and "getent" in args and "texera-postgres" in args:
            out, rc = self.getent_postgres, (0 if self.getent_postgres else 2)
        elif args[0] == "exec" and "getent" in args:
            out, rc = self.getent, (0 if self.getent else 2)
        return subprocess.CompletedProcess(args, rc, out, "")


class Handle:
    """A run handle as evidence sees it. `before`: states it held when the start was
    about to be sent (what on_phase("start") reads first); `states`: what arrived
    after the start (seen from the second read on)."""

    def __init__(self, states, before=()):
        self.log = [(0.1 * i, s) for i, s in enumerate(list(before) + list(states))]
        self.n_before = len(before)
        self.reads = 0

    @property
    def state_log(self):
        self.reads += 1
        return self.log[:self.n_before] if self.reads == 1 else list(self.log)

    @property
    def states(self):
        return [s for _, s in self.log]


def make(fake: FakeDocker, **kw) -> ev.Evidence:
    kw.setdefault("cleanup_wait_s", 0.5)
    kw.setdefault("quiet_s", 0.3)
    e = ev.Evidence(run_id="t", runner=fake, log=lambda m: None, **kw)
    e.preflight()
    return e


HOST_GATEWAY = "172.30.0.1"  # the driver's requests reach nginx from the Docker gateway


def new_path_run(fake: FakeDocker, e: ev.Evidence, wid: int, eid: int, *, insert_app=ev.DASHBOARD_APP,
                 insert_host=DASH_IP, gateway: bool = True) -> None:
    """What the design's services log for one created and started execution."""
    e.on_phase("create", {"wid": wid, "cuid": 1})
    fake.execute(insert_app, insert_host, "insert into workflow_executions (vid, uid, status) values ($1, $2, $3)",
                 "$1 = '1', $2 = '1', $3 = '0'")
    e.on_phase("created", {"eid": eid, "wid": wid})
    e.on_phase("start", {"wid": wid, "cuid": 1, "eid": eid, "handle": Handle(["Initializing", "Running", "Completed"])})
    for status in ("0", "1", "3"):
        fake.execute(ev.UNIT_APP, UNIT_IP, "update workflow_executions set status = $1, last_update_time = $2 "
                                           "where workflow_executions.eid = $3", f"$1 = '{status}', $2 = 'now', "
                                                                                 f"$3 = '{eid}'")
    if gateway:
        fake.gateway_line(HOST_GATEWAY, "GET", f"/api/executions/{wid}")


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

    def test_casts_around_binds(self):
        st = ev.Stmt(0, "", 1, ev.UNIT_APP, "texera_db", "h", "execute",
                     'update "texera_db"."workflow_executions" set "status" = cast($1 as smallint), '
                     '"last_update_time" = cast($2 as timestamp(0)) where '
                     '"texera_db"."workflow_executions"."eid" = cast($3 as integer)',
                     params_text="$1 = '1', $2 = 'now', $3 = '42'")
        self.assertEqual((1, 42), st.status_update())
        self.assertTrue(st.refers_to_eid(42))

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
        e = make(fake)
        e.begin_scenario("a")
        e.on_phase("create", {"wid": 5, "cuid": 1})
        fake.execute(ev.DASHBOARD_APP, DASH_IP, "insert into workflow_executions (vid, uid, status) values ($1, $2, $3)",
                     "$1 = '1', $2 = '1', $3 = '0'")
        fake.execute(ev.DASHBOARD_APP, DASH_IP, "select * from dataset where name = $1", "$1 = 'x'")
        e.on_phase("created", {"eid": 90, "wid": 5})
        e.on_phase("start", {"wid": 5, "cuid": 1, "eid": 90,
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
        fake.gateway_line(HOST_GATEWAY, "GET", "/api/executions/5")
        fake.gateway_line(HOST_GATEWAY, "GET", "/wsapi/workflow-websocket", 101)
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
        e.on_phase("created", {"eid": 91, "wid": 6})
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
        e.on_phase("created", {"eid": 93, "wid": 5})
        e.on_phase("start", {"wid": 5, "cuid": 1, "eid": 93, "handle": Handle(["Running"])})
        e.end_scenario()
        fake.execute(ev.UNIT_APP, UNIT_IP, "delete from operator_executions where workflow_execution_id = $1",
                     "$1 = '93'")
        waited = e.begin_scenario("b")
        self.assertIsInstance(waited["cleanup_deletes"]["93"], float)

    def test_cleanup_wait_outlasts_the_trailing_statements(self):
        """The review's probe: the cleanup's SELECT of runtime_stats_uri comes 20-40 ms
        after its DELETE (and Iceberg work follows). The next begin mark must come after
        every statement of the cleanup, not right after the DELETE."""
        fake = FakeDocker(isolated=True, cleanup="0")
        e = make(fake, cleanup_wait_s=5.0, quiet_s=0.4)
        e.begin_scenario("a")
        new_path_run(fake, e, 5, 94)
        e.end_scenario()

        def cleanup():
            time.sleep(0.2)
            fake.execute(ev.UNIT_APP, UNIT_IP, "delete from operator_executions where "
                                               "operator_executions.workflow_execution_id = $1", "$1 = '94'")
            time.sleep(0.3)
            fake.execute(ev.UNIT_APP, UNIT_IP, "select workflow_executions.runtime_stats_uri from "
                                               "workflow_executions where workflow_executions.eid = $1", "$1 = '94'")
        t = threading.Thread(target=cleanup)
        t.start()
        waited = e.begin_scenario("b")
        t.join()
        self.assertTrue(waited["quiet"], waited)
        e.refresh_log()
        trailing = next(s for s in e.pg.stmts if "runtime_stats_uri" in s.norm)
        begin_b = e.pg.find_mark(e._begin_mark)
        self.assertLess(trailing.seq, begin_b.seq)

    def test_a_scenario_that_only_opened_sockets_still_waits_out_the_cleanup_delay(self):
        fake = FakeDocker(isolated=True, cleanup="1")
        e = make(fake, cleanup_wait_s=5.0, quiet_s=0.2)
        e.begin_scenario("l5")
        e.on_phase("start", {"wid": 6, "cuid": 1, "eid": 91, "handle": Handle([])})  # refused
        e.end_scenario()
        t0 = time.monotonic()
        waited = e.begin_scenario("l6")
        self.assertGreaterEqual(time.monotonic() - t0, 1.3)  # cleanup delay 1 s + 0.5 s after the end mark
        self.assertEqual({}, waited["cleanup_deletes"])

    def test_has_started_counts_only_states_after_the_start(self):
        """l8 on the real unit: a second socket on a completed run. Whatever state the
        handle held before the start (here a leftover "Completed") is not this start's."""
        fake = FakeDocker(isolated=True)
        e = make(fake)
        e.begin_scenario("l8")
        h = Handle([], before=["Completed"])
        run = e.on_phase("start", {"wid": 6, "cuid": 1, "eid": 95, "handle": h})
        self.assertEqual(1, run.state_index)
        self.assertFalse(run.has_started())
        h.log.append((1.0, "Initializing"))
        self.assertTrue(run.has_started())

    def test_refused_start_silence(self):
        fake = FakeDocker(isolated=True)
        e = make(fake)
        e.begin_scenario("l5")
        e.on_phase("start", {"wid": 6, "cuid": 1, "eid": 96, "handle": Handle([])})
        e.expect_silent_since_start(96, "quiet refusal")
        e.on_phase("start", {"wid": 7, "cuid": 1, "eid": 97, "handle": Handle([])})
        # a read that names no eid at all (the old reviewer gap: refers_to_eid missed it)
        fake.execute(ev.UNIT_APP, UNIT_IP, "select user_warehouse.whid from user_warehouse where "
                                           "user_warehouse.uid = $1", "$1 = '2'")
        e.expect_silent_since_start(97, "a refusal that reads")
        out = e.end_scenario()
        silent = {x["eid"]: x for x in out["report"]["unit_silent_after_refused_start"]}
        self.assertTrue(silent[96]["ok"], silent[96])
        self.assertFalse(silent[97]["ok"])
        self.assertIn("user_warehouse", silent[97]["statements"][0]["sql"])

    def test_settle_unit_waits_for_a_quiet_unit(self):
        fake = FakeDocker(isolated=True)
        e = make(fake, quiet_s=0.4)
        e.begin_scenario("l8")
        stop = time.monotonic() + 0.8

        def chatter():
            while time.monotonic() < stop:
                fake.execute(ev.UNIT_APP, UNIT_IP, "update operator_port_executions set result_size = $1 "
                                                   "where workflow_execution_id = $2", "$1 = '1', $2 = '9'")
                time.sleep(0.1)
        t = threading.Thread(target=chatter)
        t.start()
        t0 = time.monotonic()
        out = e.settle_unit()
        t.join()
        self.assertTrue(out["quiet"])
        self.assertGreaterEqual(time.monotonic() - t0, 1.1)  # the chatter, then the quiet period

    def test_c_refuses_a_dashboard_named_insert_from_a_unit_address(self):
        fake = FakeDocker(isolated=True)
        e = make(fake)
        e.begin_scenario("a")
        new_path_run(fake, e, 5, 98, insert_app=ev.DASHBOARD_APP, insert_host=UNIT_IP)
        r = e.end_scenario()["checks"]
        self.assertFalse(r["C"].ok, r["C"].detail)
        self.assertIn(UNIT_IP, r["C"].detail)

    def test_f_is_not_evaluable_with_stale_unit_addresses(self):
        fake = FakeDocker(isolated=True)
        e = make(fake)
        e.begin_scenario("a")
        e.on_phase("start", {"wid": 5, "cuid": 1, "eid": 99, "handle": Handle(["Running", "Completed"])})
        fake.execute(ev.UNIT_APP, "172.30.0.66", "update workflow_executions set status = $1 where "
                                                 "workflow_executions.eid = $2", "$1 = '1', $2 = '99'")
        r = e.end_scenario()["checks"]
        self.assertIsNone(r["F"].ok, r["F"].detail)
        self.assertIn("172.30.0.66", r["F"].detail)

    def test_d_sees_a_request_the_unit_sent_through_the_gateway(self):
        fake = FakeDocker(isolated=True)
        e = make(fake)
        e.begin_scenario("a")
        new_path_run(fake, e, 5, 100)
        fake.gateway_line(UNIT_IP, "GET", "/api/dataset/presign-download")
        r = e.end_scenario()["checks"]
        self.assertFalse(r["D"].ok, r["D"].detail)
        self.assertEqual(["GET /api/dataset/presign-download -> 200"], r["D"].data["via_gateway"])

    def test_d_is_not_evaluable_without_the_gateway_log(self):
        fake = FakeDocker(isolated=True)
        e = make(fake)
        e.begin_scenario("a")
        new_path_run(fake, e, 5, 101, gateway=False)
        r = e.end_scenario()["checks"]
        self.assertIsNone(r["D"].ok, r["D"].detail)

    def test_negative_control_wants_each_failure_for_its_reason(self):
        a_by_note = ev.CheckResult("A", False, "no unit status UPDATE", {"select_offenders": 0,
                                                                        "window_notes": ["eid 1: ..."]})
        d_resolves = ev.CheckResult("D", False, "getent resolves", {"resolved": ["10.0.0.2 file-service"],
                                                                    "log_lines": ["... file-service ..."]})
        d_gateway_only = ev.CheckResult("D", False, "via gateway", {"resolved": [], "log_lines": [],
                                                                    "via_gateway": ["GET /api/x -> 200"]})
        f_ok = ev.CheckResult("F", False, "unnamed", {"unnamed": [{"sql": "select 1"}]})
        gates, _ = ev.evaluate({"A": a_by_note, "D": d_resolves, "F": f_ok}, [], negative_control=True)
        by = {name.split()[1]: (ok, detail) for name, ok, detail in gates}
        self.assertFalse(by["A"][0])
        self.assertIn("control inconclusive", by["A"][1])
        self.assertFalse(by["D"][0])
        self.assertIn("not isolated", by["D"][1])
        self.assertTrue(by["F"][0])
        gates, _ = ev.evaluate({"D": d_gateway_only}, [], negative_control=True)
        self.assertFalse(gates[0][1])
        self.assertIn("control inconclusive", gates[0][2])

    def final(self, *rows: tuple[int, int, int], unstarted: tuple[int, ...] = ()) -> dict:
        """The final check on a Postgres that holds `rows` at status 0 or 6 ((eid, wid,
        status)), after scenarios that left `unstarted` so on purpose."""
        fake = FakeDocker()
        fake.never_ran = list(rows)
        e = make(fake)
        for eid in unstarted:
            e.leave_unstarted(eid, "l5: start refused on purpose")
        return e.final_check([5])

    def test_the_final_check_passes_rows_left_unstarted_on_purpose(self):
        self.assertTrue(self.final()["ok"])
        final = self.final((91, 5, 6), (92, 5, 6), unstarted=(91, 92))
        self.assertTrue(final["ok"], final)
        self.assertEqual("2 row(s) at status 0 or 6; 0 of them not left unstarted on purpose, or not at 6: []",
                         final["detail"])
        self.assertEqual("l5: start refused on purpose", final["left"][0]["allowed"])

    def test_the_final_check_fails_on_a_row_that_never_ran(self):
        """A run whose unit never got past setting it up, a create nobody started, and a
        refused start's row that does not read Created (a unit wrote to it, or the
        Dashboard created it as before the review of step 2)."""
        for rows, unstarted, bad in ((((92, 5, 0),), (), "[(92, 0)]"),
                                     (((93, 5, 6),), (), "[(93, 6)]"),
                                     (((91, 5, 0),), (91,), "[(91, 0)]"),
                                     (((91, 5, 6), (94, 5, 6)), (91,), "[(94, 6)]")):
            final = self.final(*rows, unstarted=unstarted)
            self.assertIs(False, final["ok"], rows)
            self.assertTrue(final["detail"].endswith(f"not at 6: {bad}"), final["detail"])

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
