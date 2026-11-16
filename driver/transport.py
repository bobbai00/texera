"""How a run is started, watched and controlled -- the one seam later steps swap.

Scenarios only see `Transport.start_run(...) -> RunHandle` and the RunHandle
methods (wait_for_state, pause, resume, kill, stats, console, results,
summary, close). A new way of running (e.g. "the Dashboard creates the
execution, the gateway routes start/watch/commands to the unit") is a new
Transport subclass registered in TRANSPORTS; the scenarios stay unchanged.

The only transport today, `ws` (WebSocketTransport), is the browser's path on
upstream main and on the published images:

  * connect  ws(s)://<gateway>/wsapi/workflow-websocket?wid=W&uid=U&cuid=C&access-token=JWT
    (single-node: nginx -> the one unit container; the unit takes the user from the
    JWT and grants WRITE on the unit because no x-user-* headers are present)
  * start    {"type":"WorkflowExecuteRequest", executionName, engineVersion,
              logicalPlan{operators, links, opsToViewResult, opsToReuseResult},
              replayFromExecution: null, workflowSettings{dataTransferBatchSize, executionMode},
              emailNotificationEnabled, computingUnitId, warehouseId}
  * control  {"type":"WorkflowPauseRequest"} / WorkflowResumeRequest / WorkflowKillRequest
  * results  {"type":"ResultPaginationRequest", requestID, operatorID, pageIndex(1-based), pageSize}
             -> PaginatedResultEvent{requestID, table[], schema[] (+ totalTuples on newer builds)}
  * keepalive {"type":"HeartBeatRequest"} every 10 s (nginx closes idle sockets at 60 s)
  * events   WorkflowStateEvent{state}, WorkflowErrorEvent{fatalErrors},
             OperatorStatisticsUpdateEvent{operatorStatistics{op: metrics}},
             WebResultUpdateEvent{updates{op: {totalNumTuples,...}}},
             ConsoleUpdateEvent{operatorId, messages[{title, message, msgType,...}]}
"""

from __future__ import annotations

import json
import threading
import time
import urllib.parse
import uuid
from abc import ABC, abstractmethod
from typing import Any, Callable, Iterable

import websocket  # websocket-client

TERMINAL_STATES = frozenset({"Completed", "Failed", "Killed", "Terminated"})


class RunFailed(RuntimeError):
    """The run reached a terminal state the caller was not waiting for."""


class RunTimeout(TimeoutError):
    pass


# --------------------------------------------------------------------- interface


class RunHandle(ABC):
    """One execution, as seen by a client that started it."""

    wid: int
    cuid: int

    @abstractmethod
    def wait_for_state(self, *states: str, timeout: float, since_last_command: bool = True,
                       fail_fast: bool = True) -> str:
        """Block until one of `states` is reported (after the last command sent, by
        default). Raise RunFailed if another terminal state arrives first, or (with
        fail_fast) as soon as the run reports a fatal error or an operator error."""

    @abstractmethod
    def wait_until(self, predicate: Callable[[], bool], timeout: float, what: str,
                   fail_fast: bool = True) -> None: ...

    @abstractmethod
    def ensure_stopped(self, timeout: float = 30) -> str | None:
        """Kill the run unless it already ended; return the final state seen."""

    @abstractmethod
    def pause(self) -> None: ...

    @abstractmethod
    def resume(self) -> None: ...

    @abstractmethod
    def kill(self) -> None: ...

    @property
    @abstractmethod
    def states(self) -> list[str]:
        """Workflow states in arrival order, consecutive duplicates collapsed."""

    @property
    @abstractmethod
    def last_state(self) -> str | None: ...

    @property
    @abstractmethod
    def state_log(self) -> list[tuple[float, str]]:
        """Every state report as (seconds since start_run on the client clock, state)."""

    @property
    @abstractmethod
    def command_log(self) -> list[tuple[float, str]]:
        """Every command sent as (seconds since start_run, label)."""

    @property
    @abstractmethod
    def fatal_errors(self) -> list[dict]: ...

    @abstractmethod
    def stats(self, operator_id: str) -> dict:
        """Latest metrics of one operator ({} if none yet)."""

    def output_rows(self, operator_id: str) -> int:
        return int(self.stats(operator_id).get("aggregatedOutputRowCount", 0) or 0)

    def input_rows(self, operator_id: str) -> int:
        return int(self.stats(operator_id).get("aggregatedInputRowCount", 0) or 0)

    @abstractmethod
    def console(self, operator_id: str | None = None) -> list[dict]:
        """Console messages received so far (of one operator, or all)."""

    @abstractmethod
    def results(self, operator_id: str, page_size: int = 100, timeout: float = 60) -> dict:
        """All result rows of the operator's first output port:
        {"columns": [(name, type)], "rows": [dict], "pages": n, "reported_total": int|None}."""

    @abstractmethod
    def summary(self) -> dict:
        """Plain-data digest of what the transport observed, for the JSON report."""

    @abstractmethod
    def close(self) -> None: ...


