"""The fake unit's ExecutionRecorder: what step 3 puts into the lake for a run, as the
design says the unit writes it (sections 3.1 to 3.3, 4.1 and 4.2).

One thread per run does all the lake's writing, as in the design (D8), so a state
change returns at once and its row lands a moment later: a reader that looks the
instant a state reaches its socket may still see the state before. In order:

  * a state change is one commit: the row and the label together (D3); then the
    statistics sample and the console buffer are stored;
  * the log holds state changes only: a stored port's location is in the plan
    (docs/step3-notes/changes-since-rev2.md, section 2), not in an `output` row;
  * a tick, every commit interval: the beat first (a property, no snapshot), then
    one statistics row per operator whose numbers changed since its last stored row
    (D10), then the buffered console rows, then a tidy of a table that reached 50
    appends;
  * an ending is followed by the end tidy of the three tables (one data file and one
    snapshot each), unless the unit is stopping, which leaves them as they are;
  * a unit that dies stops the thread where it is: what was buffered is lost (D43).

`faults` makes the recorder misbehave in the ways the harness's checks exist to catch
(FAULTS below); the tests turn them on one at a time.
"""

from __future__ import annotations

import json
import queue
import threading
import time
from typing import Callable

from fake_lake import FakeLake, FakeTable, now_ms

#: design 3.1: namespace and table suffix of an execution's tables
NAMESPACES = {"plan": "execution-plan", "log": "execution-log", "statistics": "workflow-runtime-statistics",
              "console": "operator-console-messages", "result": "operator-port-result",
              "state": "operator-port-state"}
SUFFIXES = {"plan": "plan", "log": "executionlog", "statistics": "runtimestatistics",
            "console": "consolemessages"}
RECORD_TABLES = ("log", "statistics", "console")
END_STATES = ("COMPLETED", "FAILED", "KILLED")
#: workflow_executions.status of a logged state
STATE_CODES = {"READY": 0, "RUNNING": 1, "PAUSED": 2, "COMPLETED": 3, "FAILED": 4, "KILLED": 5}
#: design 3.2: the label
LABEL = "texera.execution."
#: design D13 and 4.1
TIDY_EVERY_APPENDS = 50
CONSOLE_FLUSH_ROWS = 4096
REASON_CHARS = 500

FAULTS = {
    "row-lost": "the ending's row never lands, though its label does (a label ahead of its rows)",
    "seq-gap": "the recorder skips a seq (the second row is numbered 3)",
    "output-rows": "the log also holds an `output` row per stored port, as in the design's revision 2",
    "no-end-tidy": "the end tidy merges nothing (several data files and snapshots stay)",
    "statistics-at-end-only": "statistics are stored when the run ends, not on the timer",
    "console-at-end-only": "console output is stored when the run ends, not on the timer",
}


def table_name(wid: int, eid: int, kind: str) -> str:
    return f"wid_{wid}_eid_{eid}_{SUFFIXES[kind]}"


