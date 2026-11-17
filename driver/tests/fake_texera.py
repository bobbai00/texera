"""A fake Texera speaking the step-2 protocol of the design (sections 3.4-3.8), for
offline tests of the driver: REST (login, users, workflows, units, warehouses,
POST /api/executions, POST /api/executions/{eid}/updates, environments, the
unit's POST /api/execution/{eid}/run) and websockets (/wsapi/workflow-websocket
with WorkflowStartRequest / OperatorUpdateRequest and the old
WorkflowExecuteRequest / ModifyLogicRequest, /wsapi/pve).

Where the product's code differs from the design it follows the code, as it is after
the review fixes of step 2 (docs/review-step2 in the main worktree, reports X1, X3 and
X4). The Dashboard: a created execution has a status of its own, Created (6), until
its unit's first write; a create answers 201 {eid, planUri}, a workflow that does not
compile 400 {code, message, eid, operatorErrors}, a stored change 201; a create clears
an ended execution's results only once a later execution of the workflow on the unit
has results of its own. The unit: what it does not do of what a session asked, it
answers to that session alone as a RequestRefusedEvent, in sentences, and a
WorkflowErrorEvent carries only a run's errors; a pause, a resume and a kill name
their execution and are refused unless the unit holds its run; a failed environment
install is the run's error and not a console message. The old WorkflowExecuteRequest
and ModifyLogicRequest are the published images' unit, which the `ws` transport and
step 2's negative control are for: a run started that way takes the old frames.

It emulates just enough of an engine to give exact rows for the harness's small
workflows (CSV scan, Text Input, Filter, Projection, the tagging and tabulate
UDFs, File Lister -> File Scan From Input). Everything it receives is recorded,
so tests assert the wire shapes. It is a model of the design, not of Texera: a
check that passes here proves the driver follows the design, not that a branch
does.

What it copies from the real unit (WorkflowWebsocketResource.myOnOpen, seen on
step2wip 2026-11-16): a socket opens with WorkflowStateEvent "Uninitialized"; then,
REPLAY_DELAY_S later, the replay of the run the (workflow, unit) holds (statistics,
console, state, errors); then ClusterStatusUpdateEvent, last. A run is held until
the last socket of its (workflow, unit) closes; `cleanup_s` later the unit cleans
it up. With a `statement_sink` it reports the Postgres statements the design's
services would run (Dashboard: the INSERT at create; unit: the run-state writes and
the idle cleanup; a refused start: nothing), for evidence tests.

`step` chooses the product it models: "2" (the default: the end of step 2, with its
review fixes), or step 3 at one of its harness gates. At "3A" (the step-3 design's
sub-parts 2 to 7) every
run started by id has a recorder (fake_record.py) that writes its log, statistics and
console into the fake lake (fake_lake.py), and the statistics route reads the lake.
The fake engine also sleeps what a UDF's `time.sleep()` asks for, scaled by
`sleep_scale` (0 unless a test sets it), prints what its `print(f"...")` prints, and
fails a run whose UDF raises as its module is loaded, as the real engine does.

At "3B" (sub-parts 9 and 11 to 15) the Dashboard closes executions (fake_closing.py: the
closing record, its timer job, the expiry, the state and log routes, reasons in the
history and the admin's list, sizes on the quota page), a create clears nothing (the
job's expiry replaces an ended execution's results once a later one has started), and
the unit deletes nothing when it lets go of a run. The unit still writes its status to
Postgres.

The unit can be taken down and brought back (`take_unit_down`, `bring_unit_up`), as a
stack's control does it. Killed, it stops where it is: its sockets drop, its runs and
their recorders stop without a word, and what was buffered is lost. Stopped politely
(from "3A" on, design 4.1 step 7), it first ends every run it holds as FAILED, "the
computing unit was stopped", and gives the record 5 s to land. While it is down the
gateway answers 502 for its sockets and its own routes. A unit that is back holds no
run. With `kubernetes` set, each unit is a pod of its own: one unit goes down, a unit
that comes back is a new one, a listing of the units stamps the ones whose pod is gone
as terminated (which closes their executions at the job's next tick), and until "3C"
the gateway sends a statistics request to the unit its `cuid` names.

At "3C" (sub-parts 16 to 19) the unit is off Postgres: it sends no statement and opens
no pool, a Kubernetes unit is given no database login, and it no longer answers a
result page for a workflow whose run it does not hold. The Dashboard serves stored
console output and exports by execution (an export of expired results is 410), and
statistics without a unit in any mode.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import re
import socket
import struct
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from fake_closing import REASON_CHARS, REASON_COMPILE_ERROR, Closing
from fake_lake import FakeLake
from fake_record import NAMESPACES, Recorder, table_name
from record_timing import RecordTiming

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
TUPLE_DELAY_S = 0.004
#: the real unit replayed a held run about 95 ms after the handshake state
REPLAY_DELAY_S = 0.1
STATUS_CODES = {"Uninitialized": 0, "Initializing": 0, "Running": 1, "Paused": 2, "Completed": 3,
                "Failed": 4, "Killed": 5}
#: an execution that was created and that no unit has started
STATUS_CREATED = 6
#: the requests that name their execution: the unit answers for the execution they name
EXECUTION_REQUESTS = ("WorkflowStartRequest", "OperatorUpdateRequest", "WorkflowPauseRequest",
                      "WorkflowResumeRequest", "WorkflowKillRequest")
#: the products the fake models, in order (see the module doc)
STEPS = ("2", "3A", "3B", "3C")
#: the unit's own faults, and those of the routes that serve stored output, for the tests
#: of checks that must fail (the recorder's are in fake_record.FAULTS, the closing
#: Dashboard's in fake_closing.FAULTS)
FAULTS = {
    "created-reads-initializing": "an execution nobody started reads Initializing (0), as before step 2's review",
    "refusal-as-error-event": "a request the unit refuses is answered with a WorkflowErrorEvent, as before "
                              "step 2's review",
    "stale-control": "a pause, a resume or a kill reaches the run the unit holds whatever execution it names",
    "install-failure-on-console": "a failed environment install is also an ERROR message on the consoles",
    "stop-unrecorded": "a unit that is stopped politely records nothing: its runs end as if it was killed",
    "unit-statement": "the unit still writes its run's status to Postgres",
    "unit-pool": "the unit still opens its pool: two idle connections",
    "stored-reads-need-unit": "stored statistics, console output and exports are answered only while the "
                              "unit is up",
    "export-after-expiry": "an export of expired results fails as a missing result does, not with 410",
}
REASON_UNIT_STOPPED = "the computing unit was stopped"
#: how long a unit that is stopping waits for its runs' records to land (design 4.1 step 7)
STOP_AWAIT_S = 5.0
#: the states the execution log holds, by the name a socket is told (design D2, D6)
LOGGED_STATES = {"Initializing": "READY", "Running": "RUNNING", "Paused": "PAUSED",
                 "Completed": "COMPLETED", "Failed": "FAILED", "Killed": "KILLED"}
DEFAULT_WAREHOUSE = "texera"
#: where the services' connections to Postgres come from, and how they are named
UNIT_ADDRESS, DASHBOARD_ADDRESS = "172.30.0.7", "172.30.0.9"
UNIT_APP, DASHBOARD_APP = "texera-computing-unit", "texera-dashboard"
#: what the stack gives the unit to reach Postgres with (the old unit's pool)
UNIT_JDBC_ENV = {"STORAGE_JDBC_URL": "jdbc:postgresql://texera-postgres:5432/texera_db",
                 "STORAGE_JDBC_USERNAME": "texera", "STORAGE_JDBC_PASSWORD": "password"}
#: a slow operator's statistics reach its sockets at least this often
STATS_EVERY_S = 0.2
_PRINT = re.compile(r'print\(f"((?:[^"\\]|\\.)*)"\)')
_SLEEP = re.compile(r"time\.sleep\(([0-9.]+)\)")
#: a raise at module level: the worker cannot load the UDF
_RAISE_ON_LOAD = re.compile(r"^raise \w+\((['\"])(.*?)\1\)", re.M)


def make_token(uid: int, role: str, email: str) -> str:
    def b64(obj) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")
    return f"{b64({'alg': 'none'})}.{b64({'userId': uid, 'role': role, 'email': email, 'sub': email})}.sig"


class WsConn:
    """Server side of one websocket (RFC 6455, unfragmented frames)."""

    def __init__(self, sock: socket.socket, rfile):
        self.sock, self.rfile = sock, rfile
        self.lock = threading.Lock()
        self.closed = False

    def recv(self) -> str | None:
        while True:
            head = self.rfile.read(2)
            if len(head) < 2:
                return None
            op, masked, n = head[0] & 0x0F, head[1] & 0x80, head[1] & 0x7F
            if n == 126:
                n = struct.unpack(">H", self.rfile.read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self.rfile.read(8))[0]
            mask = self.rfile.read(4) if masked else b""
            data = bytearray(self.rfile.read(n))
            if masked:
                for i in range(n):
                    data[i] ^= mask[i % 4]
            if op == 0x8:
                self.close()
                return None
            if op == 0x9:
                self._send(0xA, bytes(data))
                continue
            if op in (0x0, 0x1, 0x2):
                return data.decode()

    def send(self, obj) -> None:
        self._send(0x1, (obj if isinstance(obj, str) else json.dumps(obj)).encode())

    def _send(self, op: int, payload: bytes) -> None:
        n = len(payload)
        head = bytes([0x80 | op])
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack(">H", n)
        else:
            head += bytes([127]) + struct.pack(">Q", n)
        with self.lock:
            if self.closed:
                return
            try:
                self.sock.sendall(head + payload)
            except OSError:
                self.closed = True

    def close(self) -> None:
        with self.lock:
            if self.closed:
                return
            try:
                self.sock.sendall(b"\x88\x00")
            except OSError:
                pass
            self.closed = True

    def drop(self) -> None:
        """The connection breaks without a close frame, as when the server's process dies."""
        with self.lock:
            self.closed = True
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _csv_rows(name: str) -> list[dict]:
    out = []
    for row in csv.DictReader(io.StringIO((DATA_DIR / name).read_text())):
        conv = {}
        for k, v in row.items():
            if re.fullmatch(r"-?\d+", v):
                conv[k] = int(v)
            elif re.fullmatch(r"-?\d+\.\d+", v):
                conv[k] = float(v)
            else:
                conv[k] = v
        out.append(conv)
    return out