class Transport(ABC):
    name = "abstract"

    @abstractmethod
    def start_run(self, *, wid: int, cuid: int, warehouse_id: int | None, logical_plan: dict,
                  execution_name: str, settings: dict | None = None) -> RunHandle: ...

    def describe(self) -> dict:
        return {"name": self.name}


# --------------------------------------------------------------- websocket impl


def _now() -> float:
    return time.monotonic()


def console_type(m: dict) -> str:
    """ConsoleMessage.msgType arrives as a serialized scalapb enum
    ({"name": "PRINT", "value": 0, ...}) on current builds; accept a bare string too."""
    t = m.get("msgType")
    if isinstance(t, dict):
        return str(t.get("name") or t.get("value") or "").upper()
    return str(t or "").upper()


class WebSocketRunHandle(RunHandle):
    def __init__(self, url: str, wid: int, cuid: int, *, heartbeat_s: float = 10.0,
                 log: Callable[[str], None] = print, connect_timeout: float = 30.0):
        self.wid, self.cuid = wid, cuid
        self._url = url
        self._log = log
        self._cv = threading.Condition()
        self._t0 = _now()
        self._closed = False
        self._reader_error: str | None = None

        self._state_log: list[tuple[float, str]] = []  # every state event, with time
        self._command_marks: list[tuple[float, str, int]] = []  # (t, cmd, state index)
        self._errors: list[dict] = []
        self._stats: dict[str, dict] = {}
        self._stats_events = 0
        self._console: list[dict] = []
        self._result_updates: dict[str, dict] = {}
        self._pages: dict[str, dict] = {}
        self._type_counts: dict[str, int] = {}
        self._other: list[dict] = []

        self._ws = websocket.create_connection(url, timeout=connect_timeout,
                                               enable_multithread=True)
        self._ws.settimeout(None)
        self._reader = threading.Thread(target=self._read_loop, name=f"ws-reader-{wid}",
                                        daemon=True)
        self._reader.start()
        self._hb_stop = threading.Event()
        self._hb = threading.Thread(target=self._heartbeat_loop, args=(heartbeat_s,),
                                    name=f"ws-heartbeat-{wid}", daemon=True)
        self._hb.start()

    # ------------------------------------------------------------------ threads

    def _elapsed(self) -> float:
        return round(_now() - self._t0, 2)

    def _read_loop(self) -> None:
        while True:
            try:
                raw = self._ws.recv()
            except Exception as e:  # closed or broken
                with self._cv:
                    if not self._closed:
                        self._reader_error = f"{type(e).__name__}: {e}"
                    self._cv.notify_all()
                return
            if raw is None or raw == "":
                with self._cv:
                    if not self._closed:
                        self._reader_error = "websocket closed by server"
                    self._cv.notify_all()
                return
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            self._on_message(msg)

    def _heartbeat_loop(self, every: float) -> None:
        while not self._hb_stop.wait(every):
            try:
                self._send({"type": "HeartBeatRequest"})
            except Exception:
                return

    def _on_message(self, msg: dict) -> None:
        typ = msg.get("type", "?")
        with self._cv:
            self._type_counts[typ] = self._type_counts.get(typ, 0) + 1
            if typ == "WorkflowStateEvent":
                state = msg.get("state")
                self._state_log.append((self._elapsed(), state))
                self._log(f"state {state} (+{self._elapsed()}s)")
            elif typ == "WorkflowErrorEvent":
                for err in msg.get("fatalErrors") or []:
                    self._errors.append(err)
                    self._log(f"error event: {str(err.get('message'))[:300]}")
            elif typ == "OperatorStatisticsUpdateEvent":
                self._stats_events += 1
                for op, metrics in (msg.get("operatorStatistics") or {}).items():
                    self._stats[op] = metrics
            elif typ == "ConsoleUpdateEvent":
                op = msg.get("operatorId")
                for m in msg.get("messages") or []:
                    self._console.append(dict(m, operatorId=op))
            elif typ == "WebResultUpdateEvent":
                for op, upd in (msg.get("updates") or {}).items():
                    self._result_updates[op] = upd
            elif typ == "PaginatedResultEvent":
                self._pages[msg.get("requestID")] = msg
            elif typ not in ("HeartBeatResponse", "ClusterStatusUpdateEvent",
                             "WorkerAssignmentUpdateEvent", "ExecutionDurationUpdateEvent",
                             "RegionStateEvent", "RegionUpdateEvent"):
                if len(self._other) < 50:
                    self._other.append(msg)
            self._cv.notify_all()

    def _send(self, msg: dict) -> None:
        self._ws.send(json.dumps(msg))

    def send_command(self, msg: dict, label: str, mark: bool = True) -> None:
        """Send a request. `mark` records it as a command, which moves the cursor
        wait_for_state(since_last_command=True) starts from."""
        if mark:
            with self._cv:
                self._command_marks.append((self._elapsed(), label, len(self._state_log)))
            self._log(f"send {label} (+{self._elapsed()}s)")
        self._send(msg)

    # ------------------------------------------------------------------- waits

    def _failure_reason(self) -> str | None:
        """Why the run cannot make progress any more (lock held), or None.

        A fatal error event ends a run. An ERROR console message does too in
        practice: on an exception Texera pauses the Python worker for debugging
        and the workflow state stays Running, so without this a broken UDF would
        only surface as a timeout."""
        if self._errors:
            e = self._errors[0]
            return f"fatal error ({e.get('type')}) on {e.get('operatorId')}: {str(e.get('message'))[:500]}"
        for m in self._console:
            if console_type(m) == "ERROR":
                return (f"operator {m.get('operatorId')} reported an error (its worker pauses): "
                        f"{(m.get('title') or '').strip()[:300]}\n{(m.get('message') or '')[-1500:]}")
        return None

    def wait_until(self, predicate: Callable[[], bool], timeout: float, what: str,
                   fail_fast: bool = True) -> None:
        deadline = _now() + timeout
        with self._cv:
            while not predicate():
                if self._reader_error:
                    raise RunFailed(f"connection lost while waiting for {what}: {self._reader_error}")
                if fail_fast:
                    reason = self._failure_reason()
                    if reason:
                        raise RunFailed(f"while waiting for {what}: {reason}")
                left = deadline - _now()
                if left <= 0:
                    raise RunTimeout(f"timed out after {timeout}s waiting for {what}; "
                                     f"states so far: {self.states}")
                self._cv.wait(min(left, 1.0))

    def ensure_stopped(self, timeout: float = 30) -> str | None:
        if self.last_state in TERMINAL_STATES or self._reader_error or self._closed:
            return self.last_state
        try:
            self.kill()
            return self.wait_for_state(*TERMINAL_STATES, timeout=timeout, fail_fast=False)
        except Exception:  # best effort: the scenario has already failed
            return self.last_state

    def wait_for_state(self, *states: str, timeout: float, since_last_command: bool = True,
                       fail_fast: bool = True) -> str:
        wanted = set(states)
        with self._cv:
            start = self._command_marks[-1][2] if (since_last_command and self._command_marks) else 0
        outcome: dict[str, str] = {}

        def check() -> bool:
            for _, s in self._state_log[start:]:
                if s in wanted:
                    outcome["found"] = s
                    return True
                if s in TERMINAL_STATES:
                    outcome["ended"] = s
                    return True
            return False

        self.wait_until(check, timeout, f"state in {sorted(wanted)}", fail_fast=fail_fast)
        if "found" in outcome:
            return outcome["found"]
        # The unit sends the Failed state before the WorkflowErrorEvent explaining it.
        try:
            self.wait_until(lambda: bool(self._errors), 3, "the error event", fail_fast=False)
        except RunTimeout:
            pass
        raise RunFailed(f"run ended {outcome['ended']} while waiting for {sorted(wanted)}; errors: "
                        f"{[str(e.get('message'))[:400] for e in self.fatal_errors][:3]}")

    # ----------------------------------------------------------------- control

    def execute(self, request: dict) -> None:
        self.send_command(request, "WorkflowExecuteRequest")

    def pause(self) -> None:
        self.send_command({"type": "WorkflowPauseRequest"}, "WorkflowPauseRequest")

    def resume(self) -> None:
        self.send_command({"type": "WorkflowResumeRequest"}, "WorkflowResumeRequest")

    def kill(self) -> None:
        self.send_command({"type": "WorkflowKillRequest"}, "WorkflowKillRequest")

    # ---------------------------------------------------------------- observed

    @property
    def states(self) -> list[str]:
        with self._cv:
            out: list[str] = []
            for _, s in self._state_log:
                if not out or out[-1] != s:
                    out.append(s)
            return out

    @property
    def last_state(self) -> str | None:
        with self._cv:
            return self._state_log[-1][1] if self._state_log else None

    @property
    def state_log(self) -> list[tuple[float, str]]:
        with self._cv:
            return list(self._state_log)

    @property
    def command_log(self) -> list[tuple[float, str]]:
        with self._cv:
            return [(t, c) for t, c, _ in self._command_marks]

    @property
    def fatal_errors(self) -> list[dict]:
        with self._cv:
            return list(self._errors)

    def stats(self, operator_id: str) -> dict:
        with self._cv:
            return dict(self._stats.get(operator_id) or {})

    def console(self, operator_id: str | None = None) -> list[dict]:
        with self._cv:
            return [m for m in self._console if operator_id is None or m.get("operatorId") == operator_id]

    def results(self, operator_id: str, page_size: int = 100, timeout: float = 60) -> dict:
        rows: list[dict] = []
        columns: list[tuple[str, str]] = []
        reported_total = None
        page = 1
        while True:
            rid = f"sce-{uuid.uuid4().hex[:12]}"
            self.send_command({"type": "ResultPaginationRequest", "requestID": rid,
                               "operatorID": operator_id, "pageIndex": page,
                               "pageSize": page_size}, "ResultPaginationRequest", mark=False)
            self.wait_until(lambda: rid in self._pages, timeout, f"result page {page} of {operator_id}",
                            fail_fast=False)
            with self._cv:
                evt = self._pages.pop(rid)
                update = self._result_updates.get(operator_id) or {}
            if evt.get("totalTuples") is not None:
                reported_total = int(evt["totalTuples"])
            elif update.get("totalNumTuples") is not None:
                reported_total = int(update["totalNumTuples"])
            if evt.get("schema") and not columns:
                columns = [(a.get("attributeName"), a.get("attributeType")) for a in evt["schema"]]
            table = evt.get("table") or []
            rows.extend(table)
            if len(table) < page_size:
                break
            if reported_total is not None and len(rows) >= reported_total:
                break
            page += 1
        return {"columns": columns, "rows": rows, "pages": page, "reported_total": reported_total}

    def summary(self) -> dict:
        with self._cv:
            return {
                "states": self.states,
                "state_log": [{"t": t, "state": s} for t, s in self._state_log],
                "commands": [{"t": t, "command": c} for t, c, _ in self._command_marks],
                "fatal_errors": [{k: e.get(k) for k in ("type", "message", "operatorId", "workerId")}
                                 for e in self._errors],
                "operator_stats": {op: {k: m.get(k) for k in ("operatorState", "aggregatedInputRowCount",
                                                              "aggregatedOutputRowCount", "numWorkers")}
                                   for op, m in self._stats.items()},
                "stats_events": self._stats_events,
                "console_messages": len(self._console),
                "console_sample": self._console[:3],
                "event_counts": dict(self._type_counts),
                "other_events": self._other[:10],
                "connection_error": self._reader_error,
            }

    def close(self) -> None:
        with self._cv:
            self._closed = True
        self._hb_stop.set()
        try:
            self._ws.close()
        except Exception:
            pass
        self._reader.join(timeout=5)