class Recorder:
    def __init__(self, lake: FakeLake, warehouse: str, wid: int, eid: int, *, interval_s: float,
                 faults: set[str], commit_delay_s: float = 0.02):
        self.lake, self.warehouse, self.wid, self.eid = lake, warehouse, wid, eid
        self.interval_s = interval_s
        self.faults = faults
        #: how long one commit to the lake takes
        self.commit_delay_s = commit_delay_s
        self.ended = False
        self._seq = 0
        self._last_state: str | None = None
        self._metrics: dict[str, dict] = {}
        self._stored: dict[str, tuple] = {}
        self._console: list[dict] = []
        self._console_seq = 0
        self._lock = threading.Lock()
        self._tasks: queue.Queue[Callable[[], None]] = queue.Queue()
        self._pending = 0
        self._stop = threading.Event()
        self._submit(self._create_tables)
        self._thread = threading.Thread(target=self._loop, name=f"execution-record-{eid}", daemon=True)
        self._thread.start()

    # ----------------------------------------------------- what the unit tells it

    def state(self, state: str, reason: str | None = None, errors: tuple | list = (),
              final_tidy: bool = True) -> None:
        """The run changed state. Dropped when the state did not change or the run has ended."""
        with self._lock:
            if self.ended or state == self._last_state:
                return
            self._last_state = state
            self.ended = state in END_STATES
            seq = self._next_seq()
        detail = {k: v for k, v in (("reason", reason), ("errors", list(errors))) if v}
        at = now_ms()
        row = {"seq": seq, "timeMs": at, "kind": "state", "state": state,
               "detail": json.dumps(detail) if detail else None}
        why = reason or (errors[0].get("message") if errors else "") or ""
        label = {LABEL + "state": state, LABEL + "state-seq": str(seq), LABEL + "state-time-ms": str(at),
                 LABEL + "reason": why[:REASON_CHARS], LABEL + "beat-ms": str(at)}
        self._submit(lambda: self._write_state(row, label, final_tidy))

    def output(self, port_id: str, uri: str, mode: str) -> None:
        """The fault `output-rows`: a row for a stored output port, which the log no longer holds."""
        with self._lock:
            seq = self._next_seq()
        told = {"portId": port_id, "uri": uri, "outputMode": mode}
        row = {"seq": seq, "timeMs": now_ms(), "kind": "output", "state": None, "detail": json.dumps(told)}
        self._submit(lambda: self._append("log", [row], {LABEL + "beat-ms": str(now_ms())}))

    def statistics(self, metrics: dict[str, dict]) -> None:
        """The newest numbers of operators; kept, and stored at the next commit."""
        with self._lock:
            self._metrics.update(metrics)

    def console(self, operator_id: str, msg_type: str, title: str, message: str, source: str = "") -> None:
        """One console message; buffered, and stored at the next commit."""
        with self._lock:
            self._console_seq += 1
            self._console.append({"seq": self._console_seq, "timeMs": now_ms(), "operatorId": operator_id,
                                  "workerId": "", "msgType": msg_type, "source": source, "title": title,
                                  "message": message})
            full = len(self._console) >= CONSOLE_FLUSH_ROWS
        if full and "console-at-end-only" not in self.faults:
            self._submit(self._store_console)

    def await_idle(self, timeout: float) -> bool:
        """Whether everything handed over so far is in the lake within `timeout`."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if self._pending == 0:
                    return True
            time.sleep(0.01)
        return False

    def kill(self) -> None:
        """The unit died: nothing more reaches the lake."""
        self._stop.set()

    # ------------------------------------------------------------- the thread

    def _next_seq(self) -> int:
        self._seq += 1
        if self._seq == 2 and "seq-gap" in self.faults:
            self._seq = 3
        return self._seq

    def _submit(self, task: Callable[[], None]) -> None:
        with self._lock:
            self._pending += 1
        self._tasks.put(task)

    def _loop(self) -> None:
        next_tick = time.monotonic() + self.interval_s
        while not self._stop.is_set():
            try:
                task = self._tasks.get(timeout=0.02)
            except queue.Empty:
                if time.monotonic() >= next_tick:
                    self._tick()
                    next_tick = time.monotonic() + self.interval_s  # a fixed delay, not a fixed rate
                continue
            task()
            with self._lock:
                self._pending -= 1

    def _table(self, kind: str) -> FakeTable | None:
        return self.lake.table(self.warehouse, NAMESPACES[kind], table_name(self.wid, self.eid, kind))

    def _create_tables(self) -> None:
        """The three tables, made together when the run starts; each replaces one of that
        name left by an earlier database, so nothing stale is read for this execution."""
        at = now_ms()
        for kind in RECORD_TABLES:
            self.lake.create(self.warehouse, NAMESPACES[kind], table_name(self.wid, self.eid, kind))
        self._table("log").set_properties({LABEL + "beat-ms": str(at),
                                           LABEL + "beat-every-ms": str(int(self.interval_s * 1000))})

    def _append(self, kind: str, rows: list[dict], properties: dict[str, str] | None = None) -> None:
        """One commit. A table that existed and is gone is not made again: the execution
        was deleted, and the recorder stops (4.1, step 5)."""
        time.sleep(self.commit_delay_s)
        with self.lake.lock:
            table = self._table(kind)
            if table is None:
                self._stop.set()
                return
            table.append(rows, properties)

    def _write_state(self, row: dict, label: dict[str, str], final_tidy: bool) -> None:
        ending = row["state"] in END_STATES
        if ending and "row-lost" in self.faults:
            self._table("log").set_properties(label)
        else:
            self._append("log", [row], label)
        if ending or "statistics-at-end-only" not in self.faults:
            self._store_statistics()
        if ending or "console-at-end-only" not in self.faults:
            self._store_console()
        if ending:
            if final_tidy:
                self._tidy(at_end=True)
            self._stop.set()

    def _tick(self) -> None:
        with self.lake.lock:  # the beat first: nothing later in the tick can hold it back
            log = self._table("log")
            if log is None:
                self._stop.set()
                return
            log.set_properties({LABEL + "beat-ms": str(now_ms())})
        if "statistics-at-end-only" not in self.faults:
            self._store_statistics()
        if "console-at-end-only" not in self.faults:
            self._store_console()
        with self.lake.lock:
            for kind in RECORD_TABLES:
                table = self._table(kind)
                if table is not None and table.appends_since_tidy >= TIDY_EVERY_APPENDS:
                    table.tidy(at_end=False)

    def _store_statistics(self) -> None:
        """One row per operator whose row would differ from its last stored one in any
        column but the time; all rows of one commit carry the same time."""
        with self._lock:
            metrics = dict(self._metrics)
        at, rows = now_ms(), []
        for op, m in metrics.items():
            numbers = (m.get("input", 0), m.get("output", 0), m.get("workers", 1), m.get("state", "RUNNING"))
            if self._stored.get(op) == numbers:
                continue
            self._stored[op] = numbers
            rows.append({"operatorId": op, "timeMs": at, "inputTupleCnt": numbers[0], "inputTupleSize": 0,
                         "outputTupleCnt": numbers[1], "outputTupleSize": 0, "dataProcessingTime": 0,
                         "controlProcessingTime": 0, "idleTime": 0, "numWorkers": numbers[2],
                         "status": STATE_CODES.get(numbers[3], -1)})
        if rows:
            self._append("statistics", rows)

    def _store_console(self) -> None:
        with self._lock:
            rows, self._console = self._console, []
        if rows:
            self._append("console", rows)

    def _tidy(self, at_end: bool) -> None:
        with self.lake.lock:
            for kind in RECORD_TABLES:
                table = self._table(kind)
                if table is not None:
                    table.tidy(at_end, merge="no-end-tidy" not in self.faults)
