"""How a run is started, watched and controlled -- the one seam later steps swap.

Scenarios only see `Transport.start_run(...) -> RunHandle` and the RunHandle
methods (wait_for_state, pause, resume, kill, stats, console, results,
modify_operator, summary, close). A new way of running is a new Transport
subclass registered in TRANSPORTS; the scenarios stay unchanged.

Two transports:

  * `ws` (WebSocketTransport): the browser's path on upstream main, the
    published images and step 2's PR A: the unit creates the execution.
  * `create-ws` (CreateStartTransport): step 2 from PR B on: the Dashboard
    creates the execution (POST /api/executions -> 201 {eid, planUri}), then the
    socket starts it by id (WorkflowStartRequest{executionId, planUri}). A paused
    operator's change is posted to the Dashboard (POST
    /api/executions/{eid}/updates -> 201 {updateId, operatorId}) and named to the
    unit (OperatorUpdateRequest{executionId, updateId}). A pause, a resume and a
    kill name their execution too ({executionId}); the unit refuses one that is
    not the run it holds. What the unit does not do of what a connection asked,
    it answers to that connection alone, as RequestRefusedEvent{request,
    executionId, message}: a WorkflowErrorEvent carries only a run's errors.

`ws`, on the wire:

  * connect  ws(s)://<gateway>/wsapi/workflow-websocket?wid=W&uid=U&cuid=C&access-token=JWT
    (single-node: nginx -> the one unit container; the unit takes the user from the
    JWT and grants WRITE on the unit because no x-user-* headers are present)
  * start    {"type":"WorkflowExecuteRequest", executionName, engineVersion,
              logicalPlan{operators, links, opsToViewResult, opsToReuseResult},
              replayFromExecution: null, workflowSettings{dataTransferBatchSize, executionMode},
              emailNotificationEnabled, computingUnitId, warehouseId}
  * control  {"type":"WorkflowPauseRequest"} / WorkflowResumeRequest / WorkflowKillRequest
             (with executionId once the handle knows its execution: always on create-ws)
  * results  {"type":"ResultPaginationRequest", requestID, operatorID, pageIndex(1-based), pageSize}
             -> PaginatedResultEvent{requestID, table[], schema[] (+ totalTuples on newer builds)}
  * keepalive {"type":"HeartBeatRequest"} every 10 s (nginx closes idle sockets at 60 s)
  * events   WorkflowStateEvent{state, executionId (step 2's sub-part 14 on; null when the
             unit holds no run of the workflow)}, WorkflowErrorEvent{fatalErrors},
             RequestRefusedEvent{request, executionId, message} (step 2's review fixes on),
             OperatorStatisticsUpdateEvent{operatorStatistics{op: metrics}},
             WebResultUpdateEvent{updates{op: {totalNumTuples,...}}},
             ConsoleUpdateEvent{operatorId, messages[{title, message, msgType,...}]},
             ModifyLogicResponse{opId, isValid, errorMessage}, ModifyLogicCompletedEvent{opIds}
  * modify   {"type":"ModifyLogicRequest", operator} (the operator JSON of the logical plan)

A transport calls `phase_hook(phase, info)` when it has one (the evidence
marks): "create" before an execution is created, "created" with its eid once
the Dashboard answered, "start" before the start is sent.

The open sequence. The unit answers a new connection (WorkflowWebsocketResource.
myOnOpen) with WorkflowStateEvent "Uninitialized", then replays the execution the
workflow holds, if any (its statistics, console, state and errors: a second socket
on a completed run gets "Completed" and the old console), and sends
ClusterStatusUpdateEvent last. `open_socket` returns only after that event, so
every replayed event precedes the first command. The handle keeps the open
sequence apart (`replayed`, and "opened" in the summary); its views (states,
state_log, console, fatal_errors, error_event_count, stats, modify_*) hold only
what arrived after it. A deployment that does not send ClusterStatusUpdateEvent
ends the sequence after OPEN_CLUSTER_WAIT_S and then OPEN_QUIET_S without a
message. Events of a run that is still live on the workflow keep arriving after
the open; the scenarios start a run on a workflow only when nothing runs there.
"""