class WebSocketTransport(Transport):
    """Start/watch/control through the unit's websocket behind the gateway."""

    name = "ws"

    def __init__(self, base: str, token_provider: Callable[[], str], uid_provider: Callable[[], int],
                 *, engine_version: str = "sce-e2e", log: Callable[[str], None] = print,
                 heartbeat_s: float = 10.0, api: Any = None):
        # `api` (the driver's TexeraApi) is unused here; it is part of the factory
        # signature so a transport that creates executions over REST can use it.
        parts = urllib.parse.urlsplit(base)
        scheme = "wss" if parts.scheme == "https" else "ws"
        self.ws_base = urllib.parse.urlunsplit((scheme, parts.netloc, parts.path.rstrip("/"), "", ""))
        self._token = token_provider
        self._uid = uid_provider
        self.engine_version = engine_version
        self._log = log
        self.heartbeat_s = heartbeat_s

    def describe(self) -> dict:
        return {"name": self.name, "endpoint": f"{self.ws_base}/wsapi/workflow-websocket"}

    def start_run(self, *, wid: int, cuid: int, warehouse_id: int | None, logical_plan: dict,
                  execution_name: str, settings: dict | None = None) -> RunHandle:
        query = urllib.parse.urlencode({"wid": wid, "uid": self._uid(), "cuid": cuid,
                                        "access-token": self._token()})
        url = f"{self.ws_base}/wsapi/workflow-websocket?{query}"
        handle = WebSocketRunHandle(url, wid, cuid, heartbeat_s=self.heartbeat_s, log=self._log)
        request: dict[str, Any] = {
            "type": "WorkflowExecuteRequest",
            "executionName": execution_name,
            "engineVersion": self.engine_version,
            "logicalPlan": logical_plan,
            "replayFromExecution": None,
            "workflowSettings": settings or {"dataTransferBatchSize": 400,
                                             "executionMode": "PIPELINED"},
            "emailNotificationEnabled": False,
            "computingUnitId": cuid,
        }
        if warehouse_id is not None:
            request["warehouseId"] = warehouse_id
        try:
            # The unit answers the handshake with a WorkflowStateEvent("Uninitialized");
            # waiting for it means the session is subscribed before we execute.
            handle.wait_until(lambda: bool(handle._state_log), 30, "websocket session to open")
            handle.execute(request)
        except Exception:
            handle.close()
            raise
        return handle


TRANSPORTS: dict[str, type[Transport]] = {"ws": WebSocketTransport}


def make_transport(name: str, **kw) -> Transport:
    if name not in TRANSPORTS:
        raise SystemExit(f"unknown transport '{name}'; known: {', '.join(TRANSPORTS)}")
    return TRANSPORTS[name](**kw)


def unique(seq: Iterable[str]) -> list[str]:
    seen, out = set(), []
    for s in seq:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out
