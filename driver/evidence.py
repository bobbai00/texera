"""Evidence that a unit starts a run without reading Postgres or calling the file
service (step 2 design, section 7 H4).

The stack runs with `--pg-statement-log`: Postgres logs every statement as

    <%m> [<pid>] app=<application_name> db=<database> host=<client address> LOG:  statement: <sql>
    <%m> [<pid>] app=... LOG:  execute <name>: <sql with $n placeholders>
    <%m> [<pid>] app=... DETAIL:  parameters: $1 = '345', $2 = NULL

The driver cuts this log with marks, statements of its own that it runs through
psql inside the Postgres container (`SELECT 'sce-mark:<scenario>:<phase>:<eid>:<id>'`):
`begin` and `end` around a scenario, `create` before an execution is created and
`start` before it is started. Statements are ordered by the log, so a window is
"after this mark, up to that statement" and needs no clock.

A statement is the unit's when its connection is named `texera-computing-unit`
or when it comes from one of the unit container's addresses. The checks:

  A  start window (the start mark up to the unit's first status UPDATE of the
     eid to 1, 4 or 5): no unit statement starts with SELECT or WITH, and each
     is an INSERT or UPDATE on workflow_executions, operator_port_executions or
     operator_executions
  B  the start mark up to the unit's terminal status UPDATE of the eid: unit
     statements touch no other table
  C  every INSERT INTO workflow_executions of the scenario comes from
     app=texera-dashboard
  D  (needs --isolate-unit) the unit resolves neither file-service nor
     texera-lakefs, and its log since the start names none of them
  E  the execution's plan table (Lakekeeper, namespace execution-plan) has a
     ref named `started`
  F  every statement from the unit's addresses carries app=texera-computing-unit

With --negative-control (published images, the old unit) A, D and F must fail.
"""

from __future__ import annotations

import calendar
import json
import re
import shlex
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Sequence

UNIT_APP = "texera-computing-unit"
DASHBOARD_APP = "texera-dashboard"
EXECUTION_DB = "texera_db"
RUN_STATE_TABLES = frozenset({"workflow_executions", "operator_port_executions", "operator_executions"})
STATUS_STARTED = frozenset({1, 4, 5})   # RUNNING, or an early FAILED / KILLED
STATUS_TERMINAL = frozenset({3, 4, 5})  # COMPLETED, FAILED, KILLED
D_HOSTS = ("file-service", "texera-lakefs")
D_PATTERNS = ("file-service", "texera-lakefs", ":9092", ":8000/api/v1")
CHECKS = ("A", "B", "C", "D", "E", "F")
NEGATIVE_CONTROLS = ("A", "D", "F")
CHECK_TITLES = {
    "A": "the unit only writes run state while starting (no SELECT/WITH; INSERT/UPDATE on the "
         "three run-state tables)",
    "B": "from start to its terminal status the unit touches only the run-state tables",
    "C": "the execution row is inserted by app=texera-dashboard",
    "D": "the unit reaches neither file-service nor LakeFS",
    "E": "the execution's plan table carries the `started` tag",
    "F": "every statement from the unit's addresses carries app=texera-computing-unit",
}
CONTROL_REASONS = {
    "A": "the old unit SELECTs while starting",
    "D": "the old unit names file-service",
    "F": "the old unit's connections carry no name; its statements are found by its address",
}
DEFAULT_CONTAINERS = {
    "postgres": "sce-texera-postgres",
    "workflow-runtime-coordinator-service": "sce-workflow-runtime-coordinator-service",
    "dashboard-service": "sce-dashboard-service",
}
CLEANUP_ENV = "WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS"
PLAN_NAMESPACE_ENV = "STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE"
DEFAULT_PLAN_NAMESPACE = "execution-plan"
CLEANUP_WAIT_S = 15.0


class EvidenceUnavailable(RuntimeError):
    """The stack cannot give evidence (no statement log, no such container, ...)."""


# ----------------------------------------------------------------- docker glue


Runner = Callable[[Sequence[str], float], subprocess.CompletedProcess]


def docker_runner(args: Sequence[str], timeout: float = 60) -> subprocess.CompletedProcess:
    """`docker <args>` with stdout and stderr merged in the order docker writes them."""
    return subprocess.run(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, timeout=timeout, errors="replace")


_DOCKER_TS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$")


def docker_ts_ns(ts: str) -> int:
    """'2026-11-16T09:43:16.12Z' -> nanoseconds since the epoch (docker trims zeros,
    so the strings do not sort as text)."""
    date, _, frac = ts.rstrip("Z").partition(".")
    base = calendar.timegm(time.strptime(date, "%Y-%m-%dT%H:%M:%S"))
    return base * 1_000_000_000 + int((frac + "000000000")[:9])