from __future__ import annotations

import base64
import json
import threading
import time
import urllib.parse
import uuid
from abc import ABC, abstractmethod
from typing import Any, Callable, Iterable

import websocket  # websocket-client

TERMINAL_STATES = frozenset({"Completed", "Failed", "Killed", "Terminated"})
DEFAULT_SETTINGS = {"dataTransferBatchSize": 400, "executionMode": "PIPELINED"}
#: the unit's open sequence ends with this event (see the module doc)
OPEN_SEQUENCE_END = "ClusterStatusUpdateEvent"
#: without that event: wait this long after the handshake state, then for a quiet period
OPEN_CLUSTER_WAIT_S = 5.0
OPEN_QUIET_S = 1.0


class RunFailed(RuntimeError):
    """The run reached a terminal state the caller was not waiting for."""


class RunTimeout(TimeoutError):
    pass


class _HttpRefused(RuntimeError):
    def __init__(self, what: str, status: int, body: Any):
        self.status = status
        self.body = body  # parsed JSON when the answer was JSON, else the text
        message = body.get("message") if isinstance(body, dict) else None
        super().__init__(f"{what} refused: HTTP {status}: {str(message or body)[:600]}")


class CreateRefused(_HttpRefused):
    """POST /api/executions answered something other than 201."""

    def __init__(self, status: int, body: Any):
        super().__init__("create", status, body)


class UpdateRefused(_HttpRefused):
    """POST /api/executions/{eid}/updates answered 4xx/5xx."""

    def __init__(self, status: int, body: Any):
        super().__init__("operator update", status, body)


def response_body(resp) -> Any:
    try:
        return resp.json()
    except ValueError:
        return resp.text


def jwt_claims(token: str) -> dict:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


# --------------------------------------------------------------------- interface


class RunHandle(ABC):
    """One execution, as seen by a client that started it."""

    wid: int
    cuid: int
    #: the execution id. `create-ws` knows it from the create. A socket that only joined
    #: a workflow learns it from the first WorkflowStateEvent that names an execution
    #: (the run the unit holds there). None on `ws` against a unit that names none,
    #: where the driver reads it back (TexeraApi.latest_execution)
    eid: int | None = None
    #: the plan's location the Dashboard returned (`create-ws` only)
    plan_uri: str | None = None

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
        """Workflow states in arrival order after the open sequence, consecutive
        duplicates collapsed (the handshake and any replayed state are in `replayed`)."""

    @property
    @abstractmethod
    def last_state(self) -> str | None: ...

    @property
    @abstractmethod
    def state_log(self) -> list[tuple[float, str]]:
        """Every state report after the open sequence as (seconds since the socket
        opened on the client clock, state)."""

    @property
    def replayed(self) -> dict:
        """What the unit sent while the socket opened: the handshake state and its
        replay of the execution the workflow held."""
        return {}

    @property
    @abstractmethod
    def command_log(self) -> list[tuple[float, str]]:
        """Every command sent as (seconds since start_run, label)."""

    @property
    @abstractmethod
    def fatal_errors(self) -> list[dict]: ...

    @property
    def refusals(self) -> list[dict]:
        """What the unit refused of what this connection asked, in arrival order: each a
        RequestRefusedEvent, {request, executionId, message}. It says nothing of the run
        the unit holds, which is as it was."""
        return []

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

    def modify_operator(self, operator_json: dict, timeout: float = 60) -> dict:
        """Change an operator of the paused run. Returns {"response": ModifyLogicResponse,
        plus "updateId"/"operatorId" on create-ws}; raises UpdateRefused on a 4xx/5xx."""
        raise NotImplementedError(f"{type(self).__name__} cannot change operators")

    def send_raw(self, msg: dict, label: str | None = None) -> None:
        """Send any message on the run's connection (not a state command)."""
        raise NotImplementedError(f"{type(self).__name__} has no raw channel")

    @abstractmethod
    def summary(self) -> dict:
        """Plain-data digest of what the transport observed, for the JSON report."""

    @abstractmethod
    def close(self) -> None: ...


