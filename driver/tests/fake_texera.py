"""A fake Texera speaking the step-2 protocol of the design (sections 3.4-3.8), for
offline tests of the driver: REST (login, users, workflows, units, warehouses,
POST /api/executions, POST /api/executions/{eid}/updates, environments, the
unit's POST /api/execution/{eid}/run) and websockets (/wsapi/workflow-websocket
with WorkflowStartRequest / OperatorUpdateRequest and the old
WorkflowExecuteRequest / ModifyLogicRequest, /wsapi/pve).

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

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
TUPLE_DELAY_S = 0.004
#: the real unit replayed a held run about 95 ms after the handshake state
REPLAY_DELAY_S = 0.1
STATUS_CODES = {"Uninitialized": 0, "Initializing": 0, "Running": 1, "Paused": 2, "Completed": 3,
                "Failed": 4, "Killed": 5}


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

    def __init__(self, fake: "FakeTexera", eid: int, plan: dict, sessions: list):
        self.fake, self.eid, self.plan = fake, eid, plan
        self.sessions = sessions
        self.state = "Uninitialized"
        self.paused = threading.Event()
        self.killed = threading.Event()
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
        out.append({"type": "WorkflowStateEvent", "state": self.state})
        if self.errors:
            out.append({"type": "WorkflowErrorEvent", "fatalErrors": list(self.errors)})
        return out

    def set_state(self, state: str) -> None:
        self.state = state
        code = STATUS_CODES.get(state)
        if code is not None and state != "Uninitialized":
            if state != "Initializing":
                self.fake.executions[self.eid]["status"] = code
            # design D26: one write-only UPDATE by eid per state change (READY at Initializing)
            self.fake.sql("unit", "update workflow_executions set status = $1, last_update_time = $2 "
                                  "where workflow_executions.eid = $3",
                          f"$1 = '{code}', $2 = '2026-11-16 10:00:00', $3 = '{self.eid}'")
            if state == "Initializing":
                for op in self.ops:
                    self.fake.sql("unit", "insert into operator_port_executions (workflow_execution_id, "
                                          "global_port_id, result_uri) values ($1, $2, $3)",
                                  f"$1 = '{self.eid}', $2 = '{op}-out-0', $3 = 'vfs:///result/{op}'")
            if state in ("Completed", "Failed", "Killed"):
                self.fake.on_terminal(self)
        self.emit({"type": "WorkflowStateEvent", "state": state})

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
            m = re.search(r'tuple_\["tag"\] = "([^"]+)"', code)
            if m:
                out["tag"] = m.group(1)
            if "tabulate.__version__" in code:
                out["tabulate_version"] = "0.9.0"
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

    def run(self) -> None:
        src, rest = self.chain()
        try:
            rows = self.evaluate_source(src)
        except Exception as e:  # noqa: BLE001
            self.fail(str(e))
            return
        out_counts = {op: 0 for op in [src] + rest}
        out_counts[src] = len(rows)
        self.set_state("Running")
        for i, row in enumerate(rows):
            while self.paused.is_set() and not self.killed.is_set():
                time.sleep(0.005)
            if self.killed.is_set():
                return
            current = [row]
            for op_id in rest:
                nxt = []
                for r in current:
                    nxt.extend(self.apply(op_id, r))
                current = nxt
                out_counts[op_id] += len(current)
            self.rows_out.extend(current)
            if i % 10 == 9 or i == len(rows) - 1:
                self.emit({"type": "OperatorStatisticsUpdateEvent", "operatorStatistics": {
                    op: {"operatorState": "Running", "aggregatedInputRowCount": 0,
                         "aggregatedOutputRowCount": n, "numWorkers": 1} for op, n in out_counts.items()}})
            time.sleep(TUPLE_DELAY_S)
        self.set_state("Completed")

    def fail(self, message: str, op: str = "") -> None:
        self.set_state("Failed")
        self.emit({"type": "WorkflowErrorEvent", "fatalErrors": [
            {"type": {"name": "EXECUTION_FAILURE"}, "message": message, "details": "", "operatorId": op,
             "workerId": ""}]})

    def console(self, op: str, msg_type: str, title: str, message: str = "") -> None:
        self.emit({"type": "ConsoleUpdateEvent", "operatorId": op, "messages": [
            {"workerId": "", "timestamp": {"seconds": int(time.time()), "nanos": 0},
             "msgType": {"name": msg_type}, "source": "unit", "title": title, "message": message}]})

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
            self.console(op_id, "PRINT", f"Installing Python environment '{name}' ({len(lines)} packages)")
            time.sleep(0.05)
            bad = [ln for ln in lines if "nonexistent" in ln]
            if bad:
                tail = f"ERROR: No matching distribution found for {bad[0]}"
                self.console(op_id, "ERROR", f"Python environment '{name}' could not be installed", tail)
                self.set_state("Failed")
                self.emit({"type": "WorkflowErrorEvent", "fatalErrors": [
                    {"type": {"name": "EXECUTION_FAILURE"},
                     "message": f"Python environment '{name}' could not be installed: {tail}",
                     "details": tail, "operatorId": op_id, "workerId": ""}]})
                return False
            self.fake.installed_envs[key] = {"requirements": lines, "name": name}
            self.console(op_id, "PRINT", f"Python environment '{name}' is ready (0.1 s)", "\n".join(lines))
        return True

    def start(self) -> None:
        self.set_state("Initializing")

        def go():
            if self.fake.executions[self.eid].get("plan_uri") and not self.install_environments():
                return
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
        self.set_state("Killed")

    def results(self, op_id: str) -> tuple[list[dict], list[dict]]:
        rows = self.rows_out if op_id == self.sink() else []
        schema = []
        for k, v in (rows[0].items() if rows else []):
            schema.append({"attributeName": k, "attributeType":
                           "integer" if isinstance(v, int) else "double" if isinstance(v, float) else "string"})
        return rows, schema


class FakeTexera:
    def __init__(self, *, warehouses: bool = True, replay_log: bool = False):
        self.lock = threading.RLock()
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
            if key is not None and self.sessions_by_key.get(key):
                return  # somebody opened the workflow again
            if key is not None:
                self.held.pop(key, None)
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
                data = b"" if body is None else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self, method: str):
                parts = urllib.parse.urlsplit(self.path)
                body = self._body() if method in ("POST", "PUT") else None
                token = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
                fake.rest_log.append({"method": method, "path": parts.path, "body": body, "token": token})
                status, out = fake.route(method, parts.path, urllib.parse.parse_qs(parts.query), body, token)
                self._reply(status, out)
                if fake.access_sink is not None:
                    fake.access_sink(method, parts.path, status)

            def do_GET(self):
                if (self.headers.get("Upgrade") or "").lower() == "websocket":
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
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self) -> None:
        for run in self.runs.values():
            run.killed.set()
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

    def entry(self, eid: int) -> dict:
        e = self.executions[eid]
        return {"eId": eid, "vId": 1, "cuId": e["cuid"], "whId": e.get("whid"), "status": e["status"],
                "result": "", "name": e.get("name", ""), "logLocation": e.get("log")}

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
                return 200, [{"computingUnit": {"cuid": c, **u}} for c, u in self.units.items()
                             if u["uid"] == uid and not u.get("terminateTime")]
            if path == "/api/computing-unit/create":
                cuid = self.next["cuid"]
                self.next["cuid"] += 1
                self.units[cuid] = {"uid": uid, "name": body["name"], "uri": body["uri"], "type": "local"}
                return 200, {"computingUnit": {"cuid": cuid, **self.units[cuid]}}
            m = re.fullmatch(r"/api/computing-unit/(\d+)/terminate", path)
            if m and method == "DELETE":
                self.units[int(m.group(1))]["terminateTime"] = time.time()
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
            m = re.fullmatch(r"/api/executions/(\d+)/latest", path)
            if m:
                eids = [e for e, x in self.executions.items() if x["wid"] == int(m.group(1))]
                return (200, self.entry(max(eids))) if eids else (404, None)
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
                return 200, [self.entry(e) for e, x in sorted(self.executions.items(), reverse=True) if x["wid"] == wid]
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
                return self.sync_run(user, int(m.group(1)), body)
            return self.err(404, f"no route {method} {path}")

    def create(self, uid: int, body: dict):
        """Design 3.4 and section 4 Create, steps 1-11."""
        if not isinstance(body, dict) or "wid" not in body or "computingUnitId" not in body \
                or not isinstance(body.get("logicalPlan"), dict):
            return self.err(400, "malformed request")
        wid, cuid = body["wid"], body["computingUnitId"]
        if self.workflows.get(wid, {}).get("owner") != uid:
            return self.err(403, f"no READ access to workflow {wid}")
        unit = self.units.get(cuid)
        if unit is None or unit["uid"] != uid:
            return self.err(403, f"no WRITE access to computing unit {cuid}")
        if unit.get("terminateTime"):
            return self.err(409, f"computing unit {cuid} is terminated")
        whid = body.get("warehouseId")
        if self.warehouses_enabled:
            if whid is None or self.warehouses.get(whid, {}).get("uid") != uid:
                return self.err(400, f"warehouse {whid} is missing or not yours")
        elif whid is not None:
            return self.err(400, "warehouses are disabled")
        replay = body.get("replayFromExecution")
        if replay:
            src = self.executions.get(replay["eid"])
            if src is None or src["wid"] != wid or not src.get("log"):
                return self.err(400, "the replay source is of another workflow or has no log")
        eid = self.next["eid"]
        self.next["eid"] += 1
        self.executions[eid] = {"wid": wid, "cuid": cuid, "uid": uid, "whid": whid, "status": 0,
                                "name": body.get("executionName", ""), "plan": body["logicalPlan"],
                                "started": False, "log": (f"file:///logs/{wid}/{eid}/" if self.replay_log else None),
                                "targets": body.get("targetOperatorIds") or [], "updates": {},
                                "plan_uri": self.plan_uri(uid, whid, wid, eid)}
        self.sql("dashboard", "insert into workflow_executions (vid, uid, cuid, whid, status) values "
                              "($1, $2, $3, $4, $5) returning eid",
                 f"$1 = '1', $2 = '{uid}', $3 = '{cuid}', $4 = '{whid}', $5 = '0'")
        errors = self.compile_errors(uid, body["logicalPlan"])
        if errors:
            self.executions[eid]["status"] = 4
            self.sql("dashboard", "update workflow_executions set status = $1 where workflow_executions.eid = $2",
                     f"$1 = '4', $2 = '{eid}'")
            return 400, {"eid": eid, "operatorErrors": errors, "errors": []}
        return 201, {"eid": eid, "wid": wid, "computingUnitId": cuid, "planUri": self.executions[eid]["plan_uri"]}

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
        """Design 3.5."""
        e = self.executions.get(eid)
        if e is None:
            return self.err(404, f"execution {eid} does not exist")
        if e["uid"] != uid:
            return self.err(403, f"only the creator of execution {eid} may change it")
        if e["status"] in (3, 4, 5):
            return self.err(409, f"execution {eid} has ended")
        op = body["operator"]
        if op["operatorID"] not in {o["operatorID"] for o in e["plan"]["operators"]}:
            return self.err(404, "operator not in the plan")
        update_id = f"update-{len(e['updates']) + 1:04d}-4f6c"
        e["updates"][update_id] = op
        return 200, {"updateId": update_id, "operatorId": op["operatorID"]}

    def start_checks(self, user: dict, eid: int, plan_uri: str, wid: int | None, cuid: int) -> str | None:
        """Section 4 Start, steps 1-6: the refusal message, or None."""
        m = re.fullmatch(r"vfs:///(?:wh/([^/]+)/)?wid/(\d+)/eid/(\d+)/plan", plan_uri or "")
        if not m:
            return "not an execution plan"
        if int(m.group(3)) != eid:
            return f"the plan is execution {m.group(3)}'s, not {eid}'s"
        if wid is not None and int(m.group(2)) != wid:
            return f"the plan belongs to workflow {m.group(2)}, not to this one"
        if m.group(1) and not re.fullmatch(rf"user-{user['uid']}-\d+", m.group(1)):
            return "the plan is in another user's warehouse"
        e = self.executions.get(eid)
        if e is None or e["plan_uri"] != plan_uri:
            return f"execution {eid} has no stored plan"
        if e["uid"] != user["uid"]:
            return f"only the user who created execution {eid} may start it"
        if e["cuid"] != cuid:
            return f"execution {eid} was created for computing unit {e['cuid']}, not {cuid}"
        if e["started"]:
            return f"execution {eid} was already started"
        return None

    def sync_run(self, user: dict, eid: int, body: dict):
        """Design 3.7: the unit's REST path for agents."""
        refused = self.start_checks(user, eid, body.get("planUri"), None, body.get("computingUnitId"))
        if refused:
            return 200, {"success": False, "state": "Error", "operators": {}, "errors": [refused]}
        e = self.executions[eid]
        e["started"] = True
        run = Run(self, eid, e["plan"], [])
        self.runs[eid] = run
        target = (body.get("targetOperatorIds") or [None])[0]
        if target:
            run.plan = dict(e["plan"], opsToViewResult=[target])
            run.ops = {o["operatorID"]: dict(o) for o in e["plan"]["operators"]}
        run.set_state("Initializing")  # READY, then the run
        run.run()
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
        conn.send({"type": "WorkflowStateEvent", "state": "Uninitialized"})
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
                            conn.send({"type": "WorkflowErrorEvent", "fatalErrors": [
                                {"type": {"name": "EXECUTION_FAILURE"}, "message": refused, "details": "",
                                 "operatorId": "", "workerId": ""}]})
                            continue
                        e = self.executions[msg["executionId"]]
                        e["started"] = True
                        current = Run(self, msg["executionId"], e["plan"], sessions)
                        self.runs[current.eid] = current
                        self.held[key] = current
                        current.start()
                    elif typ == "WorkflowExecuteRequest":  # the old path: the unit creates
                        eid = self.next["eid"]
                        self.next["eid"] += 1
                        self.executions[eid] = {"wid": wid, "cuid": cuid, "uid": user["uid"], "status": 0,
                                                "plan": msg["logicalPlan"], "started": True, "log": None,
                                                "updates": {}, "plan_uri": None}
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
                        if run is None or upd is None:
                            conn.send({"type": "ModifyLogicResponse", "opId": "", "isValid": False,
                                       "errorMessage": f"execution {msg['executionId']} is not running here"})
                        else:
                            run.pending_updates.append(upd)
                            conn.send({"type": "ModifyLogicResponse", "opId": upd["operatorID"], "isValid": True,
                                       "errorMessage": ""})
                    elif typ == "ModifyLogicRequest" and current:
                        op = msg["operator"]
                        current.pending_updates.append(op)
                        conn.send({"type": "ModifyLogicResponse", "opId": op["operatorID"], "isValid": True,
                                   "errorMessage": ""})
                    elif typ == "WorkflowCheckpointRequest" and current:
                        current.checkpoints += 1
                    elif typ == "WorkflowPauseRequest" and current:
                        current.pause()
                    elif typ == "WorkflowResumeRequest" and current:
                        current.resume()
                    elif typ == "WorkflowKillRequest":
                        if current:
                            current.kill()
                        else:
                            conn.send({"type": "WorkflowErrorEvent", "fatalErrors": [
                                {"type": {"name": "COMPILATION_ERROR"}, "message": "workflow execution is not initialized",
                                 "operatorId": "unknown operator"}]})
                    elif typ == "ResultPaginationRequest":
                        run = current or next((r for r in reversed(list(self.runs.values()))
                                               if self.executions[r.eid]["wid"] == wid), None)
                        rows, schema = run.results(msg["operatorID"]) if run else ([], [])
                        size, page = msg["pageSize"], msg["pageIndex"]
                        conn.send({"type": "PaginatedResultEvent", "requestID": msg["requestID"],
                                   "table": rows[(page - 1) * size: page * size], "schema": schema,
                                   "totalTuples": len(rows)})
        finally:
            with self.lock:
                sessions.remove(conn)
                last = not sessions
                held = self.held.get(key)
            if last and held is not None and held.state in ("Completed", "Failed", "Killed"):
                self._schedule_cleanup(held.eid, key)