class ContainerLog:
    """`docker logs --timestamps` of one container, read incrementally.

    Each poll asks for the lines since the newest timestamp seen; lines carrying
    exactly that timestamp that were already read are skipped, so nothing is read
    twice and nothing is lost at the boundary."""

    def __init__(self, container: str, runner: Runner = docker_runner):
        self.container = container
        self._run = runner
        self.lines: list[str] = []
        self.stamps: list[int] = []
        self._last_ts: str | None = None
        self._last_ns = -1
        self._seen_at_last: dict[str, int] = {}

    def poll(self) -> list[str]:
        args = ["logs", "--timestamps"]
        if self._last_ts:
            args += ["--since", self._last_ts]
        p = self._run([*args, self.container], 120)
        if p.returncode != 0:
            raise EvidenceUnavailable(f"docker logs {self.container}: {p.stdout.strip()[:300]}")
        fresh: list[str] = []
        for raw in p.stdout.splitlines():
            m = _DOCKER_TS.match(raw)
            if not m:
                continue  # docker always stamps; a stray line is not ours to place
            ts, line = m.group(1), m.group(2)
            ns = docker_ts_ns(ts)
            if ns < self._last_ns:
                continue
            if ns == self._last_ns:
                if self._seen_at_last.get(line, 0) > 0:
                    self._seen_at_last[line] -= 1
                    continue
            fresh.append(line)
            self.lines.append(line)
            self.stamps.append(ns)
            if ns > self._last_ns:
                self._last_ns, self._last_ts = ns, ts
                self._seen_at_last = {}
            # every line at the newest timestamp is "seen" for the next poll
        if self._last_ns >= 0:
            seen: dict[str, int] = {}
            for ns, line in zip(reversed(self.stamps), reversed(self.lines)):
                if ns != self._last_ns:
                    break
                seen[line] = seen.get(line, 0) + 1
            self._seen_at_last = seen
        return fresh

    def cursor(self) -> int:
        """Index of the next line, after polling now."""
        self.poll()
        return len(self.lines)

    def since(self, cursor: int) -> list[str]:
        self.poll()
        return self.lines[cursor:]


# ------------------------------------------------------------- the PG log model


_PG_LINE = re.compile(
    r"^(?P<ts>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?(?: [A-Za-z][A-Za-z0-9+:_/-]*)?) "
    r"\[(?P<pid>\d+)\] app=(?P<app>.*?) db=(?P<db>\S*) host=(?P<host>\S*) "
    r"(?P<level>[A-Z][A-Z0-9]*):  ?(?P<msg>.*)$")
_STATEMENT = re.compile(r"^statement: (?P<sql>.*)$", re.S)
_EXECUTE = re.compile(r"^execute (?P<name>[^:]*): (?P<sql>.*)$", re.S)
_PARAMETERS = re.compile(r"^parameters: (?P<params>.*)$", re.S)
_PARAM = re.compile(r"\$(\d+) = (NULL|'((?:[^']|'')*)')", re.S)
_MARK = re.compile(r"sce-mark:(?P<scenario>[^:']*):(?P<phase>[^:']*):(?P<eid>[^:']*):(?P<id>[^']*)")
_IGNORED_VERBS = frozenset({"begin", "commit", "rollback", "set", "show", "start", "savepoint",
                            "release", "end", "abort", "discard", "deallocate", "reset"})
_TABLE = re.compile(r"\b(?:from|join|into|update)\s+(?!\()([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)")
_NOT_TABLES = frozenset({"set", "select", "lateral", "only", "of", "nowait", "skip", "unnest"})
_VALUE = r"(\$\d+|-?\d+|'(?:[^']|'')*'|null)"
_STATUS_UPDATE = re.compile(r"^update (?:\w+\.)?workflow_executions set (?P<set>.*?) where (?P<where>.*)$")
_EID_COLUMNS = ("eid", "workflow_execution_id", "execution_id")


def _col_values(text: str, column: str) -> list[str]:
    """The values `column = <v>` assigns or compares in `text`; jOOQ may wrap a bind
    in a cast (`"starting_time" = cast($6 as timestamp(0))`), which is unwrapped."""
    return re.findall(r"(?:^|[\s,(.])" + re.escape(column) + r"\s*=\s*(?:cast\(\s*)?" + _VALUE, text)


def _split_top_level(text: str) -> list[str]:
    out, depth, cur, quote = [], 0, [], False
    for ch in text:
        if ch == "'":
            quote = not quote
        elif not quote and ch == "(":
            depth += 1
        elif not quote and ch == ")":
            depth -= 1
        if ch == "," and depth == 0 and not quote:
            out.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if "".join(cur).strip():
        out.append("".join(cur).strip())
    return out


def _value_groups(text: str) -> list[str]:
    """The parenthesized groups at depth 0 of `values (...), (...)`."""
    groups, depth, start, quote = [], 0, None, False
    for i, ch in enumerate(text):
        if ch == "'":
            quote = not quote
        elif quote:
            continue
        elif ch == "(":
            if depth == 0:
                start = i + 1
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and start is not None:
                groups.append(text[start:i])
                start = None
        elif depth == 0 and ch.isalpha():
            break  # "returning ...", "on conflict ..."
    return groups