class Run:
    """One execution the fake engine runs."""

    def __init__(self, fake: "FakeTexera", eid: int, plan: dict, sessions: list, named: bool = False):
        self.fake, self.eid, self.plan = fake, eid, plan
        self.sessions = sessions
        #: a run started by its id tells its sessions which execution it is (step 2's
        #: sub-part 14); one the old unit created itself does not
        self.named = named
        #: step 3: what writes this run's record into the lake
        self.recorder: Recorder | None = None
        #: why the run ends when it completes (the agent's path gives one)
        self.end_reason: str | None = None
        self.out_counts: dict[str, int] = {}
        #: what each Aggregate holds until its input ends
        self.held_rows: dict[str, list[dict]] = {}
        self.state = "Uninitialized"
        self.paused = threading.Event()
        self.killed = threading.Event()
        #: the unit died under the run: it changes no state and writes nothing any more
        self.dead = False
        self.pending_updates: list[dict] = []
        self.checkpoints = 0
        self.ops = {o["operatorID"]: dict(o) for o in plan["operators"]}
        self.rows_out: list[dict] = []
        self.thread: threading.Thread | None = None
        # kept for the replay a new socket gets
        self.last_stats: dict | None = None
        self.console_log: list[dict] = []
        self.errors: list[dict] = []

    def emit(self, msg) -> None:
        if self.dead:
            return
        if msg.get("type") == "OperatorStatisticsUpdateEvent":
            self.last_stats = msg
        elif msg.get("type") == "ConsoleUpdateEvent":
            self.console_log.append(msg)
        elif msg.get("type") == "WorkflowErrorEvent":
            self.errors.extend(msg.get("fatalErrors") or [])
        for s in list(self.sessions):
            s.send(msg)

    def replay(self) -> list[dict]:
        """What a socket that opens on the workflow while this run is held receives."""
        out = [self.last_stats] if self.last_stats else []
        out += self.console_log
        out.append(self.state_event())
        if self.errors:
            out.append({"type": "WorkflowErrorEvent", "fatalErrors": list(self.errors)})
        return out

    def state_event(self) -> dict:
        named = {"executionId": self.eid} if self.named else {}
        return {"type": "WorkflowStateEvent", "state": self.state, **named}

    def set_state(self, state: str, reason: str | None = None, errors: tuple | list = (),
                  final_tidy: bool = True) -> None:
        if self.dead:
            return
        self.state = state
        code = STATUS_CODES.get(state)
        if code is not None and state != "Uninitialized":
            if self.fake.unit_uses_postgres("unit-statement"):
                self.write_status(state, code)
            if state in ("Completed", "Failed", "Killed"):
                self.fake.on_terminal(self)
        if self.recorder is not None and state in LOGGED_STATES:
            self.recorder.state(LOGGED_STATES[state], reason, errors, final_tidy=final_tidy)
        self.emit(self.state_event())

    def write_status(self, state: str, code: int) -> None:
        """What the unit writes to Postgres for a state, until step 3's sub-part 17. Its
        first write, READY at Initializing, is what takes a row from Created to 0."""
        self.fake.executions[self.eid]["status"] = code
        # step 2's design D26: one write-only UPDATE by eid per state change (READY at Initializing)
        self.fake.sql("unit", "update workflow_executions set status = $1, last_update_time = $2 "
                              "where workflow_executions.eid = $3",
                      f"$1 = '{code}', $2 = '2026-11-16 10:00:00', $3 = '{self.eid}'")
        if state == "Initializing" and not self.fake.at("3C"):
            for op in self.ops:
                self.fake.sql("unit", "insert into operator_port_executions (workflow_execution_id, "
                                      "global_port_id, result_uri) values ($1, $2, $3)",
                              f"$1 = '{self.eid}', $2 = '{op}-out-0', $3 = 'vfs:///result/{op}'")

    @property
    def ended(self) -> bool:
        return self.state in ("Completed", "Failed", "Killed")

    def unit_stops(self) -> None:
        """The unit is stopping politely: a run that has not ended ends FAILED, and its
        tables are left as they are (the unit does not wait for a tidy)."""
        if not self.ended:
            self.killed.set()
            self.set_state("Failed", reason=REASON_UNIT_STOPPED, final_tidy=False)

    def unit_dies(self, await_record_s: float = 0.0) -> None:
        """The unit is gone: the run stops where it is and its recorder with it, after
        `await_record_s` for what it was handed (a polite stop waits; a kill does not)."""
        if self.recorder is not None and await_record_s:
            self.recorder.await_idle(await_record_s)
        self.dead = True
        self.killed.set()
        if self.recorder is not None:
            self.recorder.kill()

    def sink(self) -> str:
        view = self.plan.get("opsToViewResult") or []
        return view[0] if view else self.plan["operators"][-1]["operatorID"]

    def upstream(self, op_id: str) -> list[str]:
        return [ln["fromOpId"] for ln in self.plan["links"] if ln["toOpId"] == op_id]

    def evaluate_source(self, op_id: str) -> list[dict]:
        op = self.ops[op_id]
        t = op["operatorType"]
        if t == "CSVFileScan":
            return _csv_rows(op["fileName"].rsplit("/", 1)[-1])
        if t == "TextInput":
            return [{op.get("attributeName", "line"): ln} for ln in op["textInput"].split("\n")]
        if t == "FileLister":
            return [{"filename": f"{op['datasetVersionPath']}/{f}"} for f in sorted(self.fake.dataset_files)]
        raise ValueError(f"fake engine cannot read {t}")

    def apply(self, op_id: str, row: dict) -> list[dict]:
        op = self.ops[op_id]
        t = op["operatorType"]
        if t == "Filter":
            for p in op["predicates"]:
                v, want = row[p["attribute"]], float(p["value"])
                if {">": v > want, "<": v < want, "=": v == want}.get(p["condition"], False):
                    return [row]
            return []
        if t == "Projection":
            return [{(a["alias"] or a["originalAttribute"]): row[a["originalAttribute"]]
                     for a in op["attributes"]}]
        if t == "PythonUDFV2":
            code = op["code"]
            out = dict(row)
            said = _PRINT.search(code)
            if said:
                self.console(op_id, "PRINT", re.sub(r"\{tuple_\['(\w+)'\]\}", lambda m: str(row[m.group(1)]),
                                                    said.group(1)))
            slept = _SLEEP.search(code)
            if slept and self.fake.sleep_scale:
                self.killed.wait(float(slept.group(1)) * self.fake.sleep_scale)
            m = re.search(r'tuple_\["tag"\] = "([^"]+)"', code)
            if m:
                out["tag"] = m.group(1)
            if "tabulate.__version__" in code:
                out["tabulate_version"] = "0.9.0"
            if "hashlib.sha256" in code:
                content = row["line"].encode("utf-8")
                out["n_bytes"], out["sha256"] = len(content), hashlib.sha256(content).hexdigest()
            return [out]
        if t == "FileScanOp":
            name = row["filename"]
            content = (DATA_DIR / name.rsplit("/", 1)[-1]).read_text()
            return [{"filename": name, op.get("attributeName", "line"): content}]
        return [row]

    def chain(self) -> tuple[str, list[str]]:
        """The linear chain source -> ... -> sink (the harness's scenarios are chains)."""
        path = [self.sink()]
        while self.upstream(path[0]):
            path.insert(0, self.upstream(path[0])[0])
        return path[0], path[1:]

    def push(self, ops: list[str], rows: list[dict]) -> list[dict]:
        """`rows` through the operators `ops` in order; an Aggregate keeps what reaches it
        until its input ends (finish)."""
        for op_id in ops:
            if self.ops[op_id]["operatorType"] == "Aggregate":
                self.held_rows.setdefault(op_id, []).extend(rows)
                return []
            rows = [out for r in rows for out in self.apply(op_id, r)]
            self.out_counts[op_id] += len(rows)
        return rows

    def finish(self, ops: list[str]) -> list[dict]:
        """The input has ended: each Aggregate emits its groups to what follows it."""
        out: list[dict] = []
        for i, op_id in enumerate(ops):
            if self.ops[op_id]["operatorType"] == "Aggregate":
                groups = self.aggregate(op_id, self.held_rows.pop(op_id, []))
                self.out_counts[op_id] += len(groups)
                out = self.push(ops[i + 1:], groups)
        return out

    def aggregate(self, op_id: str, rows: list[dict]) -> list[dict]:
        op = self.ops[op_id]
        groups: dict[tuple, dict] = {}
        for row in rows:
            key = tuple(row[k] for k in op["groupByKeys"])
            group = groups.setdefault(key, dict(zip(op["groupByKeys"], key)))
            for agg in op["aggregations"]:
                name = agg["result attribute"]
                if agg["aggFunction"] == "sum":
                    group[name] = group.get(name, 0.0) + float(row[agg["attribute"]])
                elif agg["aggFunction"] == "count":
                    group[name] = group.get(name, 0) + 1
                else:
                    raise ValueError(f"fake engine cannot aggregate with {agg['aggFunction']}")
        return list(groups.values())

    def report(self, state: str = "Running") -> None:
        """The operators' statistics: to the sessions, and to the run's record."""
        self.emit({"type": "OperatorStatisticsUpdateEvent", "operatorStatistics": {
            op: {"operatorState": state, "aggregatedInputRowCount": 0,
                 "aggregatedOutputRowCount": n, "numWorkers": 1} for op, n in self.out_counts.items()}})
        if self.recorder is not None:
            self.recorder.statistics({op: {"output": n, "state": state.upper()}
                                      for op, n in self.out_counts.items()})

    def run(self) -> None:
        src, rest = self.chain()
        try:
            rows = self.evaluate_source(src)
        except Exception as e:  # noqa: BLE001
            self.fail(str(e))
            return
        self.out_counts = {op: 0 for op in [src] + rest}
        self.out_counts[src] = len(rows)
        self.fake.store_outputs(self)
        self.set_state("Running")
        reported = time.monotonic()
        for i, row in enumerate(rows):
            while self.paused.is_set() and not self.killed.is_set():
                time.sleep(0.005)
            if self.killed.is_set():
                return
            self.rows_out.extend(self.push(rest, [row]))
            if self.killed.is_set():
                return
            if i % 10 == 9 or i == len(rows) - 1 or time.monotonic() - reported >= STATS_EVERY_S:
                self.report()
                reported = time.monotonic()
            time.sleep(TUPLE_DELAY_S)
        aggregates = any(self.ops[op]["operatorType"] == "Aggregate" for op in rest)
        if aggregates or self.recorder is not None:
            self.rows_out.extend(self.finish(rest))
            self.report("Completed")  # the engine sends its last statistics before COMPLETED
        self.fake.store_results(self)
        self.set_state("Completed", reason=self.end_reason)

    def fail(self, message: str, op: str = "") -> None:
        error = {"type": {"name": "EXECUTION_FAILURE"}, "message": message, "details": "", "operatorId": op,
                 "workerId": ""}
        self.set_state("Failed", errors=[error])
        self.emit({"type": "WorkflowErrorEvent", "fatalErrors": [error]})

    def console(self, op: str, msg_type: str, title: str, message: str = "") -> None:
        self.emit({"type": "ConsoleUpdateEvent", "operatorId": op, "messages": [
            {"workerId": "", "timestamp": {"seconds": int(time.time()), "nanos": 0},
             "msgType": {"name": msg_type}, "source": "unit", "title": title, "message": message}]})
        if self.recorder is not None:
            self.recorder.console(op, msg_type, title, message, source="unit")

    def install_environments(self) -> bool:
        """Section 4 Environment install, as the console and the fatal error show it."""
        for op_id, op in self.ops.items():
            if op["operatorType"] != "PythonUDFV2" or op.get("defaultEnv", True):
                continue
            name = op["envName"]
            env = next(x for x in self.fake.environments.values() if x["name"] == name)
            lines = sorted(f"{k.lower()}{v}" for k, v in env["packages"].items())
            key = "|".join(lines)
            if key in self.fake.installed_envs:
                self.console(op_id, "PRINT", f"Python environment '{name}' reused", "\n".join(lines))
                continue
            packages = "1 package" if len(lines) == 1 else f"{len(lines)} packages"
            self.console(op_id, "PRINT", f"Installing Python environment '{name}' ({packages})", "\n".join(lines))
            time.sleep(0.05)
            bad = [ln for ln in lines if "nonexistent" in ln]
            if bad:  # the run's error, and nothing on the consoles
                tail = f"ERROR: No matching distribution found for {bad[0]}"
                if "install-failure-on-console" in self.fake.faults:
                    self.console(op_id, "ERROR", f"Python environment '{name}' could not be installed", tail)
                error = {"type": {"name": "EXECUTION_FAILURE"},
                         "message": f"Python environment '{name}' could not be installed: {tail}",
                         "details": tail, "operatorId": op_id, "workerId": ""}
                self.set_state("Failed", errors=[error])
                self.emit({"type": "WorkflowErrorEvent", "fatalErrors": [error]})
                return False
            self.fake.installed_envs[key] = {"requirements": lines, "name": name}
            self.console(op_id, "PRINT", f"Python environment '{name}' is ready (0.1 s)", "\n".join(lines))
        return True

    def load_executors(self) -> bool:
        """A UDF whose module raises as it is loaded cannot be initialized: the engine
        reports the Python error as a fatal error and the run fails before it runs.
        (A raise in process_tuple only pauses its worker; the run stays Running.)"""
        for op_id, op in self.ops.items():
            raised = _RAISE_ON_LOAD.search(op.get("code") or "") if op["operatorType"] == "PythonUDFV2" else None
            if raised:
                self.fail(f"java.lang.Throwable: {raised.group(2)}", op_id)
                return False
        return True

    def start(self) -> None:
        self.fake.start_record(self)
        self.set_state("Initializing")

        def go():
            if self.fake.executions[self.eid].get("plan_uri") and not self.install_environments():
                return
            if self.load_executors():
                self.run()
        self.thread = threading.Thread(target=go, daemon=True)
        self.thread.start()

    def pause(self) -> None:
        self.paused.set()
        self.set_state("Pausing")
        self.set_state("Paused")

    def resume(self) -> None:
        self.set_state("Resuming")
        applied = []
        for upd in self.pending_updates:
            self.ops[upd["operatorID"]] = upd
            applied.append(upd["operatorID"])
        self.pending_updates = []
        self.paused.clear()
        self.set_state("Running")
        if applied:
            self.emit({"type": "ModifyLogicCompletedEvent", "opIds": applied})

    def kill(self) -> None:
        self.killed.set()
        self.paused.clear()
        self.set_state("Killed", reason="killed by the user")

    def results(self, op_id: str) -> tuple[list[dict], list[dict]]:
        rows = self.rows_out if op_id == self.sink() else []
        schema = []
        for k, v in (rows[0].items() if rows else []):
            schema.append({"attributeName": k, "attributeType":
                           "integer" if isinstance(v, int) else "double" if isinstance(v, float) else "string"})
        return rows, schema


