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
     app=texera-dashboard, and not from one of the unit's addresses
  D  (needs --isolate-unit) the unit resolves neither file-service nor
     texera-lakefs, its log since the start names none of them, and the gateway
     (nginx, whose access log --isolate-unit turns on) served it no request
  E  the execution's plan table (Lakekeeper, namespace execution-plan) has a
     ref named `started`
  F  every statement from the unit's addresses carries app=texera-computing-unit

A run counts as started when a state arrived on its socket after its start was
sent (the transport keeps what the unit replays at connection apart). A refused
start must leave the unit silent: no unit statement at all from its start mark to
a mark taken after the refusal and a settle (`expect_silent_since_start`).

With --negative-control (published images, the old unit) A, D and F must fail, each
for its own reason (A on a unit SELECT/WITH, D on the unit's log naming
file-service or texera-lakefs while neither resolves, F on unnamed statements from
the unit's address); another failure is reported as "control inconclusive".

Step 3 (its design, section 7 H4) adds checks about the record a run leaves in the
lake. They are evaluated only when asked for (a step-3 gate, or --evidence naming
them), so a step-2 gate reads and reports exactly what it did:

  I  for every run that was started and has ended: the execution log's label names
     the ending; the log holds one row per seq up to the label's; and the log, the
     statistics and the console table hold one data file and one snapshot each (the
     end tidy). Read from the catalog (lake.py), as Check E reads the plan table
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

from lake import DEFAULT_CATALOG_URI, DEFAULT_WAREHOUSE, Catalog, Label, Lake, TableState, docker_fetch

UNIT_APP = "texera-computing-unit"
DASHBOARD_APP = "texera-dashboard"
EXECUTION_DB = "texera_db"
RUN_STATE_TABLES = frozenset({"workflow_executions", "operator_port_executions", "operator_executions"})
STATUS_STARTED = frozenset({1, 4, 5})   # RUNNING, or an early FAILED / KILLED
STATUS_TERMINAL = frozenset({3, 4, 5})  # COMPLETED, FAILED, KILLED
D_HOSTS = ("file-service", "texera-lakefs")
D_PATTERNS = ("file-service", "texera-lakefs", ":9092", ":8000/api/v1")
#: step 2's checks: what `--evidence` means without a list
CHECKS = ("A", "B", "C", "D", "E", "F")
#: step 3's checks: evaluated only when a gate or `--evidence` names them
STEP3_CHECKS = ("I",)
ALL_CHECKS = CHECKS + STEP3_CHECKS
NEGATIVE_CONTROLS = ("A", "D", "F")
CHECK_TITLES = {
    "A": "the unit only writes run state while starting (no SELECT/WITH; INSERT/UPDATE on the "
         "three run-state tables)",
    "B": "from start to its terminal status the unit touches only the run-state tables",
    "C": "the execution row is inserted by app=texera-dashboard",
    "D": "the unit reaches neither file-service nor LakeFS",
    "E": "the execution's plan table carries the `started` tag",
    "F": "every statement from the unit's addresses carries app=texera-computing-unit",
    "I": "the record of every ended run is whole and tidied in the lake",
}
CONTROL_REASONS = {
    "A": "the old unit SELECTs while starting",
    "D": "the old unit names file-service",
    "F": "the old unit's connections carry no name; its statements are found by its address",
}
#: the names whose appearance in the unit's log makes the D control fail for its reason
D_CONTROL_NAMES = ("file-service", "texera-lakefs")
DEFAULT_CONTAINERS = {
    "postgres": "sce-texera-postgres",
    "workflow-runtime-coordinator-service": "sce-workflow-runtime-coordinator-service",
    "dashboard-service": "sce-dashboard-service",
    "nginx": "sce-texera-nginx",
}
CLEANUP_ENV = "WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS"
DEFAULT_CLEANUP_S = 30  # the unit's default without the env (application.conf)
PLAN_NAMESPACE_ENV = "STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE"
DEFAULT_PLAN_NAMESPACE = "execution-plan"
CLEANUP_WAIT_S = 15.0
#: the unit counts as settled after this long without a statement of its own
QUIET_S = 1.0
#: Check I: a run's row and label land a moment after its state, and the end tidy after
#: that; its tables are read until they are settled, for at most this long
RECORD_SETTLE_S = 15.0
RECORD_POLL_S = 0.5
#: the states the execution log holds, by the name a socket is told (design D2; READY
#: reaches a socket as "Initializing", and Pausing and Resuming are not logged, D6)
LOGGED_STATES = {"Initializing": "READY", "Running": "RUNNING", "Paused": "PAUSED",
                 "Completed": "COMPLETED", "Failed": "FAILED", "Killed": "KILLED"}
END_STATES = ("Completed", "Failed", "Killed")
#: the gateway's access log line (stack/sce_stack.py writes it with --isolate-unit);
#: $uri carries no query string, so no token reaches the log
GATEWAY_ACCESS = re.compile(r'sce-access (?P<addr>\S+) "(?P<method>[A-Z]+) (?P<uri>[^"]*)" (?P<status>\d{3})')


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
    gateway_log_cursor: int | None = None
    handle: Any = None
    #: len(handle.state_log) when the start was about to be sent
    state_index: int | None = None
    started: bool | None = None  # set explicitly by callers without a handle (REST runs)
    #: the state the run ended in, for a caller without a handle ("Completed", ...)
    final_state: str | None = None

    def has_started(self) -> bool:
        """The unit accepted this start: a state other than the handshake's arrived on
        its socket after the start was sent. What the unit replays of the workflow's
        earlier run arrives before (the transport ends the open sequence first), and
        a refused start gets only an error event."""
        if self.started is not None:
            return self.started
        if self.handle is None or self.start_mark is None:
            return False
        try:
            log = list(self.handle.state_log)
        except Exception:  # noqa: BLE001
            return False
        return any(s != "Uninitialized" for _, s in log[self.state_index or 0:])

    def states(self) -> list[str]:
        """What the unit reported on the run's socket after its start was sent."""
        if self.handle is None:
            return [self.final_state] if self.final_state else []
        try:
            return [s for _, s in list(self.handle.state_log)[self.state_index or 0:]]
        except Exception:  # noqa: BLE001
            return []

    def ended_state(self) -> str | None:
        """The state the run ended in, or None while the driver has not seen it end."""
        states = self.states()
        return states[-1] if states and states[-1] in END_STATES else None

    def printed(self) -> bool:
        """Whether the run sent console output (which the recorder then stored)."""
        try:
            return self.handle is not None and bool(self.handle.console())
        except Exception:  # noqa: BLE001
            return False

    def to_json(self) -> dict:
        return {"wid": self.wid, "cuid": self.cuid, "eid": self.eid, "plan_uri": self.plan_uri,
                "create_mark": self.create_mark, "start_mark": self.start_mark,
                "state_index": self.state_index, "started": self.has_started()}


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
                 cleanup_wait_s: float = CLEANUP_WAIT_S, quiet_s: float = QUIET_S,
                 record_settle_s: float = RECORD_SETTLE_S):
        self.run_id = run_id
        self.required = [c for c in ALL_CHECKS if c in set(required)]
        self.negative_control = negative_control
        c = dict(DEFAULT_CONTAINERS)
        c.update(containers or {})
        self.pg_container = c["postgres"]
        self.unit_container = c["workflow-runtime-coordinator-service"]
        self.dashboard_container = c["dashboard-service"]
        self.gateway_container = c["nginx"]
        self.env = env or {}
        self.catalog_uri = self.env.get("STORAGE_ICEBERG_CATALOG_REST_URI", DEFAULT_CATALOG_URI).rstrip("/")
        self.default_warehouse = self.env.get("STORAGE_ICEBERG_CATALOG_REST_WAREHOUSE_NAME", DEFAULT_WAREHOUSE)
        self._log = log
        self._run = runner
        self.catalog = Catalog(docker_fetch(runner, self.dashboard_container, self.catalog_uri))
        self.lake = Lake(self.catalog, self.default_warehouse, self.env)
        self.record_settle_s = record_settle_s
        self.cleanup_wait_s = cleanup_wait_s
        self.quiet_s = quiet_s
        self.pg = PgLog()
        self.pg_log = ContainerLog(self.pg_container, runner)
        self.unit_log = ContainerLog(self.unit_container, runner)
        self.gateway_log = ContainerLog(self.gateway_container, runner)
        self.unit_hosts: set[str] = set()
        self.isolated = False
        self.unit_env: dict[str, str] = {}
        self.plan_namespace = DEFAULT_PLAN_NAMESPACE
        self._seq = 0
        self.scenario: str | None = None
        self.runs: list[RunRecord] = []
        self._begin_mark: str | None = None
        self._previous_started: dict[int, int] = {}  # wid -> last started eid, for the cleanup wait
        self._previous_touched = False  # the previous scenario sent a start to the unit
        self._previous_ended_at: float | None = None  # monotonic time of its end mark
        self._expect_no_unit: list[tuple[int, str, bool]] = []
        self._expect_silent: list[tuple[int, str, str, str]] = []
        #: Check I: the verdict on each ended run's record, by eid, once it is judged
        self._records: dict[int, dict] = {}
        #: eid -> why its tables were left as they were (its unit was stopped or lost)
        self._untidied: dict[int, str] = {}
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
        self.lake = Lake(self.catalog, self.default_warehouse, {**self.env, **self.unit_env})
        cleanup = self.unit_env.get(CLEANUP_ENV)
        self.info = {
            "postgres_container": self.pg_container,
            "unit_container": self.unit_container,
            "gateway_container": self.gateway_container,
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

    @property
    def cleanup_seconds(self) -> int:
        """The unit's idle cleanup delay (its env, else the unit's default)."""
        v = self.unit_env.get(CLEANUP_ENV, "")
        return int(v) if v.isdigit() else DEFAULT_CLEANUP_S

    def begin_scenario(self, key: str) -> dict:
        """Wait for the previous scenario's idle cleanup (see _wait_for_cleanup), then mark."""
        waited = self._wait_for_cleanup()
        self.scenario = key
        self.runs = []
        self._expect_no_unit = []
        self._expect_silent = []
        self._records = {}
        self._untidied = {}
        self._begin_mark = self.mark(key, "begin")
        return waited

    def _wait_for_cleanup(self) -> dict:
        """After a scenario that sent a start to the unit: its sockets closed just before
        its end mark, and the unit cleans the workflow `cleanup_seconds` later (a SELECT or
        two, the DELETEs of operator_port_executions and operator_executions, then a
        SELECT of runtime_stats_uri). Wait until the cleanup DELETE of every started eid
        appeared, the cleanup delay (+0.5 s) has passed since the end mark, and the unit
        has been quiet for `quiet_s`; at most `cleanup_wait_s`. Then the cleanup lands in no
        window of the next scenario."""
        pending = sorted(set(self._previous_started.values()))
        touched, ended_at = self._previous_touched, self._previous_ended_at
        self._previous_started, self._previous_touched = {}, False
        if not pending and not touched:
            return {}
        after = self.pg.find_mark(self._begin_mark) if self._begin_mark else None
        not_before = (ended_at + self.cleanup_seconds + 0.5) if ended_at is not None else None
        out = self._wait_unit(after_seq=after.seq if after else -1, deletes=pending,
                              not_before=not_before, timeout=self.cleanup_wait_s)
        missing = [e for e in pending if not isinstance(out["cleanup_deletes"].get(str(e)), float)]
        if missing:
            self._log(f"evidence: the unit's idle cleanup of execution(s) {missing} did not appear "
                      f"within {self.cleanup_wait_s:.0f} s")
        if not out["quiet"]:
            self._log(f"evidence: the unit was not quiet for {self.quiet_s:g} s within "
                      f"{self.cleanup_wait_s:.0f} s; its statements may reach the next windows")
        return out

    def _wait_unit(self, *, after_seq: int, deletes: Sequence[int] = (), not_before: float | None = None,
                   quiet_s: float | None = None, timeout: float = CLEANUP_WAIT_S) -> dict:
        """Poll the log until the cleanup DELETE of each eid in `deletes` appeared after
        statement `after_seq`, the clock passed `not_before`, and no new unit statement
        appeared for `quiet_s`; at most `timeout` seconds."""
        want = set(deletes)
        quiet_s = self.quiet_s if quiet_s is None else quiet_s
        t0 = time.monotonic()
        deadline = t0 + timeout
        seen: dict[int, float] = {}
        last_unit = t0
        self.refresh_log()
        polled = len(self.pg.stmts)
        while True:
            now = time.monotonic()
            if want - set(seen):
                for st in self.pg.stmts[after_seq + 1:]:
                    if self.is_unit(st):
                        for eid in want - set(seen):
                            if st.is_cleanup_delete(eid):
                                seen[eid] = round(now - t0, 1)
            quiet = now - last_unit >= quiet_s
            done = set(seen) == want and (not_before is None or now >= not_before) and quiet
            if done or now >= deadline:
                break
            time.sleep(0.25)
            self.refresh_log()
            if any(s.relevant and self.is_unit(s) for s in self.pg.stmts[polled:]):
                last_unit = time.monotonic()
            polled = len(self.pg.stmts)
        return {"waited_s": round(time.monotonic() - t0, 1), "quiet": quiet, "timed_out": not done,
                "cleanup_deletes": {str(e): seen.get(e, f"not seen within {timeout:.0f} s")
                                    for e in sorted(want)}}

    def settle_unit(self, *, min_wait_s: float = 0.0, quiet_s: float | None = None,
                    timeout: float = CLEANUP_WAIT_S) -> dict:
        """Wait until at least `min_wait_s` passed and the unit has run no statement for
        `quiet_s`: the trailing statements of a finished run (result sizes, statistics,
        console URIs) or its idle cleanup then cannot fall into the window that follows."""
        quiet_s = self.quiet_s if quiet_s is None else quiet_s
        self.refresh_log()
        out = self._wait_unit(after_seq=len(self.pg.stmts) - 1, not_before=time.monotonic() + min_wait_s,
                              quiet_s=quiet_s, timeout=max(timeout, min_wait_s + quiet_s + 1))
        out.pop("cleanup_deletes", None)
        if not out["quiet"]:
            self._log(f"evidence: the unit was still running statements after {out['waited_s']} s")
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
            if run.handle is not None:
                try:
                    run.state_index = len(run.handle.state_log)
                except Exception:  # noqa: BLE001
                    run.state_index = None
            run.start_mark = self.mark(self.scenario, "start", run.eid)
            try:
                run.unit_log_cursor = self.unit_log.cursor()
            except EvidenceUnavailable as e:
                self._log(f"evidence: {e}")
            if self.isolated:
                try:
                    run.gateway_log_cursor = self.gateway_log.cursor()
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

    def expect_silent_since_start(self, eid: int, why: str) -> str | None:
        """A refused start (D33: it writes no state and leaves every store alone): from
        the last start mark of `eid` to a mark taken now, after the refusal arrived and
        the caller's settle, the unit runs no statement at all, whatever it names.
        Callers make sure nothing else runs on the unit then (the previous cleanup was
        waited out, the sockets are open, a finished run's trailing statements were
        settled before the start). Returns the closing mark's id."""
        run = next((r for r in reversed(self.runs) if r.eid == eid and r.start_mark), None)
        if run is None:
            self._log(f"evidence: no start of execution {eid} in this scenario to check silence after")
            return None
        until = self.mark(self.scenario or "?", "settled", eid)
        self._expect_silent.append((eid, run.start_mark, until, why))
        return until

    def allow_status_zero(self, eid: int, why: str) -> None:
        self.allowed_status_zero[eid] = why

    def allow_untidied(self, eid: int, why: str) -> None:
        """Check I does not count the data files and snapshots of this execution's tables:
        a unit that was stopped or lost does not finish its last tidy."""
        self._untidied[eid] = why

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

    # ------------------------------------------------------- Check I: the record

    def settle_records(self) -> None:
        """Judge now the record of every run of this scenario that has ended and is not
        judged yet. The scenario runner calls it while the scenario's sockets are still
        open, so the unit still holds its runs; a scenario calls it before it does
        something that changes a finished run's tables (it takes the unit down while an
        end tidy may still run, or waits for results to expire)."""
        if "I" not in self.required:
            return
        for run in self.runs:
            if (run.start_mark and run.eid is not None and run.eid not in self._records
                    and run.has_started() and run.ended_state()):
                self._records[run.eid] = self._judge_record(run)

    def _judge_record(self, run: RunRecord) -> dict:
        """Read the run's log, statistics and console table until nothing is wrong with
        them, for at most `record_settle_s`: the ending's row and the end tidy land a
        moment after the state reached the socket."""
        t0 = time.monotonic()
        while True:
            problems, facts = self._record_problems(run)
            waited = time.monotonic() - t0
            if not problems or waited >= self.record_settle_s:
                return {"eid": run.eid, "ok": None if facts.get("unreadable") else not problems,
                        "problems": problems, "waited_s": round(waited, 1), **facts}
            time.sleep(min(RECORD_POLL_S, self.record_settle_s / 10))

    def _record_problems(self, run: RunRecord) -> tuple[list[str], dict]:
        """What is wrong with the record of a run that ended, and what was read."""
        warehouse = self.warehouse_of(run)
        tables = {kind: self.lake.table(warehouse, run.wid, run.eid, kind)
                  for kind in ("log", "statistics", "console")}
        facts: dict[str, Any] = {"tables": {kind: t.describe() for kind, t in tables.items()}}
        unreadable = [t.describe() for t in tables.values() if t.error]
        if unreadable:
            return unreadable, {**facts, "unreadable": True}
        log = tables["log"]
        if not log.exists:
            return [f"no execution log ({log.where})"], facts
        label, want = Label.of(log), LOGGED_STATES[run.ended_state()]
        facts["label"] = {"state": label.state, "state_seq": label.state_seq, "reason": label.reason}
        problems = []
        if label.state != want:
            problems.append(f"the log's label says {label.state}, the run ended {want}")
        if label.state_seq != log.records:
            ahead = (label.state_seq or 0) > (log.records or 0)
            problems.append(
                f"the label names seq {label.state_seq} and the log holds {log.records} row(s): "
                + ("the label is ahead of its rows, or a seq was skipped" if ahead else
                   "more rows than seq (a row landed twice, which a retried append may; or a seq "
                   "was skipped and another repeated)"))
        if run.eid in self._untidied:
            facts["untidied"] = self._untidied[run.eid]
            return problems, facts
        # a run that never ran (its environment could not be installed) may have no statistics
        ran = "Running" in run.states() or run.handle is None
        problems += self._untidy(log, "the log", written=True)
        problems += self._untidy(tables["statistics"], "the statistics table", written=True if ran else None)
        problems += self._console_problems(run, tables["console"], warehouse, facts)
        return problems, facts

    @staticmethod
    def _untidy(table: TableState, what: str, written: bool | None) -> list[str]:
        """Why `table` is not as the end tidy leaves it. `written` True: something was
        written to it, so it holds one data file and one snapshot. False: nothing was, so
        it holds no row. None: the driver cannot tell, so either."""
        if not table.exists:
            return [f"{what} is missing ({table.where})"]
        if written is False:
            return [f"{what} holds {table.records} row(s) of a run that wrote none"] if table.records else []
        counts = (table.data_files, table.snapshots)
        if counts == (1, 1) or (written is None and counts == (0, 0)):
            return []
        return [f"{what} holds {table.data_files} data file(s) and {table.snapshots} snapshot(s), "
                f"not one of each"]

    def _console_problems(self, run: RunRecord, console: TableState, warehouse: str, facts: dict) -> list[str]:
        """The console table goes when the execution's results go: with the unit's idle
        clean-up until step 3's sub-part 14, with the Dashboard's expiry after it (D31).
        One that is gone together with the results can no longer be judged; one that is
        gone while they are still there is missing."""
        if console.exists:
            return self._untidy(console, "the console table", written=run.printed())
        results, why = self.lake.port_tables(warehouse, run.wid, run.eid, "result")
        if results == []:
            facts["console"] = "not judged: it is gone, and so are the execution's results (cleared or expired)"
            return []
        return [f"the console table is missing ({console.where}) while "
                + (f"{len(results)} result table(s) of the execution are still there" if results
                   else f"its results cannot be listed: {why}")]

    def _check_i(self, started: list[RunRecord]) -> CheckResult:
        self.settle_records()
        verdicts = [self._records[r.eid] for r in started if r.eid in self._records]
        if not verdicts:
            return CheckResult("I", True, "no run of this scenario was started and has ended", {"vacuous": True})

        def line(v: dict) -> str:
            if v["problems"]:
                return f"execution {v['eid']}: " + "; ".join(v["problems"]) + f" (after {v['waited_s']} s)"
            label = v.get("label") or {}
            return (f"execution {v['eid']}: {label.get('state')} at seq {label.get('state_seq')}, "
                    + ("tables left as they were: " + v["untidied"] if v.get("untidied")
                       else "one data file and one snapshot per table written to"))

        ok: bool | None = all(v["ok"] for v in verdicts)
        if any(v["ok"] is None for v in verdicts):
            ok = None
        return CheckResult("I", ok, "; ".join(line(v) for v in verdicts)[:1500], {"records": verdicts})

    # ------------------------------------------------------------- the checks

    def _evaluated(self) -> list[str]:
        """The checks a scenario's end evaluates: step 2's always, step 3's when required."""
        return [c for c in ALL_CHECKS if c in CHECKS or c in self.required]

    def end_scenario(self, resolve_eid: Callable[[RunRecord], int | None] | None = None) -> dict:
        """Mark the end, read the log and evaluate every check for this scenario.
        Returns {"checks": {key: CheckResult}, "report": {...}}."""
        key = self.scenario or "?"
        end_id = self.mark(key, "end")
        self._previous_ended_at = time.monotonic()
        self._previous_touched = any(r.start_mark for r in self.runs)
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
            for c in self._evaluated():
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
                                       {"offending": [s.to_json(400) for s in a_bad[:50]],
                                        "select_offenders": sum(s.verb in ("select", "with") for s in a_bad),
                                        "window_notes": window_notes})
            results["B"] = CheckResult("B", not b_bad, summarize(b_bad, b_all) + "; tables: "
                                       + ", ".join(sorted({t for s in b_bad for t in s.tables})[:12]),
                                       {"offending": [s.to_json(400) for s in b_bad[:50]]})

        inserts = [s for s in scen if s.norm.startswith("insert into workflow_executions")]
        created = [r for r in self.runs if r.create_mark]
        # the name alone is not enough: a unit connection named after the Dashboard is still the unit
        not_dash = [s for s in inserts if s.app != DASHBOARD_APP or s.host in self.unit_hosts]
        if not inserts:
            results["C"] = CheckResult("C", not created or all(r.eid is None for r in created),
                                       "no INSERT INTO workflow_executions in the scenario"
                                       + (f" although {len(created)} execution(s) were created"
                                          if created and any(r.eid for r in created) else ""),
                                       {"vacuous": True})
        else:
            results["C"] = CheckResult("C", not not_dash,
                                       f"{len(inserts)} INSERT INTO workflow_executions, from "
                                       + ", ".join(sorted({f"{s.app or '-'}@{s.host or '-'}" for s in inserts}))
                                       + (f"; {len(not_dash)} not the Dashboard's (another app, or a unit "
                                          f"address {sorted(self.unit_hosts)})" if not_dash else ""),
                                       {"inserts": [s.to_json(300) for s in inserts]})

        results["D"] = self._check_d(started)
        results["E"] = self._check_e(started)
        if "I" in self.required:
            results["I"] = self._check_i(started)

        from_unit_addr = [s for s in scen if s.host in self.unit_hosts]
        unnamed = [s for s in from_unit_addr if s.app != UNIT_APP]
        named_elsewhere = [s for s in scen if s.app == UNIT_APP and s.host not in self.unit_hosts]
        if not self.unit_hosts:
            results["F"] = CheckResult("F", None, "the unit's addresses are unknown")
        elif not from_unit_addr and named_elsewhere:
            results["F"] = CheckResult(
                "F", None, f"not evaluable: {len(named_elsewhere)} statements carry app={UNIT_APP} from "
                           f"{sorted({s.host for s in named_elsewhere})}, none from the unit's addresses "
                           f"{sorted(self.unit_hosts)} (stale or wrong addresses: was the unit recreated "
                           f"after the preflight?)",
                {"named_elsewhere": [s.to_json(300) for s in named_elsewhere[:10]]})
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
        # refused starts: the unit silent from the start mark to the settled mark
        silent = []
        for eid, start_id, until_id, why in self._expect_silent:
            a, b = self._mark_stmt(start_id), self._mark_stmt(until_id)
            if a is None or b is None:
                silent.append({"eid": eid, "why": why, "ok": False, "statements": [],
                               "detail": "the start or settled mark is not in the log"})
                continue
            hits = [s for s in self._window(a, b) if self.is_unit(s)]
            silent.append({"eid": eid, "why": why, "ok": not hits, "statements": [s.to_json(300) for s in hits[:10]],
                           "detail": f"{len(hits)} unit statement(s) between the start and the settled mark"})
        report["unit_silent_after_refused_start"] = silent
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
        # The gateway: an isolated unit still reaches nginx, which proxies file-service
        # (/api/dataset, ...) and the Dashboard (/api/). Every request it served to one
        # of the unit's addresses since the start counts against D.
        gw_cursor = min((r.gateway_log_cursor for r in started if r.gateway_log_cursor is not None),
                        default=None)
        access = ([m for m in (GATEWAY_ACCESS.search(ln) for ln in self.gateway_log.since(gw_cursor)) if m]
                  if gw_cursor is not None else [])
        via_gateway = [f"{m['method']} {m['uri']} -> {m['status']}" for m in access
                       if m["addr"] in self.unit_hosts]
        gateway = (f"the gateway served {len(via_gateway)} of {len(access)} requests since the start to "
                   f"the unit" if access else
                   "the gateway's access log is not readable (unknown start position, or no request "
                   "logged: its access log is on only in stacks generated with --isolate-unit)")
        if resolved or named or via_gateway:
            ok: bool | None = False
        else:
            ok = True if access else None  # nothing seen, but the gateway part is unknown
        detail = (("not evaluable: " if ok is None else "")
                  + f"getent resolves {resolved or 'neither'}; {len(named)} of {len(lines)} unit log lines "
                    f"since the start name {', '.join(D_PATTERNS)}; {gateway}")
        if named:
            detail += ": " + " | ".join(ln[:200] for ln in named[:3])
        if via_gateway:
            detail += "; via the gateway: " + " | ".join(via_gateway[:5])
        return CheckResult("D", ok, detail, {"resolved": resolved, "log_lines": [ln[:500] for ln in named[:20]],
                                             "via_gateway": via_gateway[:20], "gateway_lines": len(access)})

    def warehouse_of(self, run: RunRecord) -> str:
        if run.plan_uri:
            m = re.search(r"/wh/([^/]+)/", run.plan_uri)
            return m.group(1) if m else self.default_warehouse
        return self.warehouse_name or self.default_warehouse

    def plan_table_refs(self, warehouse: str, wid: int, eid: int) -> tuple[dict | None, str]:
        base, why = self.catalog.base(warehouse)
        if base is None:
            return None, why
        table = f"wid_{wid}_eid_{eid}_plan"
        code, body = self.catalog.get(f"{base}/namespaces/{self.plan_namespace}/tables/{table}")
        if code == 200 and isinstance(body, dict):
            return (body.get("metadata") or {}).get("refs") or {}, f"{warehouse}.{self.plan_namespace}.{table}"
        code_ns, ns = self.catalog.get(f"{base}/namespaces")
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