@dataclass
class Stmt:
    """One statement as Postgres logged it."""

    seq: int
    ts: str
    pid: int
    app: str
    db: str
    host: str
    kind: str  # "statement" (simple protocol), "execute" (extended), "failed" (from an ERROR)
    sql: str
    params_text: str | None = None
    error: str | None = None
    duplicate: bool = False
    _norm: str | None = field(default=None, repr=False)
    _params: dict[int, str | None] | None = field(default=None, repr=False)

    @property
    def norm(self) -> str:
        """Lower case, quotes and the texera_db schema dropped, whitespace collapsed."""
        if self._norm is None:
            s = re.sub(r"\s+", " ", self.sql.replace('"', "")).strip().lower()
            s = re.sub(r"\btexera_db\.", "", s)
            self._norm = s
        return self._norm

    @property
    def verb(self) -> str:
        return self.norm.lstrip("(").split(" ", 1)[0] if self.norm else ""

    @property
    def tables(self) -> frozenset[str]:
        found = set()
        for name in _TABLE.findall(self.norm):
            base = name.split(".")[-1]
            if base not in _NOT_TABLES:
                found.add(base)
        return frozenset(found)

    @property
    def params(self) -> dict[int, str | None]:
        if self._params is None:
            self._params = {}
            for num, raw, inner in _PARAM.findall(self.params_text or ""):
                self._params[int(num)] = None if raw == "NULL" else inner.replace("''", "'")
        return self._params

    def resolve(self, token: str) -> str | None:
        token = token.strip()
        if token.startswith("$"):
            return self.params.get(int(token[1:]))
        if token == "null":
            return None
        if token.startswith("'"):
            return token[1:-1].replace("''", "'")
        return token

    @property
    def mark(self) -> dict | None:
        m = _MARK.search(self.sql) if "sce-mark:" in self.sql else None
        return m.groupdict() if m else None

    @property
    def relevant(self) -> bool:
        """A statement the checks look at: on texera_db, not empty, not transaction
        control or a setting, not a duplicate of a failed one, not one of our marks."""
        return (self.db == EXECUTION_DB and bool(self.norm) and self.verb not in _IGNORED_VERBS
                and not self.duplicate and self.mark is None)

    def status_update(self) -> tuple[int | None, int | None] | None:
        """(status, eid) of an `UPDATE workflow_executions SET ... status ... WHERE ... eid`,
        else None."""
        m = _STATUS_UPDATE.match(self.norm)
        if not m:
            return None
        statuses = _col_values(m.group("set"), "status")
        eids = _col_values(m.group("where"), "eid")
        if not statuses or not eids:
            return None

        def as_int(tok: str) -> int | None:
            v = self.resolve(tok)
            try:
                return int(str(v).strip()) if v is not None else None
            except ValueError:
                return None

        return as_int(statuses[0]), as_int(eids[0])

    def refers_to_eid(self, eid: int) -> bool:
        """Whether a WHERE/SET column or an inserted column naming an execution holds `eid`."""
        want = str(eid)
        for col in _EID_COLUMNS:
            for tok in _col_values(self.norm, col):
                if (self.resolve(tok) or "").strip() == want:
                    return True
        m = re.match(r"^insert into \S+ \((?P<cols>[^)]*)\) values (?P<rest>.*)$", self.norm)
        if m:
            cols = [c.strip().split(".")[-1] for c in m.group("cols").split(",")]
            for group in _value_groups(m.group("rest")):
                vals = _split_top_level(group)
                for col, val in zip(cols, vals):
                    if col in _EID_COLUMNS:
                        token = re.search(_VALUE, val)
                        if token and (self.resolve(token.group(1)) or "").strip() == want:
                            return True
        return False

    def is_cleanup_delete(self, eid: int) -> bool:
        if not self.norm.startswith("delete from operator_executions"):
            return False
        return any((self.resolve(t) or "").strip() == str(eid)
                   for t in _col_values(self.norm, "workflow_execution_id"))

    def to_json(self, limit: int = 2000) -> dict:
        out: dict[str, Any] = {"seq": self.seq, "ts": self.ts, "pid": self.pid, "app": self.app,
                               "host": self.host, "sql": self.sql[:limit]}
        if self.params_text is not None:
            out["params"] = self.params_text[:limit]
        if self.kind == "failed" or self.error:
            out["error"] = (self.error or "")[:500]
        return out


class PgLog:
    """Statements parsed from the Postgres log, in log order."""

    def __init__(self) -> None:
        self.stmts: list[Stmt] = []
        self.unparsed = 0
        self._last_by_pid: dict[int, Stmt] = {}
        self._error_by_pid: dict[int, str] = {}
        self._target: tuple[Stmt, str] | None = None

    def feed(self, lines: Iterable[str]) -> None:
        for line in lines:
            m = _PG_LINE.match(line)
            if not m:
                # Postgres starts each continuation line of a multi-line message with a tab.
                if line.startswith("\t") and self._target:
                    stmt, attr = self._target
                    setattr(stmt, attr, (getattr(stmt, attr) or "") + "\n" + line[1:])
                    stmt._norm = None
                    stmt._params = None
                else:
                    self.unparsed += 1
                continue
            pid, level, msg = int(m.group("pid")), m.group("level"), m.group("msg")
            self._target = None
            if level == "LOG":
                sm = _STATEMENT.match(msg) or _EXECUTE.match(msg)
                if sm:
                    st = Stmt(len(self.stmts), m.group("ts"), pid, m.group("app"), m.group("db"),
                              m.group("host"), "statement" if msg.startswith("statement") else "execute",
                              sm.group("sql"))
                    self.stmts.append(st)
                    self._last_by_pid[pid] = st
                    self._target = (st, "sql")
            elif level == "DETAIL":
                pm = _PARAMETERS.match(msg)
                st = self._last_by_pid.get(pid)
                if pm and st is not None and st.params_text is None:
                    st.params_text = pm.group("params")
                    self._target = (st, "params_text")
            elif level in ("ERROR", "FATAL"):
                self._error_by_pid[pid] = msg
            elif level == "STATEMENT":
                # The statement an ERROR was about. A parse error never reached the
                # `execute` log line, so this may be the only record of the attempt.
                prev = self._last_by_pid.get(pid)
                st = Stmt(len(self.stmts), m.group("ts"), pid, m.group("app"), m.group("db"),
                          m.group("host"), "failed", msg, error=self._error_by_pid.pop(pid, None))
                self.stmts.append(st)
                self._target = (st, "sql")
                st._prev_same_pid = prev  # type: ignore[attr-defined]
                self._last_by_pid[pid] = st

    def finalize(self) -> None:
        """Fold a failed statement into the logged one it repeats."""
        for st in self.stmts:
            prev = getattr(st, "_prev_same_pid", None)
            if st.kind == "failed" and prev is not None and not st.duplicate and prev.sql == st.sql:
                prev.error = st.error
                st.duplicate = True

    def marks(self) -> list[tuple[Stmt, dict]]:
        return [(s, s.mark) for s in self.stmts if s.mark]

    def find_mark(self, mark_id: str) -> Stmt | None:
        for s in reversed(self.stmts):
            mk = s.mark
            if mk and mk["id"] == mark_id:
                return s
        return None