class FakeTexera:
    def __init__(self, *, warehouses: bool = True, replay_log: bool = False, step: str = "2",
                 timing: RecordTiming | None = None):
        self.lock = threading.RLock()
        self.step = step
        #: step 3's timers, as the stack would set them (tests give short ones)
        self.timing = timing or RecordTiming()
        self.lake = FakeLake()
        #: how the product misbehaves, for the tests of checks that must fail (FAULTS here,
        #: fake_record.FAULTS, fake_closing.FAULTS)
        self.faults: set[str] = set()
        #: step 3, from 3B on: the Dashboard's closing record, job and expiry
        self.closing = Closing(self)
        #: the unit's process is up (single-node and local-dev: one process behind every unit row)
        self.unit_up = True
        #: Kubernetes: every unit is a pod of its own; the units whose pod is gone
        self.kubernetes = False
        self.pods_gone: set[int] = set()
        self.unit_address = UNIT_ADDRESS
        #: how much of a UDF's time.sleep() the fake engine sleeps
        self.sleep_scale = 0.0
        self.users: dict[int, dict] = {1: {"uid": 1, "name": "texera", "email": "texera@texera.io",
                                           "password": "texera", "role": "ADMIN", "comment": ""}}
        self.workflows: dict[int, dict] = {}
        self.units: dict[int, dict] = {}
        self.warehouses: dict[int, dict] = {}
        self.warehouses_enabled = warehouses
        self.replay_log = replay_log
        self.executions: dict[int, dict] = {}
        self.environments: dict[int, dict] = {}
        self.dataset_files = ["people.csv", "depts.csv", "numbers.csv"]
        self.installed_envs: dict[str, dict] = {}
        self.next = {"wid": 10, "cuid": 3, "eid": 100, "uid": 2, "whid": 7, "veid": 1}
        self.rest_log: list[dict] = []
        self.ws_log: list[dict] = []
        self.runs: dict[int, Run] = {}
        #: a WorkflowService per (wid, cuid): its sockets and the run it holds
        self.sessions_by_key: dict[tuple[int, int], list[WsConn]] = {}
        self.held: dict[tuple[int, int], Run] = {}
        self.send_cluster_status = True
        self.replay_delay_s = REPLAY_DELAY_S
        self.cleanup_s = 0.3
        #: statement_sink(who, sql, params): who is "unit" or "dashboard"
        self.statement_sink = None
        #: access_sink(method, path, status): a request this fake served (the gateway's view)
        self.access_sink = None
        self.server: ThreadingHTTPServer | None = None

    def at(self, step: str) -> bool:
        """Whether the product modelled has reached `step`."""
        return STEPS.index(self.step) >= STEPS.index(step)

    @property
    def created_status(self) -> int:
        """The status of an execution from its creation until a unit starts it."""
        return 0 if "created-reads-initializing" in self.faults else STATUS_CREATED

    # ------------------------------------------------------------ the lake

    def warehouse_of(self, e: dict) -> str:
        return f"user-{e['uid']}-{e['whid']}" if e.get("whid") is not None else DEFAULT_WAREHOUSE

    def execution_table(self, eid: int, kind: str):
        """One of an execution's own tables (plan, log, statistics, console), or None."""
        e = self.executions[eid]
        return self.lake.table(self.warehouse_of(e), NAMESPACES[kind], table_name(e["wid"], eid, kind))

    def write_plan(self, eid: int) -> None:
        """Create writes the execution's plan table; its one row is the plan."""
        e = self.executions[eid]
        self.lake.create(self.warehouse_of(e), NAMESPACES["plan"], table_name(e["wid"], eid, "plan")) \
            .append([{"plan": json.dumps(e["plan"])}])

    def claim_start(self, eid: int) -> None:
        """The one start of an execution: the `started` tag on its plan table."""
        self.executions[eid]["started"] = True
        self.execution_table(eid, "plan").tag("started")

    def start_record(self, run: "Run") -> None:
        """Step 3: a run started by id gets its recorder right after the claim (design 4.1)."""
        e = self.executions[run.eid]
        if self.at("3A") and e.get("plan_uri"):
            run.recorder = Recorder(self.lake, self.warehouse_of(e), e["wid"], run.eid,
                                    interval_s=self.timing.commit_interval_s, faults=self.faults)

    def port_tables(self, run: "Run") -> dict[str, tuple[str, str]]:
        """kind -> (URI, table name) of the result and the state table of the run's stored
        port: its sink's first output port."""
        e = self.executions[run.eid]
        port = f"(logicalOpId={run.sink()},layerName=main,portId=0,isInternal=false,isInput=false)"
        base = f"wid/{e['wid']}/eid/{run.eid}/globalportid/{port}"
        wh = f"wh/{self.warehouse_of(e)}/" if e.get("whid") is not None else ""
        return {kind: (f"vfs:///{wh}{base}/{kind}", f"{base}/{kind}".replace("/", "_"))
                for kind in ("result", "state")}

    def store_outputs(self, run: "Run") -> None:
        """The engine makes the result table of the run's stored port, and a state table
        beside it, where the plan says. The log is told nothing of it."""
        e = self.executions[run.eid]
        if not e.get("plan_uri"):
            return
        tables = self.port_tables(run)
        for kind, (_uri, name) in tables.items():
            self.lake.create(self.warehouse_of(e), NAMESPACES[kind], name)
        if run.recorder is not None and "output-rows" in self.faults:
            port = tables["result"][0].split("/globalportid/")[1].rsplit("/", 1)[0]
            run.recorder.output(port, tables["result"][0], "SET_SNAPSHOT")

    def clear_results(self, eid: int) -> None:
        """Drop an execution's result and state tables and, with them, its console table."""
        e = self.executions[eid]
        warehouse, prefix = self.warehouse_of(e), f"wid_{e['wid']}_eid_{eid}_"
        for kind in ("result", "state"):
            for name in self.lake.names(warehouse, NAMESPACES[kind]):
                if name.startswith(prefix):
                    self.lake.drop(warehouse, NAMESPACES[kind], name)
        self.lake.drop(warehouse, NAMESPACES["console"], table_name(e["wid"], eid, "console"))

    def holds_results(self, eid: int) -> bool:
        """Whether a unit wrote a result or console output for the execution (and nothing cleared it)."""
        e = self.executions[eid]
        warehouse, prefix = self.warehouse_of(e), f"wid_{e['wid']}_eid_{eid}_"
        return (self.execution_table(eid, "console") is not None
                or any(name.startswith(prefix) for name in self.lake.names(warehouse, NAMESPACES["result"])))

    def clear_at_create(self, wid: int, cuid: int) -> None:
        """What a create clears until "3B" (ExecutionResources.clearReplacedExecutions): the
        results of an ended execution of the workflow on the unit that a later one has
        replaced with results of its own. An execution that is only created clears
        nothing: the results the unit ran last stay until a run has some in their place."""
        same = {eid: x for eid, x in self.executions.items() if (x["wid"], x["cuid"]) == (wid, cuid)}
        for eid, x in sorted(same.items()):
            if x["status"] in (3, 4, 5) and self.holds_results(eid) \
                    and any(later > eid and self.holds_results(later) for later in same):
                self.clear_results(eid)

    def store_results(self, run: "Run") -> None:
        """The port ended: its rows are committed to its result table."""
        e = self.executions[run.eid]
        table = self.lake.table(self.warehouse_of(e), NAMESPACES["result"], self.port_tables(run)["result"][1]) \
            if e.get("plan_uri") else None
        if table is not None and run.rows_out:
            table.append(list(run.rows_out))

    # -------------------------------------------------------- statements

    def sql(self, who: str, sql: str, params: str | None = None) -> None:
        if self.statement_sink is not None:
            self.statement_sink(who, sql, params)

    def on_terminal(self, run: "Run") -> None:
        """A run ended: with nobody watching (the agent's REST path) the unit cleans it
        `cleanup_s` later, as WorkflowLifecycleManager does."""
        key = next((k for k, r in self.held.items() if r is run), None)
        if key is None or not self.sessions_by_key.get(key):
            self._schedule_cleanup(run.eid, key)

    def _schedule_cleanup(self, eid: int, key) -> None:
        def clean():
            if self.runs[eid].dead:
                return  # the unit went down meanwhile: it cleans nothing up
            if key is not None and self.sessions_by_key.get(key):
                return  # somebody opened the workflow again
            if key is not None:
                self.held.pop(key, None)
            if self.at("3B"):
                return  # sub-part 14: the unit lets go of the run and deletes nothing
            self.clear_results(eid)  # the unit clears the storage of the run it lets go of
            for table in ("operator_port_executions", "operator_executions"):
                self.sql("unit", f"delete from {table} where {table}.workflow_execution_id = $1", f"$1 = '{eid}'")
            self.sql("unit", "select workflow_executions.runtime_stats_uri from workflow_executions "
                             "where workflow_executions.eid = $1", f"$1 = '{eid}'")
        t = threading.Timer(self.cleanup_s, clean)
        t.daemon = True
        t.start()

    # -------------------------------------------------------------- serving

    def start(self) -> str:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):  # quiet
                pass

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                try:
                    return json.loads(raw) if raw else None
                except ValueError:
                    return raw.decode()

            def _reply(self, status: int, body=None):
                raw = isinstance(body, bytes)  # a file to download
                data = body if raw else b"" if body is None else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/octet-stream" if raw else "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self, method: str):
                parts = urllib.parse.urlsplit(self.path)
                body = self._body() if method in ("POST", "PUT") else None
                token = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
                query = urllib.parse.parse_qs(parts.query)
                fake.rest_log.append({"method": method, "path": parts.path, "query": query, "body": body,
                                      "token": token})
                status, out = fake.route(method, parts.path, query, body, token)
                self._reply(status, out)
                if fake.access_sink is not None:
                    fake.access_sink(method, parts.path, status)

            def do_GET(self):
                if (self.headers.get("Upgrade") or "").lower() == "websocket":
                    parts = urllib.parse.urlsplit(self.path)
                    cuid = (urllib.parse.parse_qs(parts.query).get("cuid") or [None])[0]
                    if cuid is not None and not fake.unit_reachable(int(cuid)):
                        self._reply(502, {"message": "the computing unit does not answer"})
                        return
                    key = self.headers["Sec-WebSocket-Key"]
                    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
                    self.send_response(101, "Switching Protocols")
                    self.send_header("Upgrade", "websocket")
                    self.send_header("Connection", "Upgrade")
                    self.send_header("Sec-WebSocket-Accept", accept)
                    self.end_headers()
                    parts = urllib.parse.urlsplit(self.path)
                    conn = WsConn(self.connection, self.rfile)
                    fake.websocket(parts.path, urllib.parse.parse_qs(parts.query), conn)
                    self.close_connection = True
                    return
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

            def do_PUT(self):
                self._handle("PUT")

            def do_DELETE(self):
                self._handle("DELETE")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        if self.at("3B"):
            self.closing.start()
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self) -> None:
        self.closing.stop()
        for run in self.runs.values():
            run.killed.set()
            if run.recorder is not None:
                run.recorder.kill()
        if self.server:
            self.server.shutdown()
            self.server.server_close()

    # ------------------------------------------------------------ helpers

    def user_of(self, token: str) -> dict | None:
        try:
            payload = token.split(".")[1]
            payload += "=" * (-len(payload) % 4)
            uid = int(json.loads(base64.urlsafe_b64decode(payload))["userId"])
        except Exception:  # noqa: BLE001
            return None
        return self.users.get(uid)

    def token_of(self, user: dict) -> str:
        return make_token(user["uid"], user["role"], user["email"])

    def entry(self, eid: int, uid: int | None = None) -> dict:
        """An entry of the history as `uid` sees it. From 3B on its status, its completion
        time and its reason come from the closing record and the label (design D21)."""
        e = self.executions[eid]
        entry = {"eId": eid, "vId": 1, "cuId": e["cuid"], "whId": e.get("whid"), "name": e.get("name", ""),
                 "logLocation": e.get("log")}
        if self.at("3B") and e.get("plan_uri"):
            return {**entry, **self.closing.entry_fields(eid, uid)}
        return {**entry, "status": e["status"], "result": ""}

    # ------------------------------------------- the unit goes down and comes back

    def unit_reachable(self, cuid: int) -> bool:
        return self.unit_up and cuid not in self.pods_gone

    def take_unit_down(self, *, polite: bool, cuid: int | None = None) -> None:
        """The unit stops answering: all of it, or with `cuid` the pod of that unit. Killed,
        it stops where it is. Stopped politely, it first ends the runs it holds."""
        with self.lock:
            if cuid is None:
                self.unit_up = False
            else:
                self.pods_gone.add(cuid)
            keys = [k for k in self.sessions_by_key if cuid is None or k[1] == cuid]
            runs = [r for r in self.runs.values() if cuid is None or self.executions[r.eid]["cuid"] == cuid]
            sockets = [c for k in keys for c in self.sessions_by_key[k]]
            for key in [k for k in self.held if cuid is None or k[1] == cuid]:
                del self.held[key]
        recorded = polite and self.at("3A") and "stop-unrecorded" not in self.faults
        for run in runs:
            if recorded:
                run.unit_stops()
        for run in runs:
            run.unit_dies(STOP_AWAIT_S if recorded else 0.0)
        for conn in sockets:
            conn.drop()

    def bring_unit_up(self) -> None:
        """The unit's process answers again. It holds no run."""
        with self.lock:
            self.unit_up = True

    def unit_uses_postgres(self, fault: str) -> bool:
        """Whether the unit still does a thing with Postgres that step 3's sub-part 17 ends:
        until "3C" it does; from then on only with the fault that names the thing."""
        return not self.at("3C") or fault in self.faults

    @property
    def unit_env(self) -> dict[str, str]:
        """The environment the unit was started with. A single-node or local-dev stack hands
        every service the whole of it; a Kubernetes manager gives a unit no database login
        from sub-part 19 on."""
        login = {} if self.kubernetes and self.at("3C") else UNIT_JDBC_ENV
        return {"WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS": "1", **login}

    def backends(self) -> list[dict]:
        """Postgres's client connections, as pg_stat_activity lists them: the Dashboard's
        pool and, while a unit that still uses Postgres is up, its pool (two idle
        connections, opened at boot)."""
        def pool(app: str, address: str, first_pid: int) -> list[dict]:
            return [{"pid": first_pid + i, "application_name": app, "client_addr": address,
                     "datname": "texera_db", "state": "idle"} for i in range(2)]
        units = self.unit_up and self.unit_uses_postgres("unit-pool")
        return pool(DASHBOARD_APP, DASHBOARD_ADDRESS, 400) + (pool(UNIT_APP, self.unit_address, 300) if units else [])

    @staticmethod
    def err(status: int, message: str):
        return status, {"code": status, "message": message}

    def plan_uri(self, uid: int, whid: int | None, wid: int, eid: int) -> str:
        wh = f"wh/user-{uid}-{whid}/" if whid is not None else ""
        return f"vfs:///{wh}wid/{wid}/eid/{eid}/plan"

    # ------------------------------------------------------------- REST

    def route(self, method: str, path: str, query: dict, body, token: str):
        with self.lock:
            user = self.user_of(token)
            if path == "/api/healthcheck":
                return 200, {}
            if path == "/api/auth/login" and method == "POST":
                u = next((u for u in self.users.values() if u["name"] == body["username"]
                          and u["password"] == body["password"]), None)
                return (200, {"accessToken": self.token_of(u)}) if u else self.err(401, "Login credentials are incorrect.")
            if path == "/api/auth/register" and method == "POST":
                if any(u["name"] == body["username"] for u in self.users.values()):
                    return self.err(406, "Username exists already.")
                uid = self.next["uid"]
                self.next["uid"] += 1
                self.users[uid] = {"uid": uid, "name": body["username"], "email": body["email"],
                                   "password": body["password"], "role": "INACTIVE", "comment": ""}
                return 200, {"accessToken": self.token_of(self.users[uid])}
            if path == "/api/executions/result/export/local" and method == "POST" and self.at("3C"):
                return self.export_local(urllib.parse.parse_qs(body or ""))  # its token is in the form
            if user is None:
                return self.err(401, "no credentials")
            uid = user["uid"]
            if path == "/api/admin/user/list":
                return 200, [{k: v for k, v in u.items() if k != "password"} for u in self.users.values()]
            if path == "/api/admin/user/update" and method == "PUT":
                if user["role"] != "ADMIN":
                    return self.err(403, "admin only")
                self.users[body["uid"]]["role"] = body["role"]
                return 200, None
            if path == "/api/workflow/create":
                wid = self.next["wid"]
                self.next["wid"] += 1
                self.workflows[wid] = {"owner": uid, "name": body["name"]}
                return 200, {"workflow": {"wid": wid}}
            if path == "/api/computing-unit" and method == "GET":
                # a listing stamps the Kubernetes units whose pod is gone (design D27)
                for c, u in self.units.items():
                    if u["uid"] == uid and c in self.pods_gone and not u.get("terminateTime"):
                        u.update(terminateTime=time.time(), terminationReason="GARBAGE_COLLECTED")
                return 200, [{"computingUnit": {"cuid": c, **u}} for c, u in self.units.items()
                             if u["uid"] == uid and not u.get("terminateTime")]
            if path == "/api/computing-unit/create":
                cuid = self.next["cuid"]
                self.next["cuid"] += 1
                self.units[cuid] = {"uid": uid, "name": body["name"], "uri": body["uri"],
                                    "type": body.get("unitType", "local")}
                return 200, {"computingUnit": {"cuid": cuid, **self.units[cuid]}}
            m = re.fullmatch(r"/api/computing-unit/(\d+)/terminate", path)
            if m and method == "DELETE":
                self.units[int(m.group(1))].update(terminateTime=time.time(), terminationReason="USER_REQUESTED")
                return 200, None
            if path == "/api/warehouse/status":
                return 200, {"enabled": self.warehouses_enabled,
                             "warehouses": [{"whid": w, "name": x["name"], "lakekeeperWarehouseName": f"user-{x['uid']}-{w}"}
                                            for w, x in self.warehouses.items() if x["uid"] == uid]}
            if path == "/api/warehouse" and method == "POST":
                whid = self.next["whid"]
                self.next["whid"] += 1
                self.warehouses[whid] = {"uid": uid, "name": body["name"]}
                return 200, {"whid": whid}
            if path == "/api/executions" and method == "POST":
                return self.create(uid, body)
            m = re.fullmatch(r"/api/executions/(\d+)/updates", path)
            if m and method == "POST":
                return self.post_update(uid, int(m.group(1)), body)
            m = re.fullmatch(r"/api/executions/(\d+)/stats/(\d+)", path)
            if m and method == "GET" and self.at("3A"):
                if (self.kubernetes and not self.statistics_reach_the_unit(query)) or self.stored_read_refused():
                    return self.err(503, "no healthy upstream")
                return self.statistics(uid, int(m.group(1)), int(m.group(2)))
            m = re.fullmatch(r"/api/executions/(\d+)/console", path)
            if m and method == "GET" and self.at("3C"):
                if self.stored_read_refused():
                    return self.err(503, "no healthy upstream")
                return self.closing.console(uid, int(m.group(1)), query)
            m = re.fullmatch(r"/api/executions/(\d+)/(state|log)", path)
            if m and method == "GET" and self.at("3B"):
                answer = self.closing.state if m.group(2) == "state" else self.closing.log
                return answer(uid, int(m.group(1)))
            if path == "/api/quota/user_quota_size" and method == "GET" and self.at("3B"):
                return self.closing.quota(uid)
            m = re.fullmatch(r"/api/admin/execution/executionList/(\d+)/(\d+)/\w+/\w+", path)
            if m and method == "GET" and self.at("3B"):
                return self.closing.admin_list(user, int(m.group(1)), int(m.group(2)))
            m = re.fullmatch(r"/api/executions/(\d+)/latest", path)
            if m:
                eids = [e for e, x in self.executions.items() if x["wid"] == int(m.group(1))]
                return (200, self.entry(max(eids), uid)) if eids else (404, None)
            m = re.fullmatch(r"/api/executions/(\d+)/interactions/(\d+)", path)
            if m:
                e = self.executions.get(int(m.group(2)))
                run = self.runs.get(int(m.group(2)))
                n = run.checkpoints if run else 0
                return 200, ([f"Checkpoint_{i}" for i in range(n)] if e and e.get("log") else [])
            m = re.fullmatch(r"/api/executions/(\d+)", path)
            if m and method == "GET":
                wid = int(m.group(1))
                if self.workflows.get(wid, {}).get("owner") != uid:
                    return 200, []
                return 200, [self.entry(e, uid) for e, x in sorted(self.executions.items(), reverse=True)
                             if x["wid"] == wid]
            if path in ("/api/environments", "/api/pve/db"):
                if method == "GET":
                    return 200, [dict(veid=v, **{k: x[k] for k in ("name", "packages")})
                                 for v, x in self.environments.items() if x["uid"] == uid]
                if any(x["uid"] == uid and x["name"] == body["name"] for x in self.environments.values()):
                    return self.err(409, f'An environment named "{body["name"]}" already exists.')
                veid = self.next["veid"]
                self.next["veid"] += 1
                self.environments[veid] = {"uid": uid, "name": body["name"], "packages": body["packages"]}
                return 201, ({"veid": veid, "name": body["name"], "packages": body["packages"]}
                             if path == "/api/environments" else {"veid": veid})
            m = re.fullmatch(r"/api/(?:environments|pve/db)/(\d+)", path)
            if m and method == "PUT":
                self.environments[int(m.group(1))].update(name=body["name"], packages=body["packages"])
                return 200, {"veid": int(m.group(1))}
            m = re.fullmatch(r"/api/execution/(\d+)/run", path)
            if m and method == "POST":
                if not self.unit_up:
                    return self.err(502, "the computing unit does not answer")
                return self.sync_run(user, int(m.group(1)), body)
            return self.err(404, f"no route {method} {path}")

    def create(self, uid: int, body: dict):
        """Design 3.4 and section 4 Create, steps 1-11, in the product's words (ExecutionCreator).
        A field the request should not have, `targetOperatorIds` among them, is not read."""
        if not isinstance(body, dict) or "wid" not in body or "computingUnitId" not in body:
            return self.err(400, "The request names no workflow.")
        if not isinstance(body.get("logicalPlan"), dict):
            return self.err(400, "The request has no logical plan.")
        wid, cuid = body["wid"], body["computingUnitId"]
        if self.workflows.get(wid, {}).get("owner") != uid:
            return self.err(403, f"You do not have access to workflow {wid}.")
        unit = self.units.get(cuid)
        if unit is None or unit["uid"] != uid:
            return self.err(403, f"You may not run workflows on computing unit {cuid}.")
        if unit.get("terminateTime"):
            return self.err(409, f"Computing unit {cuid} is terminated.")
        whid = body.get("warehouseId")
        if self.warehouses_enabled:
            if whid is None:
                return self.err(400, "A warehouse must be selected for this execution.")
            if self.warehouses.get(whid, {}).get("uid") != uid:
                return self.err(400, f"You have no warehouse with id {whid}.")
        elif whid is not None:
            return self.err(400, "Per-user warehouses are disabled in this deployment.")
        replay = body.get("replayFromExecution")
        if replay:
            src = self.executions.get(replay["eid"])
            if src is None or src["wid"] != wid:
                return self.err(400, f"Workflow {wid} has no execution {replay['eid']} to replay.")
            if src["uid"] != uid:
                return self.err(400, f"Execution {replay['eid']} is another user's: only your own executions "
                                     f"can be replayed.")
            if not src.get("log"):
                return self.err(400, f"Execution {replay['eid']} kept no replay log to replay.")
        eid = self.next["eid"]
        self.next["eid"] += 1
        self.executions[eid] = {"wid": wid, "cuid": cuid, "uid": uid, "whid": whid, "status": self.created_status,
                                "name": body.get("executionName", ""), "plan": body["logicalPlan"],
                                "started": False, "log": (f"file:///logs/{wid}/{eid}/" if self.replay_log else None),
                                "updates": {},
                                "plan_uri": self.plan_uri(uid, whid, wid, eid), **Closing.new_row()}
        self.sql("dashboard", "insert into workflow_executions (vid, uid, cuid, whid, status) values "
                              "($1, $2, $3, $4, $5) returning eid",
                 f"$1 = '1', $2 = '{uid}', $3 = '{cuid}', $4 = '{whid}', $5 = '{self.created_status}'")
        errors = self.compile_errors(uid, body["logicalPlan"])
        if errors:
            self.executions[eid]["status"] = 4
            self.sql("dashboard", "update workflow_executions set status = $1 where workflow_executions.eid = $2",
                     f"$1 = '4', $2 = '{eid}'")
            if self.at("3B"):  # D29: a create that fails closes its own row at once
                first = next(iter(errors.values()))["message"]
                self.closing.close(eid, 4, (REASON_COMPILE_ERROR + first)[:REASON_CHARS], int(time.time() * 1000),
                                   never_started=True)
            count = "1 operator has an error." if len(errors) == 1 else f"{len(errors)} operators have errors."
            listed = "".join(f"\n{op}: {error['message']}" for op, error in errors.items())
            return 400, {"code": 400, "message": f"The workflow does not compile: {count}{listed}", "eid": eid,
                         "operatorErrors": errors}
        self.write_plan(eid)
        # From "3B" on a create clears nothing: the closing job's expiry replaces results.
        if not self.at("3B"):
            self.clear_at_create(wid, cuid)
        elif "replaced-at-create" in self.faults:
            self.closing.expire_at_create(wid, cuid, eid)
        return 201, {"eid": eid, "planUri": self.executions[eid]["plan_uri"]}

    def statistics_reach_the_unit(self, query: dict) -> bool:
        """Kubernetes until step 3's sub-part 16: the gateway sends a statistics request to
        the unit its `cuid` names, so it is answered only while that unit is up."""
        if self.at("3C"):
            return True
        cuid = (query.get("cuid") or [None])[0]
        return cuid is not None and self.unit_reachable(int(cuid))

    def stored_read_refused(self) -> bool:
        """The fault of a Dashboard that still needs a unit to serve stored output."""
        return "stored-reads-need-unit" in self.faults and not (self.unit_up and not self.pods_gone)

    def export_local(self, form: dict):
        """POST /api/executions/result/export/local from step 3's sub-part 16 on: one
        operator's result of the execution the request names, as CSV. Errors answer as the
        route does today, 500 with {"error"}; expired results are 410."""
        def failed(message: str, status: int = 500):
            return status, {"error": message}
        user = self.user_of((form.get("token") or [""])[0])
        if user is None:
            return failed("Invalid or expired token")
        request = json.loads((form.get("request") or ["{}"])[0])
        wid, eid = request.get("workflowId"), request.get("executionId")
        if self.workflows.get(wid, {}).get("owner") != user["uid"]:
            return self.err(403, f"no access to workflow {wid}")
        e = self.executions.get(eid)
        if e is None or e["wid"] != wid:
            return failed(f"execution {eid} is not an execution of workflow {wid}")
        if self.stored_read_refused():
            return self.err(503, "no healthy upstream")
        if e["results_expired_at"] is not None and "export-after-expiry" not in self.faults:
            return failed(f"the results of execution {eid} have expired", 410)
        run = self.runs.get(eid)
        rows, _schema = run.results(request["operators"][0]["id"]) if run else ([], [])
        if not rows or e["results_expired_at"] is not None:
            return failed("Failed to export operator")
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(list(rows[0]))
        writer.writerows([list(row.values()) for row in rows])
        return 200, out.getvalue().encode()

    def statistics(self, uid: int, wid: int, eid: int):
        """GET /api/executions/{wid}/stats/{eid}, from step 3's sub-part 6 on: the rows of
        the execution's statistics table in the lake, times as epoch milliseconds."""
        if self.workflows.get(wid, {}).get("owner") != uid:
            return self.err(401, "HTTP 401 Unauthorized")
        e = self.executions.get(eid)
        if e is None or e["wid"] != wid:
            return self.err(500, "No runtime statistics URI found for the given execution ID.")
        table = self.execution_table(eid, "statistics")
        with self.lake.lock:
            rows = list(table.rows) if table is not None else []
        return 200, [{"operatorId": r["operatorId"], "timestamp": r["timeMs"],
                      "inputTupleCount": r["inputTupleCnt"], "inputTupleSize": r["inputTupleSize"],
                      "outputTupleCount": r["outputTupleCnt"], "outputTupleSize": r["outputTupleSize"],
                      "dataProcessingTime": r["dataProcessingTime"],
                      "controlProcessingTime": r["controlProcessingTime"], "idleTime": r["idleTime"],
                      "numWorkers": r["numWorkers"], "status": r["status"]} for r in rows]

    def compile_errors(self, uid: int, plan: dict) -> dict:
        ops = {o["operatorID"]: o for o in plan["operators"]}
        ups = {o: [ln["fromOpId"] for ln in plan["links"] if ln["toOpId"] == o] for o in ops}
        errors = {}

        def fatal(op, msg):
            return {"type": {"name": "COMPILATION_ERROR"}, "timestamp": {"seconds": 0, "nanos": 0},
                    "message": msg, "details": "", "operatorId": op, "workerId": ""}

        for op_id, op in ops.items():
            if op["operatorType"] == "Projection":
                for a in op["attributes"]:
                    if a["originalAttribute"].startswith("sce_no_such"):
                        errors[op_id] = fatal(op_id, f"attribute {a['originalAttribute']} does not exist")
            if op["operatorType"] == "PythonUDFV2" and not op.get("defaultEnv", True):
                if not any(x["uid"] == uid and x["name"] == op["envName"] for x in self.environments.values()):
                    errors[op_id] = fatal(op_id, f"Python environment '{op['envName']}' does not exist")
            if op["operatorType"] == "FileScanOp":
                seen, todo = set(), list(ups[op_id])
                while todo:
                    u = todo.pop()
                    seen.add(ops[u]["operatorType"])
                    todo.extend(ups[u])
                if "FileLister" not in seen:
                    errors[op_id] = fatal(op_id, "File Scan From Input needs a File Lister upstream of it")
        return errors

    def post_update(self, uid: int, eid: int, body: dict):
        """Design 3.5, in the product's words (OperatorUpdates)."""
        e = self.executions.get(eid)
        if e is None:
            return self.err(404, f"There is no execution {eid}.")
        if e["uid"] != uid:
            return self.err(403, f"Only the user who created execution {eid} may change its operators.")
        ended = e["ended_at"] is not None if self.at("3B") else e["status"] in (3, 4, 5)
        if ended:  # from 3B on by the closing record, which the job writes a tick after the end
            return self.err(409, f"Execution {eid} has ended.")
        op = body["operator"]
        if op["operatorID"] not in {o["operatorID"] for o in e["plan"]["operators"]}:
            return self.err(404, f"Execution {eid} has no operator {op['operatorID']}.")
        update_id = f"update-{len(e['updates']) + 1:04d}-4f6c"
        e["updates"][update_id] = op
        return 201, {"updateId": update_id, "operatorId": op["operatorID"]}

    def start_checks(self, user: dict, eid: int, plan_uri: str, wid: int | None, cuid: int) -> str | None:
        """Section 4 Start, steps 1-6: why the unit refuses the start, in its words
        (StoredExecutionStart and WorkflowService in the product), or None."""
        m = re.fullmatch(r"vfs:///(?:wh/([^/]+)/)?wid/(\d+)/eid/(\d+)/plan", plan_uri or "")
        if not m:
            return "The request does not name an execution's plan."
        if int(m.group(3)) != eid:
            return f"The plan is execution {m.group(3)}'s, not {eid}'s."
        if wid is not None and int(m.group(2)) != wid:
            return f"The plan belongs to workflow {m.group(2)}, not to this one."
        if m.group(1) and not re.fullmatch(rf"user-{user['uid']}-\d+", m.group(1)):
            return "The plan is in another user's warehouse."
        e = self.executions.get(eid)
        if e is None or e["plan_uri"] != plan_uri:
            return f"Execution {eid} has no stored plan."
        if e["uid"] != user["uid"]:
            return f"Only the user who created execution {eid} may start it."
        if e["cuid"] != cuid:
            return f"Execution {eid} was created for computing unit {e['cuid']}, not {cuid}."
        if e["started"]:
            return f"Execution {eid} was already started."
        return None

    def refuse(self, conn: WsConn, msg: dict, why: str) -> None:
        """The unit did not do what a session asked: it tells that session, and it alone,
        which request and, when the request names one, which execution."""
        if "refusal-as-error-event" in self.faults:
            conn.send({"type": "WorkflowErrorEvent", "fatalErrors": [
                {"type": {"name": "EXECUTION_FAILURE"}, "message": why, "details": "", "operatorId": "",
                 "workerId": ""}]})
            return
        named = {"executionId": msg.get("executionId", 0)} if msg.get("type") in EXECUTION_REQUESTS else {}
        conn.send({"type": "RequestRefusedEvent", "request": msg.get("type"), **named, "message": why})

    def run_asked_for(self, held: "Run | None", msg: dict) -> "Run | None":
        """The run a pause, a resume or a kill is for: the one the unit holds for the
        workflow, when it is the execution the request names. A run the published images'
        unit started (the old path) takes the old frame, which names none."""
        if held is None:
            return None
        named = msg.get("executionId", 0) == held.eid
        return held if named or not held.named or "stale-control" in self.faults else None

    def sync_run(self, user: dict, eid: int, body: dict):
        """Design 3.7: the unit's REST path for agents."""
        refused = self.start_checks(user, eid, body.get("planUri"), None, body.get("computingUnitId"))
        if refused:
            return 200, {"success": False, "state": "Error", "operators": {}, "errors": [refused]}
        e = self.executions[eid]
        self.claim_start(eid)
        run = Run(self, eid, e["plan"], [], named=True)
        self.runs[eid] = run
        target = (body.get("targetOperatorIds") or [None])[0]
        if target:
            run.plan = dict(e["plan"], opsToViewResult=[target])
            run.ops = {o["operatorID"]: dict(o) for o in e["plan"]["operators"]}
            run.end_reason = "stopped once its target operators finished"  # design D5
        self.start_record(run)
        run.set_state("Initializing")  # READY, then the run
        run.run()
        if run.recorder is not None:  # the agent's path waits for the record before it reads it
            run.recorder.await_idle(5)
        rows, _ = run.results(run.sink())
        return 200, {"success": run.state == "Completed", "state": run.state,
                     "operators": {run.sink(): {"state": "Completed", "inputTuples": 0, "outputTuples": len(rows),
                                                "resultMode": "table", "result": rows,
                                                "totalRowCount": len(rows)}},
                     "compilationErrors": None, "errors": None}

    # -------------------------------------------------------- websockets

    def websocket(self, path: str, query: dict, conn: WsConn) -> None:
        if path == "/wsapi/pve":
            action = query.get("action", ["create"])[0]
            conn.send(f"[PVE] {action} {query['pveName'][0]} on cuid {query['cuid'][0]}")
            conn.send("[pip] Successfully installed tabulate-0.9.0")
            conn.send("__DONE__")
            conn.close()
            return
        wid, cuid = int(query["wid"][0]), int(query["cuid"][0])
        user = self.user_of(query.get("access-token", [""])[0])
        key = (wid, cuid)
        with self.lock:
            sessions = self.sessions_by_key.setdefault(key, [])
        # the open sequence of the real unit: the handshake hack, the replay of the
        # held run (a little later), then ClusterStatusUpdateEvent
        conn.send({"type": "WorkflowStateEvent", "state": "Uninitialized", "executionId": None})
        held = self.held.get(key)
        if held is not None:
            time.sleep(self.replay_delay_s)
            for msg in held.replay():
                conn.send(msg)
        with self.lock:
            sessions.append(conn)
        if self.send_cluster_status:
            conn.send({"type": "ClusterStatusUpdateEvent", "numWorkerNodesInCluster": 1})
        try:
            while True:
                raw = conn.recv()
                if raw is None:
                    return
                msg = json.loads(raw)
                self.ws_log.append({"wid": wid, "cuid": cuid, "uid": user and user["uid"], "msg": msg})
                typ = msg.get("type")
                with self.lock:
                    current = self.held.get(key)
                    if typ == "HeartBeatRequest":
                        conn.send({"type": "HeartBeatResponse"})
                    elif typ == "WorkflowStartRequest":
                        refused = self.start_checks(user, msg["executionId"], msg["planUri"], wid, cuid)
                        if refused:  # D33: that session only, no state, no statement
                            self.refuse(conn, msg, refused)
                            continue
                        e = self.executions[msg["executionId"]]
                        self.claim_start(msg["executionId"])
                        current = Run(self, msg["executionId"], e["plan"], sessions, named=True)
                        self.runs[current.eid] = current
                        self.held[key] = current
                        current.start()
                    elif typ == "WorkflowExecuteRequest":  # the old path: the unit creates
                        eid = self.next["eid"]
                        self.next["eid"] += 1
                        self.executions[eid] = {"wid": wid, "cuid": cuid, "uid": user["uid"], "status": 0,
                                                "plan": msg["logicalPlan"], "started": True, "log": None,
                                                "updates": {}, "plan_uri": None, **Closing.new_row()}
                        # the old unit reads before it inserts the row itself
                        self.sql("unit", "select user_warehouse.whid from user_warehouse where "
                                         "user_warehouse.uid = $1", f"$1 = '{user['uid']}'")
                        self.sql("unit", "insert into workflow_executions (vid, uid, cuid, status) values "
                                         "($1, $2, $3, $4)", f"$1 = '1', $2 = '{user['uid']}', $3 = '{cuid}', "
                                                             f"$4 = '0'")
                        conn.send({"type": "WorkflowStateEvent", "state": "Initializing"})
                        current = Run(self, eid, msg["logicalPlan"], sessions)
                        self.runs[eid] = current
                        self.held[key] = current
                        current.start()
                    elif typ == "OperatorUpdateRequest":
                        run = self.runs.get(msg["executionId"])
                        upd = (self.executions.get(msg["executionId"]) or {}).get("updates", {}).get(msg["updateId"])
                        if run is None or upd is None:  # a change that does not apply, not a refusal event
                            why = (f"Execution {msg['executionId']} is not running here." if run is None
                                   else f"Execution {msg['executionId']} has no change {msg['updateId']}.")
                            conn.send({"type": "ModifyLogicResponse", "opId": "", "isValid": False,
                                       "errorMessage": why})
                        else:
                            run.pending_updates.append(upd)
                            conn.send({"type": "ModifyLogicResponse", "opId": upd["operatorID"], "isValid": True,
                                       "errorMessage": ""})
                    elif typ == "ModifyLogicRequest" and current:
                        op = msg["operator"]
                        current.pending_updates.append(op)
                        conn.send({"type": "ModifyLogicResponse", "opId": op["operatorID"], "isValid": True,
                                   "errorMessage": ""})
                    elif typ == "WorkflowCheckpointRequest":
                        if current:
                            current.checkpoints += 1
                        else:
                            self.refuse(conn, msg, "No execution of this workflow is running here.")
                    elif typ in ("WorkflowPauseRequest", "WorkflowResumeRequest", "WorkflowKillRequest"):
                        run = self.run_asked_for(current, msg)
                        if run is None:
                            self.refuse(conn, msg, f"Execution {msg.get('executionId', 0)} is not running here.")
                        else:
                            {"WorkflowPauseRequest": run.pause, "WorkflowResumeRequest": run.resume,
                             "WorkflowKillRequest": run.kill}[typ]()
                    elif typ == "ResultPaginationRequest":
                        # until sub-part 17 a unit that holds no run of the workflow looks the
                        # workflow's newest execution up in Postgres; from then on the page is empty
                        run = current or (None if self.at("3C") else next(
                            (r for r in reversed(list(self.runs.values()))
                             if self.executions[r.eid]["wid"] == wid), None))
                        rows, schema = run.results(msg["operatorID"]) if run else ([], [])
                        size, page = msg["pageSize"], msg["pageIndex"]
                        # a result table shows the start of a long string cell, as the real one does
                        shown = [{k: v[:100] + "..." if isinstance(v, str) and len(v) > 100 else v
                                  for k, v in row.items()} for row in rows[(page - 1) * size: page * size]]
                        conn.send({"type": "PaginatedResultEvent", "requestID": msg["requestID"],
                                   "table": shown, "schema": schema, "totalTuples": len(rows)})
        finally:
            with self.lock:
                sessions.remove(conn)
                last = not sessions
                held = self.held.get(key)
            if last and held is not None and held.state in ("Completed", "Failed", "Killed"):
                self._schedule_cleanup(held.eid, key)