def control_failed_for_its_reason(key: str, r: CheckResult) -> tuple[bool, str]:
    """Whether a failed negative control failed for the reason the control is about
    (design H5), not for another one (broken attribution, a name that resolves)."""
    d = r.data or {}
    if key == "A":
        return (d.get("select_offenders", 0) > 0,
                "A failed, but on no unit SELECT or WITH in the start window")
    if key == "D":
        on_names = any(n in ln for ln in d.get("log_lines") or [] for n in D_CONTROL_NAMES)
        if d.get("resolved"):
            return False, f"D failed, but getent resolves {d.get('resolved')} (the unit is not isolated)"
        return on_names, f"D failed, but on no unit log line naming {' or '.join(D_CONTROL_NAMES)}"
    if key == "F":
        return bool(d.get("unnamed")), "F failed, but on no unnamed statement from the unit's address"
    return True, ""


def evaluate(results: dict[str, CheckResult], required: Sequence[str],
             negative_control: bool) -> tuple[list[tuple[str, bool, str]], dict]:
    """Turn check results into (name, ok, detail) gate checks plus an info dict.

    Normal mode: each required check gates (not evaluable counts as failed); the
    others are information. Negative control: A, D and F must have failed, each for
    its own reason (control_failed_for_its_reason); any other failure is reported as
    "control inconclusive" and fails the gate."""
    gates: list[tuple[str, bool, str]] = []
    info: dict[str, Any] = {}
    for key in ALL_CHECKS:
        r = results.get(key)
        if r is None:
            continue
        entry = {"ok": r.ok, "detail": r.detail}
        if negative_control and key in NEGATIVE_CONTROLS:
            if r.ok is False:
                reason_ok, why = control_failed_for_its_reason(key, r)
                ok = reason_ok
                prefix = "failed as expected: " if ok else f"control inconclusive ({why}): "
            else:
                ok = False
                prefix = "NOT EVALUABLE: " if r.ok is None else "PASSED, so the control proves nothing: "
            gates.append((f"control {key} fails as expected ({CONTROL_REASONS[key]})", ok, prefix + r.detail))
        elif not negative_control and key in required:
            gates.append((f"evidence {key}: {CHECK_TITLES[key]}", r.ok is True,
                          ("not evaluable: " if r.ok is None else "") + r.detail))
        info[key] = entry
    return gates, info


def parse_checks(spec: str | None) -> list[str]:
    """The checks a spec names; `all` (or nothing) is step 2's six."""
    if spec is None:
        return []
    items = [s.strip().upper() for s in spec.replace(" ", ",").split(",") if s.strip()]
    if items in (["ALL"], []):
        return list(CHECKS)
    bad = [c for c in items if c not in ALL_CHECKS]
    if bad:
        raise SystemExit(f"--evidence takes checks among {','.join(ALL_CHECKS)}; got {','.join(bad)}")
    return [c for c in ALL_CHECKS if c in items]


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