# -------------------------------------------------------------------- the runs


@dataclass
class RunRecord:
    """One execution a scenario created or started."""

    scenario: str
    wid: int | None = None
    cuid: int | None = None
    eid: int | None = None
    plan_uri: str | None = None
    create_mark: str | None = None
    start_mark: str | None = None
    unit_log_cursor: int | None = None
    handle: Any = None
    started: bool | None = None  # set explicitly by callers without a handle (REST runs)

    def has_started(self) -> bool:
        """The unit accepted the start: some state other than the handshake's arrived."""
        if self.started is not None:
            return self.started
        if self.handle is None or self.start_mark is None:
            return False
        try:
            states = list(self.handle.states)
        except Exception:  # noqa: BLE001
            return False
        return any(s != "Uninitialized" for s in states)

    def to_json(self) -> dict:
        return {"wid": self.wid, "cuid": self.cuid, "eid": self.eid, "plan_uri": self.plan_uri,
                "create_mark": self.create_mark, "start_mark": self.start_mark,
                "started": self.has_started()}


@dataclass
class CheckResult:
    key: str
    ok: bool | None  # None: not evaluable
    detail: str
    data: dict = field(default_factory=dict)


# -------------------------------------------------------------------- evidence


class Evidence:
    """Marks, the statement log and the checks, for one driver run."""

    def __init__(self, *, run_id: str, required: Iterable[str] = CHECKS, negative_control: bool = False,
                 containers: dict[str, str] | None = None, env: dict[str, str] | None = None,
                 log: Callable[[str], None] = print, runner: Runner = docker_runner,
                 cleanup_wait_s: float = CLEANUP_WAIT_S):
        self.run_id = run_id
        self.required = [c for c in CHECKS if c in set(required)]
        self.negative_control = negative_control
        c = dict(DEFAULT_CONTAINERS)
        c.update(containers or {})
        self.pg_container = c["postgres"]
        self.unit_container = c["workflow-runtime-coordinator-service"]
        self.dashboard_container = c["dashboard-service"]
        self.env = env or {}
        self.catalog_uri = self.env.get("STORAGE_ICEBERG_CATALOG_REST_URI",
                                        "http://texera-lakekeeper:8181/catalog").rstrip("/")
        self.default_warehouse = self.env.get("STORAGE_ICEBERG_CATALOG_REST_WAREHOUSE_NAME", "texera")
        self._log = log
        self._run = runner
        self.cleanup_wait_s = cleanup_wait_s
        self.pg = PgLog()
        self.pg_log = ContainerLog(self.pg_container, runner)
        self.unit_log = ContainerLog(self.unit_container, runner)
        self.unit_hosts: set[str] = set()
        self.isolated = False
        self.unit_env: dict[str, str] = {}
        self.plan_namespace = DEFAULT_PLAN_NAMESPACE
        self._seq = 0
        self.scenario: str | None = None
        self.runs: list[RunRecord] = []
        self._begin_mark: str | None = None
        self._previous_started: dict[int, int] = {}  # wid -> last started eid, for the cleanup wait
        self._expect_no_unit: list[tuple[int, str]] = []
        self.allowed_status_zero: dict[int, str] = {}
        self.warehouse_name: str | None = None
        self.info: dict[str, Any] = {}

    # ------------------------------------------------------------------ basics

    def _docker(self, *args: str, timeout: float = 60) -> subprocess.CompletedProcess:
        return self._run(list(args), timeout)

    def _psql(self, sql: str) -> subprocess.CompletedProcess:
        return self._docker("exec", self.pg_container, "psql", "-U", "texera", "-d", EXECUTION_DB,
                            "-v", "ON_ERROR_STOP=1", "-Atc", sql)

    def refresh_log(self) -> None:
        self.pg.feed(self.pg_log.poll())
        self.pg.finalize()

    def mark(self, scenario: str, phase: str, eid: int | None = None) -> str:
        """Run a mark statement; return its id. The statement is in the log before
        this returns, so whatever the driver does next is logged after it."""
        self._seq += 1
        mark_id = f"{self.run_id}-{self._seq}"
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", scenario)
        text = f"sce-mark:{safe}:{phase}:{'' if eid is None else eid}:{mark_id}"
        p = self._psql(f"SELECT '{text}'")
        if p.returncode != 0:
            raise EvidenceUnavailable(f"mark {text}: psql failed: {p.stdout.strip()[:300]}")
        return mark_id

    def _mark_stmt(self, mark_id: str | None, wait_s: float = 10.0) -> Stmt | None:
        if mark_id is None:
            return None
        deadline = time.monotonic() + wait_s
        while True:
            self.refresh_log()
            st = self.pg.find_mark(mark_id)
            if st is not None or time.monotonic() > deadline:
                return st
            time.sleep(0.3)

    # --------------------------------------------------------------- preflight

    def preflight(self) -> dict:
        """Prove the log works and learn the unit's addresses, networks and env."""
        probe = self.mark("preflight", "probe")
        st = self._mark_stmt(probe)
        if st is None:
            raise EvidenceUnavailable(
                f"the mark statement never appeared in {self.pg_container}'s log: start the stack "
                f"with --pg-statement-log")
        insp = self._docker("inspect", self.unit_container, "--format",
                            "{{json .NetworkSettings.Networks}}|{{json .Config.Env}}")
        if insp.returncode != 0:
            raise EvidenceUnavailable(f"docker inspect {self.unit_container}: {insp.stdout.strip()[:300]}")
        nets_json, _, env_json = insp.stdout.strip().partition("|")
        nets = json.loads(nets_json or "{}")
        self.unit_hosts = {n.get("IPAddress") for n in nets.values() if n.get("IPAddress")}
        self.unit_hosts |= {n.get("GlobalIPv6Address") for n in nets.values() if n.get("GlobalIPv6Address")}
        self.isolated = set(nets) == {"sce-unit-net"}
        self.unit_env = dict(e.split("=", 1) for e in json.loads(env_json or "[]") if "=" in e)
        self.plan_namespace = self.unit_env.get(PLAN_NAMESPACE_ENV) or DEFAULT_PLAN_NAMESPACE
        cleanup = self.unit_env.get(CLEANUP_ENV)
        self.info = {
            "postgres_container": self.pg_container,
            "unit_container": self.unit_container,
            "unit_networks": sorted(nets),
            "unit_hosts": sorted(self.unit_hosts),
            "unit_isolated": self.isolated,
            "unit_cleanup_seconds": cleanup,
            "plan_namespace": self.plan_namespace,
            "catalog_uri": self.catalog_uri,
            "probe_mark": {"app": st.app, "db": st.db, "host": st.host},
            "required_checks": self.required,
            "negative_control": self.negative_control,
        }
        if not cleanup or not cleanup.isdigit() or int(cleanup) > 5:
            self._log(f"evidence: WARNING the unit's {CLEANUP_ENV} is {cleanup or 'unset (30 s)'}; an "
                      f"idle workflow's cleanup can land in the next scenario's windows "
                      f"(the stack's --pg-statement-log sets 2 s)")
        if "D" in self.required and not self.isolated:
            self._log("evidence: WARNING Check D needs a stack started with --isolate-unit")
        return self.info

    # ------------------------------------------------------- scenario plumbing

    def begin_scenario(self, key: str) -> dict:
        """Wait for the previous scenario's idle cleanup (see CLEANUP_WAIT_S), then mark."""
        waited = self._wait_for_cleanup()
        self.scenario = key
        self.runs = []
        self._expect_no_unit = []
        self._begin_mark = self.mark(key, "begin")
        return waited

    def _wait_for_cleanup(self) -> dict:
        pending = dict(self._previous_started)
        self._previous_started = {}
        if not pending:
            return {}
        after = self.pg.find_mark(self._begin_mark) if self._begin_mark else None
        after_seq = after.seq if after else -1
        deadline = time.monotonic() + self.cleanup_wait_s
        t0 = time.monotonic()
        seen: dict[int, float] = {}
        while True:
            self.refresh_log()
            for st in self.pg.stmts[after_seq + 1:]:
                if not self.is_unit(st):
                    continue
                for eid in pending.values():
                    if eid not in seen and st.is_cleanup_delete(eid):
                        seen[eid] = round(time.monotonic() - t0, 1)
            if len(seen) == len(pending) or time.monotonic() > deadline:
                break
            time.sleep(0.5)
        out = {str(eid): (seen.get(eid, "not seen within %.0f s" % self.cleanup_wait_s))
               for eid in pending.values()}
        missing = [e for e in pending.values() if e not in seen]
        if missing:
            self._log(f"evidence: the unit's idle cleanup of execution(s) {missing} did not appear "
                      f"within {self.cleanup_wait_s:.0f} s")
        return out

    def on_phase(self, phase: str, info: dict) -> RunRecord | None:
        """The transport's hook: `create` before an execution is created, `start`
        before one is started. Returns the run record (callers may fill its eid)."""
        if self.scenario is None:
            return None
        if phase == "create":
            run = RunRecord(self.scenario, wid=info.get("wid"), cuid=info.get("cuid"))
            run.create_mark = self.mark(self.scenario, "create")
            self.runs.append(run)
            return run
        if phase == "start":
            run = info.get("run")
            if run is None:
                # the start of the execution created last, unless this one names another
                cands = [r for r in self.runs if r.start_mark is None and
                         (info.get("eid") is None or r.eid in (None, info.get("eid")))]
                run = cands[-1] if cands else RunRecord(self.scenario)
                if run not in self.runs:
                    self.runs.append(run)
            run.wid = info.get("wid", run.wid)
            run.cuid = info.get("cuid", run.cuid)
            run.eid = info.get("eid", run.eid)
            run.plan_uri = info.get("plan_uri", run.plan_uri)
            run.handle = info.get("handle", run.handle)
            run.start_mark = self.mark(self.scenario, "start", run.eid)
            try:
                run.unit_log_cursor = self.unit_log.cursor()
            except EvidenceUnavailable as e:
                self._log(f"evidence: {e}")
            return run
        if phase == "created":
            # the create answered: remember the eid on the run the create mark opened
            for run in reversed(self.runs):
                if run.create_mark and run.eid is None:
                    run.eid = info.get("eid")
                    run.plan_uri = info.get("plan_uri")
                    run.wid = info.get("wid", run.wid)
                    return run
        return None

    def expect_no_unit_statement(self, eid: int, why: str, since_last_start: bool = False) -> None:
        """At the scenario's end: no unit statement refers to `eid`, in the whole
        scenario or only after the last start of `eid`."""
        self._expect_no_unit.append((eid, why, since_last_start))

    def allow_status_zero(self, eid: int, why: str) -> None:
        self.allowed_status_zero[eid] = why

    # ------------------------------------------------------------ attribution

    def is_unit(self, st: Stmt) -> bool:
        return st.app == UNIT_APP or st.host in self.unit_hosts

    def _window(self, start: Stmt, end: Stmt | None) -> list[Stmt]:
        hi = end.seq if end is not None else len(self.pg.stmts) - 1
        return [s for s in self.pg.stmts[start.seq + 1: hi + 1] if s.relevant]

    def _first_status(self, after: Stmt, until: Stmt | None, eid: int,
                      statuses: frozenset[int]) -> Stmt | None:
        hi = until.seq if until is not None else len(self.pg.stmts) - 1
        for st in self.pg.stmts[after.seq + 1: hi + 1]:
            if not st.relevant or not self.is_unit(st):
                continue
            su = st.status_update()
            if su and su[1] == eid and su[0] in statuses:
                return st
        return None

    # ------------------------------------------------------------- the checks

    def end_scenario(self, resolve_eid: Callable[[RunRecord], int | None] | None = None) -> dict:
        """Mark the end, read the log and evaluate every check for this scenario.
        Returns {"checks": {key: CheckResult}, "report": {...}}."""
        key = self.scenario or "?"
        end_id = self.mark(key, "end")
        end = self._mark_stmt(end_id)
        begin = self._mark_stmt(self._begin_mark)
        for run in self.runs:
            # Only a run started on `ws` lacks its eid (the unit created it); a refused
            # create has none and must not borrow the workflow's latest one.
            if run.eid is None and resolve_eid is not None and run.start_mark:
                try:
                    run.eid = resolve_eid(run)
                except Exception as e:  # noqa: BLE001
                    self._log(f"evidence: could not resolve the eid of a run of workflow {run.wid}: {e}")
        started = [r for r in self.runs if r.start_mark and r.eid is not None and r.has_started()]
        results: dict[str, CheckResult] = {}
        report: dict[str, Any] = {"runs": [r.to_json() for r in self.runs], "windows": []}
        if begin is None or end is None:
            for c in CHECKS:
                results[c] = CheckResult(c, None, "the scenario's begin/end marks are not in the log")
            return {"checks": results, "report": report}

        scen = self._window(begin, end)
        a_bad, b_bad, a_all, b_all = [], [], [], []
        window_notes = []
        for run in started:
            start = self._mark_stmt(run.start_mark)
            if start is None:
                window_notes.append(f"eid {run.eid}: start mark missing")
                continue
            first = self._first_status(start, end, run.eid, STATUS_STARTED)
            term = self._first_status(start, end, run.eid, STATUS_TERMINAL)
            a_win = [s for s in self._window(start, first or end) if self.is_unit(s)]
            b_win = [s for s in self._window(start, term or end) if self.is_unit(s)]
            a_all += a_win
            b_all += b_win
            for s in a_win:
                if s.verb in ("select", "with") or not (s.verb in ("insert", "update")
                                                         and s.tables <= RUN_STATE_TABLES and s.tables):
                    a_bad.append(s)
            for s in b_win:
                if not s.tables <= RUN_STATE_TABLES:
                    b_bad.append(s)
            report["windows"].append({
                "eid": run.eid,
                "start_window_ends_at": first.to_json(300) if first else "the scenario's end mark "
                                        "(no unit status UPDATE to 1, 4 or 5 for this eid)",
                "terminal_update": term.to_json(300) if term else None,
                "start_window_unit_statements": [s.to_json() for s in a_win],
                "to_terminal_unit_statements": [s.to_json() for s in b_win],
            })
            if first is None:
                window_notes.append(f"eid {run.eid}: no unit status UPDATE to 1/4/5 before the end mark")

        def summarize(bad: list[Stmt], total: list[Stmt]) -> str:
            heads = "; ".join(f"[{s.app or '-'}@{s.host or '-'}] {s.sql[:160]}" for s in bad[:4])
            return f"{len(bad)} of {len(total)} unit statements offend" + (f": {heads}" if heads else "")

        if not started:
            for c in ("A", "B"):
                results[c] = CheckResult(c, True, "no run of this scenario was started on the unit",
                                         {"vacuous": True})
        else:
            results["A"] = CheckResult("A", not a_bad and not window_notes,
                                       summarize(a_bad, a_all) + (f"; {'; '.join(window_notes)}"
                                                                  if window_notes else ""),
                                       {"offending": [s.to_json(400) for s in a_bad[:50]]})
            results["B"] = CheckResult("B", not b_bad, summarize(b_bad, b_all) + "; tables: "
                                       + ", ".join(sorted({t for s in b_bad for t in s.tables})[:12]),
                                       {"offending": [s.to_json(400) for s in b_bad[:50]]})

        inserts = [s for s in scen if s.norm.startswith("insert into workflow_executions")]
        created = [r for r in self.runs if r.create_mark]
        not_dash = [s for s in inserts if s.app != DASHBOARD_APP]
        if not inserts:
            results["C"] = CheckResult("C", not created or all(r.eid is None for r in created),
                                       "no INSERT INTO workflow_executions in the scenario"
                                       + (f" although {len(created)} execution(s) were created"
                                          if created and any(r.eid for r in created) else ""),
                                       {"vacuous": True})
        else:
            results["C"] = CheckResult("C", not not_dash,
                                       f"{len(inserts)} INSERT INTO workflow_executions, from "
                                       + ", ".join(sorted({s.app or '-' for s in inserts})),
                                       {"inserts": [s.to_json(300) for s in inserts]})

        results["D"] = self._check_d(started)
        results["E"] = self._check_e(started)

        from_unit_addr = [s for s in scen if s.host in self.unit_hosts]
        unnamed = [s for s in from_unit_addr if s.app != UNIT_APP]
        if not self.unit_hosts:
            results["F"] = CheckResult("F", None, "the unit's addresses are unknown")
        elif not from_unit_addr:
            results["F"] = CheckResult("F", True, "no statement from the unit's addresses in the scenario",
                                       {"vacuous": True})
        else:
            results["F"] = CheckResult("F", not unnamed,
                                       f"{len(from_unit_addr)} statements from {sorted(self.unit_hosts)}; "
                                       f"apps {sorted({s.app or '-' for s in from_unit_addr})}",
                                       {"unnamed": [s.to_json(300) for s in unnamed[:20]]})

        # deferred expectations of the scenario: no unit statement for an execution
        expectations = []
        for eid, why, since_last_start in self._expect_no_unit:
            window = scen
            if since_last_start:
                last = next((r for r in reversed(self.runs) if r.eid == eid and r.start_mark), None)
                start = self._mark_stmt(last.start_mark) if last else None
                window = self._window(start, end) if start else scen
            hits = [s for s in window if self.is_unit(s) and s.refers_to_eid(eid)]
            expectations.append({"eid": eid, "why": why, "ok": not hits,
                                 "since": "the last start" if since_last_start else "the scenario's begin",
                                 "statements": [s.to_json(300) for s in hits[:10]]})
        report["no_unit_statement_for"] = expectations
        report["unit_statements_in_scenario"] = len([s for s in scen if self.is_unit(s)])

        for run in started:
            wid = run.wid if run.wid is not None else -1
            self._previous_started[wid] = max(run.eid, self._previous_started.get(wid, 0))
        self.scenario = None
        return {"checks": results, "report": report}

    def _check_d(self, started: list[RunRecord]) -> CheckResult:
        if not started:
            return CheckResult("D", True, "no run of this scenario was started on the unit", {"vacuous": True})
        if not self.isolated:
            return CheckResult("D", None, "not evaluable: the unit is not isolated (start the stack "
                                          "with --isolate-unit)")
        g = self._docker("exec", self.unit_container, "getent", "hosts", *D_HOSTS)
        resolved = [ln for ln in g.stdout.splitlines() if ln.strip()]
        if g.returncode not in (0, 2):
            return CheckResult("D", None, f"getent failed in the unit ({g.returncode}): {g.stdout[:200]}")
        cursor = min((r.unit_log_cursor for r in started if r.unit_log_cursor is not None), default=None)
        if cursor is None:
            return CheckResult("D", None, "the unit's log position at the start is unknown")
        lines = self.unit_log.since(cursor)
        named = [ln for ln in lines if any(p in ln for p in D_PATTERNS)]
        ok = not resolved and not named
        detail = (f"getent resolves {resolved or 'neither'}; {len(named)} of {len(lines)} unit log lines "
                  f"since the start name {', '.join(D_PATTERNS)}")
        if named:
            detail += ": " + " | ".join(ln[:200] for ln in named[:3])
        return CheckResult("D", ok, detail, {"resolved": resolved, "log_lines": [ln[:500] for ln in named[:20]]})

    def warehouse_of(self, run: RunRecord) -> str:
        if run.plan_uri:
            m = re.search(r"/wh/([^/]+)/", run.plan_uri)
            return m.group(1) if m else self.default_warehouse
        return self.warehouse_name or self.default_warehouse

    def _catalog_get(self, path: str) -> tuple[int, Any]:
        url = f"{self.catalog_uri}{path}"
        p = self._docker("exec", self.dashboard_container, "curl", "-s", "-w", "\n%{http_code}", url)
        if p.returncode != 0:
            return 0, p.stdout[:300]
        body, _, code = p.stdout.rpartition("\n")
        try:
            return int(code), json.loads(body) if body.strip() else None
        except ValueError:
            return int(code) if code.isdigit() else 0, body[:300]

    def plan_table_refs(self, warehouse: str, wid: int, eid: int) -> tuple[dict | None, str]:
        code, cfg = self._catalog_get(f"/v1/config?warehouse={warehouse}")
        if code != 200 or not isinstance(cfg, dict):
            return None, f"catalog config for warehouse {warehouse}: HTTP {code} {str(cfg)[:200]}"
        prefix = (cfg.get("overrides") or {}).get("prefix") or (cfg.get("defaults") or {}).get("prefix")
        base = f"/v1/{prefix}" if prefix else "/v1"
        table = f"wid_{wid}_eid_{eid}_plan"
        code, body = self._catalog_get(f"{base}/namespaces/{self.plan_namespace}/tables/{table}")
        if code == 200 and isinstance(body, dict):
            return (body.get("metadata") or {}).get("refs") or {}, f"{warehouse}.{self.plan_namespace}.{table}"
        code_ns, ns = self._catalog_get(f"{base}/namespaces")
        names = [".".join(n) for n in (ns or {}).get("namespaces", [])] if isinstance(ns, dict) else ns
        return None, (f"{warehouse}.{self.plan_namespace}.{table}: HTTP {code} "
                      f"{(body or {}).get('error', {}).get('message', '') if isinstance(body, dict) else body}; "
                      f"namespaces in {warehouse}: {names}")

    def _check_e(self, started: list[RunRecord]) -> CheckResult:
        if not started:
            return CheckResult("E", True, "no run of this scenario was started on the unit", {"vacuous": True})
        found, missing = [], []
        for run in started:
            refs, where = self.plan_table_refs(self.warehouse_of(run), run.wid, run.eid)
            if refs is not None and "started" in refs:
                found.append(f"{where} started@{refs['started'].get('snapshot-id')}")
            elif refs is not None:
                missing.append(f"{where} has refs {sorted(refs)} but no `started`")
            else:
                missing.append(where)
        return CheckResult("E", not missing, "; ".join(found + missing)[:1500],
                           {"found": found, "missing": missing})

    # ---------------------------------------------------------------- the end

    def final_check(self, wids: Iterable[int]) -> dict:
        """No row of this run's workflows is left at status 0, except the ones a
        scenario left there on purpose (refused starts)."""
        ids = sorted({int(w) for w in wids if w})
        if not ids:
            return {"ok": True, "detail": "no workflows", "left": []}
        p = self._psql("SELECT e.eid, v.wid FROM texera_db.workflow_executions e JOIN "
                       "texera_db.workflow_version v ON e.vid = v.vid WHERE e.status = 0 AND v.wid IN ("
                       + ",".join(str(i) for i in ids) + ") ORDER BY e.eid")
        if p.returncode != 0:
            return {"ok": False, "detail": f"psql failed: {p.stdout[:300]}", "left": []}
        rows = [tuple(int(x) for x in ln.split("|")) for ln in p.stdout.split() if "|" in ln]
        left = [{"eid": e, "wid": w, "allowed": self.allowed_status_zero.get(e)} for e, w in rows]
        bad = [r for r in left if not r["allowed"]]
        return {"ok": not bad, "left": left,
                "detail": (f"{len(left)} row(s) at status 0, {len(bad)} not refused on purpose: "
                           f"{[r['eid'] for r in bad]}" if left else "no row left at status 0")}