class Transport(ABC):
    name = "abstract"
    #: phase_hook(phase, info) -> optional record; set by the driver (evidence marks)
    phase_hook: Callable[[str, dict], Any] | None = None

    @abstractmethod
    def start_run(self, *, wid: int, cuid: int, warehouse_id: int | None, logical_plan: dict,
                  execution_name: str, settings: dict | None = None,
                  replay_from: dict | None = None) -> RunHandle: ...

    def create_only(self, **kw) -> Any:
        """Create an execution without starting it; the raw HTTP response."""
        raise NotImplementedError(f"transport {self.name} has no separate create")

    def start_existing(self, *, wid: int, cuid: int, eid: int, plan_uri: str,
                       token: str | None = None, uid: int | None = None) -> RunHandle:
        """Open a socket (as the token's user) and send only the start of `eid`."""
        raise NotImplementedError(f"transport {self.name} cannot start an existing execution")

    def describe(self) -> dict:
        return {"name": self.name}

    def _phase(self, phase: str, info: dict) -> Any:
        hook = self.phase_hook
        return hook(phase, info) if hook else None


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
        self._refusals: list[dict] = []
        self._refusals_before_command = 0  # how many had arrived when the last command went out
        self._stats: dict[str, dict] = {}
        self._stats_events = 0
        self._console: list[dict] = []
        self._result_updates: dict[str, dict] = {}
        self._pages: dict[str, dict] = {}
        self._type_counts: dict[str, int] = {}
        self._other: list[dict] = []
        self._modify_responses: list[dict] = []
        self._modify_completed: list[dict] = []
        self._error_events = 0
        self._sent_other: list[tuple[float, str]] = []
        # The open sequence (module doc): until it ends, what arrives is the unit's
        # answer to the connection, not this run's.
        self._opening = True
        self._handshake_at: float | None = None  # monotonic time of the first state
        self._last_message_at = _now()
        self._replay: dict[str, Any] = {}
        #: the execution the newest state event named (None: it named none)
        self._named_eid: int | None = None
        self.eid: int | None = None
        self.plan_uri: str | None = None
        #: create-ws: posts an operator change to the Dashboard -> requests.Response
        self.update_poster: Callable[[int, dict], Any] | None = None

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
            self._last_message_at = _now()
            self._type_counts[typ] = self._type_counts.get(typ, 0) + 1
            if typ == OPEN_SEQUENCE_END and self._opening and self._handshake_at is not None:
                self._close_open_sequence(OPEN_SEQUENCE_END)
            elif typ == "WorkflowStateEvent":
                state = msg.get("state")
                if self._opening and self._handshake_at is None:
                    self._handshake_at = _now()
                named = msg.get("executionId")
                self._named_eid = int(named) if named is not None else None
                if self.eid is None:
                    self.eid = self._named_eid
                self._state_log.append((self._elapsed(), state))
                self._log(f"state {state} (+{self._elapsed()}s)"
                          + (" [open sequence]" if self._opening else ""))
            elif typ == "WorkflowErrorEvent":
                self._error_events += 1
                for err in msg.get("fatalErrors") or []:
                    self._errors.append(err)
                    self._log(f"error event: {str(err.get('message'))[:300]}")
            elif typ == "RequestRefusedEvent":
                self._refusals.append({k: msg.get(k) for k in ("request", "executionId", "message")})
                self._log(f"refused {msg.get('request')}: {str(msg.get('message'))[:300]}")
            elif typ == "ModifyLogicResponse":
                self._modify_responses.append(msg)
                self._log(f"modify response: {msg}")
            elif typ == "ModifyLogicCompletedEvent":
                self._modify_completed.append(msg)
                self._log(f"modify completed: {msg.get('opIds')}")
            elif typ == "OperatorStatisticsUpdateEvent":
                self._stats_events += 1
                for op, metrics in (msg.get("operatorStatistics") or {}).items():
                    self._stats[op] = metrics
            elif typ == "ConsoleUpdateEvent":
                op = msg.get("operatorId")
                for m in msg.get("messages") or []:
                    # _t: arrival, seconds since start_run (orders a message against states)
                    self._console.append(dict(m, operatorId=op, _t=self._elapsed()))
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

    # ------------------------------------------------------------ open sequence

    def _close_open_sequence(self, how: str) -> None:
        """(Lock held.) Everything received so far is the unit's answer to the
        connection: keep it in `_replay` and start the views empty."""
        if not self._opening:
            return
        self._opening = False
        self._replay = {
            "closed_by": how, "t": self._elapsed(), "state_log": self._state_log,
            "execution_id": self._named_eid,
            "errors": self._errors, "error_events": self._error_events, "console": self._console,
            "stats": self._stats, "stats_events": self._stats_events,
            "result_updates": self._result_updates, "modify_responses": self._modify_responses,
            "modify_completed": self._modify_completed, "event_counts": dict(self._type_counts),
        }
        self._state_log, self._errors, self._console = [], [], []
        self._error_events, self._stats, self._stats_events = 0, {}, 0
        self._result_updates, self._modify_responses, self._modify_completed = {}, [], []
        self._cv.notify_all()

    def wait_open(self, timeout: float = 30.0, cluster_wait: float = OPEN_CLUSTER_WAIT_S,
                  quiet: float = OPEN_QUIET_S) -> None:
        """Block until the unit's open sequence is over: ClusterStatusUpdateEvent after
        the handshake state or, on a deployment that does not send it, `cluster_wait`
        seconds after the handshake and then `quiet` seconds without a message."""
        deadline = _now() + timeout
        with self._cv:
            while self._opening:
                if self._reader_error:
                    raise RunFailed(f"connection lost while the websocket session opened: "
                                    f"{self._reader_error}")
                now = _now()
                if (self._handshake_at is not None and now - self._handshake_at >= cluster_wait
                        and now - self._last_message_at >= quiet):
                    self._close_open_sequence(f"no {OPEN_SEQUENCE_END} within {cluster_wait:g} s of the "
                                              f"handshake; {quiet:g} s without a message")
                    break
                if now >= deadline:
                    raise RunTimeout(f"timed out after {timeout}s waiting for the websocket session to "
                                     f"open; states so far: {[s for _, s in self._state_log]}")
                self._cv.wait(0.05)

    @property
    def replayed(self) -> dict:
        with self._cv:
            r = self._replay
            if not r:
                return {"closed_by": None, "states": [s for _, s in self._state_log],
                        "execution_id": self._named_eid}
            states: list[str] = []
            for _, s in r["state_log"]:
                if not states or states[-1] != s:
                    states.append(s)
            return {
                "closed_by": r["closed_by"], "t": r["t"], "states": states,
                # the execution of the run the unit held for the workflow, None when it held none
                "execution_id": r["execution_id"],
                "error_events": r["error_events"],
                "fatal_errors": [str(e.get("message"))[:300] for e in r["errors"][:5]],
                "console_messages": len(r["console"]),
                "console_sample": [f"{(m.get('title') or '')[:120]}" for m in r["console"][:3]],
                "stats_operators": sorted(r["stats"]), "modify_completed": len(r["modify_completed"]),
                "event_counts": r["event_counts"],
            }

    # ------------------------------------------------------------------- sends

    def send_command(self, msg: dict, label: str, mark: bool = True) -> None:
        """Send a request. `mark` records it as a command, which moves the cursor
        wait_for_state(since_last_command=True) starts from."""
        with self._cv:
            if self._opening:  # a command ends the open sequence, whatever the unit sent
                self._close_open_sequence(f"{label} sent before {OPEN_SEQUENCE_END}")
            if mark:
                self._command_marks.append((self._elapsed(), label, len(self._state_log)))
                self._refusals_before_command = len(self._refusals)
        if mark:
            self._log(f"send {label} (+{self._elapsed()}s)")
        self._send(msg)

    # ------------------------------------------------------------------- waits

    def _failure_reason(self) -> str | None:
        """Why the run cannot make progress any more (lock held), or None.

        A fatal error event ends a run. A refusal of the last command sent means
        that what the caller waits for will not come. An ERROR console message
        ends a run too in practice: on an exception Texera pauses the Python
        worker for debugging and the workflow state stays Running, so without
        this a broken UDF would only surface as a timeout."""
        if self._errors:
            e = self._errors[0]
            return f"fatal error ({e.get('type')}) on {e.get('operatorId')}: {str(e.get('message'))[:500]}"
        last = self._command_marks[-1][1] if self._command_marks else None
        for r in self._refusals[self._refusals_before_command:]:
            if r["request"] == last:
                return f"the unit refused the {last}: {str(r['message'])[:500]}"
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
        """Kill the run this socket started unless it ended. A socket on which nothing
        started (a watcher, a refused start) is left alone: a kill there would reach
        whatever run the workflow holds."""
        if self.last_state in TERMINAL_STATES or self._reader_error or self._closed:
            return self.last_state
        with self._cv:
            sent_commands = bool(self._command_marks)
        if sent_commands and not self.states:
            # A start went out and nothing came back yet: give the unit a moment to
            # answer with a state (then it runs) or with its refusal.
            try:
                self.wait_until(lambda: bool(self._state_log) or self._error_events > 0 or bool(self._refusals),
                                5, "an answer to the start", fail_fast=False)
            except (RunTimeout, RunFailed):
                pass
        if self.last_state in TERMINAL_STATES or all(s == "Uninitialized" for s in self.states):
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

    def _control(self, request: str) -> None:
        """Pause, resume or kill the run. The request names the run's execution, which the
        unit checks against the run it holds; a handle that knows none (`ws` on a unit
        that names none) sends the old frame, which such a unit takes."""
        named = {} if self.eid is None else {"executionId": self.eid}
        self.send_command({"type": request, **named}, request)

    def pause(self) -> None:
        self._control("WorkflowPauseRequest")

    def resume(self) -> None:
        self._control("WorkflowResumeRequest")

    def kill(self) -> None:
        self._control("WorkflowKillRequest")

    def send_raw(self, msg: dict, label: str | None = None) -> None:
        with self._cv:
            if self._opening:
                self._close_open_sequence(f"{label or msg.get('type')} sent before {OPEN_SEQUENCE_END}")
            self._sent_other.append((self._elapsed(), label or str(msg.get("type"))))
        self._log(f"send {label or msg.get('type')} (+{self._elapsed()}s)")
        self._send(msg)

    def modify_operator(self, operator_json: dict, timeout: float = 60) -> dict:
        with self._cv:
            seen = len(self._modify_responses)
        out: dict[str, Any] = {}
        if self.update_poster is None:
            # ws: the old message carries the operator itself
            self.send_raw({"type": "ModifyLogicRequest", "operator": operator_json}, "ModifyLogicRequest")
        else:
            if self.eid is None:
                raise RuntimeError("create-ws: the run has no execution id")
            resp = self.update_poster(self.eid, operator_json)
            if resp.status_code != 201:
                raise UpdateRefused(resp.status_code, response_body(resp))
            out = dict(resp.json())
            self.send_raw({"type": "OperatorUpdateRequest", "executionId": self.eid,
                           "updateId": out["updateId"]}, "OperatorUpdateRequest")
        self.wait_until(lambda: len(self._modify_responses) > seen, timeout, "ModifyLogicResponse",
                        fail_fast=False)
        with self._cv:
            out["response"] = dict(self._modify_responses[seen])
        return out

    @property
    def modify_responses(self) -> list[dict]:
        with self._cv:
            return list(self._modify_responses)

    @property
    def modify_completed(self) -> list[dict]:
        with self._cv:
            return list(self._modify_completed)

    @property
    def error_event_count(self) -> int:
        with self._cv:
            return self._error_events

    @property
    def refusals(self) -> list[dict]:
        with self._cv:
            return list(self._refusals)

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
        opened = self.replayed
        with self._cv:
            return {
                "opened": opened,
                "states": self.states,
                "state_log": [{"t": t, "state": s} for t, s in self._state_log],
                "commands": [{"t": t, "command": c} for t, c, _ in self._command_marks],
                "fatal_errors": [{k: e.get(k) for k in ("type", "message", "operatorId", "workerId")}
                                 for e in self._errors],
                "refusals": list(self._refusals),
                "operator_stats": {op: {k: m.get(k) for k in ("operatorState", "aggregatedInputRowCount",
                                                              "aggregatedOutputRowCount", "numWorkers")}
                                   for op, m in self._stats.items()},
                "stats_events": self._stats_events,
                "console_messages": len(self._console),
                "console_sample": self._console[:3],
                "event_counts": dict(self._type_counts),
                "other_events": self._other[:10],
                "connection_error": self._reader_error,
                "eid": self.eid,
                "plan_uri": self.plan_uri,
                "other_sent": [{"t": t, "message": m} for t, m in self._sent_other],
                "modify_responses": self._modify_responses[:10],
                "modify_completed": self._modify_completed[:10],
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
        # `api` (the driver's TexeraApi) is unused here; `create-ws` creates over it.
        parts = urllib.parse.urlsplit(base)
        scheme = "wss" if parts.scheme == "https" else "ws"
        self.ws_base = urllib.parse.urlunsplit((scheme, parts.netloc, parts.path.rstrip("/"), "", ""))
        self._token = token_provider
        self._uid = uid_provider
        self.engine_version = engine_version
        self._log = log
        self.heartbeat_s = heartbeat_s
        self.api = api

    def describe(self) -> dict:
        return {"name": self.name, "endpoint": f"{self.ws_base}/wsapi/workflow-websocket"}

    #: how long the open sequence may take, and its fallback without ClusterStatusUpdateEvent
    open_timeout_s = 30.0
    open_cluster_wait_s = OPEN_CLUSTER_WAIT_S
    open_quiet_s = OPEN_QUIET_S

    def open_socket(self, wid: int, cuid: int, *, token: str | None = None,
                    uid: int | None = None) -> WebSocketRunHandle:
        """A session on the workflow, subscribed, its open sequence over: the handshake
        state, the replay of the workflow's held execution and ClusterStatusUpdateEvent
        have arrived, so nothing of an earlier run can arrive after the first command."""
        token = token or self._token()
        if uid is None:
            uid = int(jwt_claims(token)["userId"]) if token != self._token() else self._uid()
        query = urllib.parse.urlencode({"wid": wid, "uid": uid, "cuid": cuid, "access-token": token})
        handle = WebSocketRunHandle(f"{self.ws_base}/wsapi/workflow-websocket?{query}", wid, cuid,
                                    heartbeat_s=self.heartbeat_s, log=self._log)
        try:
            handle.wait_open(self.open_timeout_s, self.open_cluster_wait_s, self.open_quiet_s)
        except Exception:
            handle.close()
            raise
        return handle

    def start_run(self, *, wid: int, cuid: int, warehouse_id: int | None, logical_plan: dict,
                  execution_name: str, settings: dict | None = None,
                  replay_from: dict | None = None) -> RunHandle:
        request: dict[str, Any] = {
            "type": "WorkflowExecuteRequest",
            "executionName": execution_name,
            "engineVersion": self.engine_version,
            "logicalPlan": logical_plan,
            "replayFromExecution": replay_from,
            "workflowSettings": settings or dict(DEFAULT_SETTINGS),
            "emailNotificationEnabled": False,
            "computingUnitId": cuid,
        }
        if warehouse_id is not None:
            request["warehouseId"] = warehouse_id
        handle = self.open_socket(wid, cuid)
        try:
            # On this path the unit creates the execution when it starts it.
            self._phase("create", {"wid": wid, "cuid": cuid})
            self._phase("start", {"wid": wid, "cuid": cuid, "handle": handle})
            handle.execute(request)
        except Exception:
            handle.close()
            raise
        return handle


class CreateStartTransport(WebSocketTransport):
    """Step 2 from PR B on: create at the Dashboard, then start by id on the unit.

      1. POST {base}/api/executions (design 3.4) -> 201 {eid, planUri};
         any other answer raises CreateRefused(status, body)
      2. open /wsapi/workflow-websocket?wid&uid&cuid&access-token; wait for the handshake
      3. send {"type": "WorkflowStartRequest", "executionId": eid, "planUri": planUri}
         as the first marked command
      4. pause, resume and kill name the execution; pagination and heartbeat as on `ws`

    The request names no operator to run up to: a client that wants a part of a workflow
    run sends that part as the plan (Workflow.plan_up_to), as the browser and the agent
    service do.
    """

    name = "create-ws"

    def __init__(self, base: str, token_provider: Callable[[], str], uid_provider: Callable[[], int],
                 *, api: Any = None, **kw):
        if api is None:
            raise ValueError("create-ws needs the driver's TexeraApi to create executions")
        super().__init__(base, token_provider, uid_provider, api=api, **kw)

    def describe(self) -> dict:
        return {"name": self.name, "create": f"{self.api.base}/api/executions",
                "endpoint": f"{self.ws_base}/wsapi/workflow-websocket"}

    def create_body(self, *, wid: int, cuid: int, warehouse_id: int | None, logical_plan: dict,
                    execution_name: str = "", settings: dict | None = None,
                    replay_from: dict | None = None,
                    engine_version: str | None = None) -> dict:
        body: dict[str, Any] = {
            "wid": wid,
            "executionName": execution_name,
            "engineVersion": engine_version or self.engine_version,
            "logicalPlan": logical_plan,
            "workflowSettings": settings or dict(DEFAULT_SETTINGS),
            "emailNotificationEnabled": False,
            "computingUnitId": cuid,
        }
        if warehouse_id is not None:
            body["warehouseId"] = warehouse_id
        if replay_from is not None:
            body["replayFromExecution"] = replay_from
        return body

    def create_only(self, *, api: Any = None, body: dict | None = None, **kw) -> Any:
        """POST /api/executions (as `api`'s user, by default the driver's); the raw
        response, whatever its status. `body` replaces the built body entirely."""
        api = api or self.api
        body = body if body is not None else self.create_body(**kw)
        self._phase("create", {"wid": body.get("wid"), "cuid": body.get("computingUnitId")})
        resp = api.create_execution(body)
        if resp.status_code == 201:
            created = resp.json()
            self._phase("created", {"eid": created.get("eid"), "plan_uri": created.get("planUri"),
                                    "wid": body.get("wid")})
        return resp

    def start_run(self, *, wid: int, cuid: int, warehouse_id: int | None, logical_plan: dict,
                  execution_name: str, settings: dict | None = None,
                  replay_from: dict | None = None) -> RunHandle:
        resp = self.create_only(wid=wid, cuid=cuid, warehouse_id=warehouse_id,
                                logical_plan=logical_plan, execution_name=execution_name,
                                settings=settings, replay_from=replay_from)
        if resp.status_code != 201:
            raise CreateRefused(resp.status_code, response_body(resp))
        created = resp.json()
        self._log(f"created execution {created.get('eid')} at {created.get('planUri')}")
        return self.start_existing(wid=wid, cuid=cuid, eid=int(created["eid"]),
                                   plan_uri=str(created["planUri"]))

    def start_existing(self, *, wid: int, cuid: int, eid: int, plan_uri: str,
                       token: str | None = None, uid: int | None = None) -> RunHandle:
        handle = self.open_socket(wid, cuid, token=token, uid=uid)
        handle.eid, handle.plan_uri = eid, plan_uri
        poster_api = self.api if token in (None, self._token()) else self.api.with_token(token)
        handle.update_poster = poster_api.post_operator_update
        try:
            self._phase("start", {"wid": wid, "cuid": cuid, "eid": eid, "plan_uri": plan_uri,
                                  "handle": handle})
            handle.send_command({"type": "WorkflowStartRequest", "executionId": eid,
                                 "planUri": plan_uri}, "WorkflowStartRequest")
        except Exception:
            handle.close()
            raise
        return handle


TRANSPORTS: dict[str, type[Transport]] = {"ws": WebSocketTransport, "create-ws": CreateStartTransport}


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