def evaluate(results: dict[str, CheckResult], required: Sequence[str],
             negative_control: bool) -> tuple[list[tuple[str, bool, str]], dict]:
    """Turn check results into (name, ok, detail) gate checks plus an info dict.

    Normal mode: each required check gates (not evaluable counts as failed); the
    others are information. Negative control: A, D and F must have failed."""
    gates: list[tuple[str, bool, str]] = []
    info: dict[str, Any] = {}
    for key in CHECKS:
        r = results.get(key)
        if r is None:
            continue
        entry = {"ok": r.ok, "detail": r.detail}
        if negative_control and key in NEGATIVE_CONTROLS:
            ok = r.ok is False
            gates.append((f"control {key} fails as expected ({CONTROL_REASONS[key]})", ok,
                          ("failed as expected: " if ok else
                           ("NOT EVALUABLE: " if r.ok is None else "PASSED, so the control proves nothing: "))
                          + r.detail))
        elif not negative_control and key in required:
            gates.append((f"evidence {key}: {CHECK_TITLES[key]}", r.ok is True,
                          ("not evaluable: " if r.ok is None else "") + r.detail))
        info[key] = entry
    return gates, info


def parse_checks(spec: str | None) -> list[str]:
    if spec is None:
        return []
    items = [s.strip().upper() for s in spec.replace(" ", ",").split(",") if s.strip()]
    if items in (["ALL"], []):
        return list(CHECKS)
    bad = [c for c in items if c not in CHECKS]
    if bad:
        raise SystemExit(f"--evidence takes checks among {','.join(CHECKS)}; got {','.join(bad)}")
    return [c for c in CHECKS if c in items]


def read_env_file(path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in open(path, encoding="utf-8"):
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line.rstrip("\n"))
            if m:
                out[m.group(1)] = m.group(2)
    except OSError:
        pass
    return out


def new_run_id() -> str:
    return uuid.uuid4().hex[:8]


def quote(s: str) -> str:
    return shlex.quote(s)
