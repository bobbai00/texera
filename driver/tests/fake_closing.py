"""The fake Dashboard service's part of step 3, from gate 3B on (design sections 3.4,
3.5, 4.3, 4.4 and 4.6): an execution's closing record, the timer job that writes it,
the expiry of results, and what the state, log, history, quota and admin routes answer
from the record and from the lake.

It follows the design's steps, with their limits:

  * a tick looks at every open execution: an ending in the log's label closes it; a
    terminated unit loses it at once; one that was never started is closed once it is
    older than never-started-after, and the job takes its start first; otherwise the job
    counts its own ticks during which the beat did not move, and loses the execution
    when the count reaches max(lost-after, 4 beats) / interval, rounded up (D26);
  * so a lost unit's execution reads Running until then (4.6), and one whose run just
    ended reads its ending from the label while its row is still open;
  * an execution that is lost ended at its unit's last beat, not when the job noticed;
  * create closes the earlier executions of its workflow on its unit whose label shows
    an ending, then expires the closed ones; a pass by age expires the rest (D31);
  * an expiry drops the result and state tables the log names (found by name when
    there is no log) and the console table, keeps the plan, the log and the statistics,
    and counts what is left into `stored_bytes`.

`faults` (FAULTS below, the fake's set) makes it misbehave in the ways the scenarios and
Check K exist to catch; the tests turn them on one at a time.
"""

from __future__ import annotations

import json
import math
import threading
import time

from fake_lake import now_ms
from fake_record import END_STATES, LABEL, NAMESPACES, STATE_CODES, table_name

REASON_UNIT_LOST = "unit lost"
REASON_UNIT_TERMINATED = "unit terminated"
REASON_NEVER_STARTED = "never started"
REASON_COMPILE_ERROR = "compile error: "
REASON_CHARS = 500
STATUS_NAMES = {0: "READY", 1: "RUNNING", 2: "PAUSED", 3: "COMPLETED", 4: "FAILED", 5: "KILLED"}
#: an expiry keeps these tables of an execution and drops the rest (D31)
KEPT = ("plan", "log", "statistics")

FAULTS = {
    "lost-never-closed": "the job never calls a unit lost: its execution stays Running for ever (as before step 3)",
    "verdict-too-early": "the job calls a unit lost at the first tick that finds the beat unchanged",
    "ended-at-now": "a lost execution is closed as of now, not as of its unit's last beat",
    "never-started-never-closed": "an execution nobody starts stays open for ever",
    "never-started-too-early": "an execution nobody starts is closed at the next tick, whatever its age",
    "start-after-never-started": "the job closes an unstarted execution without taking its start",
    "row-left-open": "nothing closes an execution whose log shows an ending: its row stays open",
    "no-reason": "a closing record says how an execution ended, never why",
    "completion-null-while-open": "the history has no completionTime for an open execution",
    "expiry-keeps-results": "an expiry marks the execution expired and drops nothing",
    "expiry-drops-record": "an expiry drops the plan, the log and the statistics too",
    "stored-bytes-unchanged": "an expiry leaves stored_bytes as it was",
    "no-expiry-by-age": "results never expire by age, only at the next create",
    "expiry-too-early": "the pass by age expires every closed execution, whatever its age",
}


class Closing:
    def __init__(self, fake):
        self.fake = fake
        #: per open execution: the beat the job last saw, and for how many of its
        #: consecutive ticks it has not changed
        self._watch: dict[int, tuple[object, int]] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def faults(self) -> set[str]:
        return self.fake.faults

    # ------------------------------------------------------------- the record

    @staticmethod
    def new_row() -> dict:
        """The closing record of a row that was just inserted (design 3.4)."""
        return {"starting_ms": now_ms(), "outcome": None, "outcome_reason": None, "ended_at": None,
                "stored_bytes": None, "results_expired_at": None}

    def label(self, eid: int) -> dict | None:
        """The label of the execution's log; None when it has no log table."""
        table = self.fake.execution_table(eid, "log")
        if table is None:
            return None
        with self.fake.lake.lock:
            p = dict(table.properties)

        def number(key: str) -> int:
            return int(p[LABEL + key]) if str(p.get(LABEL + key, "")).isdigit() else 0
        return {"state": p.get(LABEL + "state"), "state_seq": number("state-seq"),
                "state_time_ms": number("state-time-ms"), "reason": p.get(LABEL + "reason") or None,
                "beat_ms": number("beat-ms"), "beat_every_ms": number("beat-every-ms")}

    def rows(self, eid: int) -> list[dict]:
        """The log's rows by seq, one per seq (the first); [] when there is no log."""
        table = self.fake.execution_table(eid, "log")
        if table is None:
            return []
        with self.fake.lake.lock:
            rows = list(table.rows)
        first: dict[int, dict] = {}
        for row in rows:
            first.setdefault(row["seq"], row)
        return [first[seq] for seq in sorted(first)]

    def stored_port_tables(self, eid: int) -> list[tuple[str, str]]:
        """(namespace, table) of every result and state table of the execution. They are
        the ones its log's `output` rows name; an execution without a log has them found
        by name (design 4.4), and so has one whose ports are named in its plan instead.
        The only reader of the `output` rows on the fake Dashboard."""
        e = self.fake.executions[eid]
        warehouse = self.fake.warehouse_of(e)
        if self.fake.execution_table(eid, "log") is None or not self.fake.log_names_stored_ports:
            prefix = f"wid_{e['wid']}_eid_{eid}_"
            return [(NAMESPACES[kind], name) for kind in ("result", "state")
                    for name in self.fake.lake.names(warehouse, NAMESPACES[kind]) if name.startswith(prefix)]
        found = []
        for row in self.rows(eid):
            if row["kind"] == "output":
                base = json.loads(row["detail"])["uri"].split("/wid/", 1)[1].rsplit("/", 1)[0]
                found += [(NAMESPACES[kind], f"wid/{base}/{kind}".replace("/", "_")) for kind in ("result", "state")]
        return found

    def _size(self, eid: int, kinds=("plan", "log", "statistics", "console"), ports: bool = True) -> int:
        """The bytes of the execution's tables, as the catalog's summaries count them; a
        table that is missing counts 0."""
        e = self.fake.executions[eid]
        warehouse = self.fake.warehouse_of(e)
        tables = [self.fake.execution_table(eid, kind) for kind in kinds]
        if ports:
            tables += [self.fake.lake.table(warehouse, ns, name) for ns, name in self.stored_port_tables(eid)]
        with self.fake.lake.lock:
            return sum(t.size_bytes for t in tables if t is not None)

    def close(self, eid: int, outcome: int, reason: str | None, ended_at_ms: int,
              never_started: bool = False) -> bool:
        """The conditional UPDATE: true when it closed the row. `ended_at` is kept between
        the row's creation and now."""
        e = self.fake.executions[eid]
        if e["ended_at"] is not None:
            return False
        e["outcome"] = outcome
        e["outcome_reason"] = None if "no-reason" in self.faults else (reason or None)
        e["ended_at"] = min(max(ended_at_ms, e["starting_ms"]), now_ms())
        e["stored_bytes"] = self._size(eid)
        if never_started:  # no unit ever started it: it has nothing to expire
            e["results_expired_at"] = now_ms()
        self._watch.pop(eid, None)
        why = "NULL" if e["outcome_reason"] is None else "'" + e["outcome_reason"].replace("'", "''") + "'"
        self.fake.sql("dashboard", "update workflow_executions set outcome = $1, outcome_reason = $2, "
                                   "ended_at = $3 where (workflow_executions.eid = $4 and "
                                   "workflow_executions.ended_at is null)",
                      f"$1 = '{outcome}', $2 = {why}, $3 = '2026-11-16 10:00:00', $4 = '{eid}'")
        return True

    def close_if_ended(self, eid: int) -> bool:
        label = self.label(eid)
        if label is None or label["state"] not in END_STATES or "row-left-open" in self.faults:
            return False
        return self.close(eid, STATE_CODES[label["state"]], label["reason"], label["state_time_ms"])

    # ---------------------------------------------------------------- the job

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="execution-closing", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        """A tick every interval, at a fixed rate: a tick that took long does not push the
        next one back (the verdicts' deadlines are counted in ticks)."""
        timing = self.fake.timing
        next_tick = time.monotonic() + timing.closing_interval_s
        next_expiry = time.monotonic()
        while not self._stop.wait(max(0.0, next_tick - time.monotonic())):
            next_tick += timing.closing_interval_s
            with self.fake.lock:
                self.tick()
                if time.monotonic() >= next_expiry:
                    self.expire_by_age()
                    next_expiry = time.monotonic() + timing.expiry_check_interval_s

    def tick(self) -> None:
        """One tick: look at every open execution. A lake that cannot be read decides
        nothing."""
        if self.fake.lake.unreadable:
            return
        for eid, e in sorted(self.fake.executions.items()):
            if e.get("plan_uri") and e["ended_at"] is None:
                self._look_at(eid, e)

    def _look_at(self, eid: int, e: dict) -> None:
        timing = self.fake.timing
        label = self.label(eid)
        if self.close_if_ended(eid):
            return
        unit = self.fake.units.get(e["cuid"]) or {}
        if unit.get("terminateTime"):
            self._lose(eid, REASON_UNIT_TERMINATED if unit.get("terminationReason") == "USER_REQUESTED"
                       else REASON_UNIT_LOST, label)
            return
        if label is None and not e["started"]:
            self._never_started(eid, e)
            return
        beat = label["beat_ms"] if label else None
        seen, count = self._watch.get(eid, (object(), 0))
        count = count + 1 if seen == beat else 0
        self._watch[eid] = (beat, count)
        stand_still_s = max(timing.lost_after_s, 4 * (label["beat_every_ms"] if label else 0) / 1000)
        threshold = 1 if "verdict-too-early" in self.faults else math.ceil(stand_still_s / timing.closing_interval_s)
        if count >= threshold and "lost-never-closed" not in self.faults:
            self._lose(eid, REASON_UNIT_LOST, label)

    def _never_started(self, eid: int, e: dict) -> None:
        age_s = (now_ms() - e["starting_ms"]) / 1000
        old_enough = age_s >= self.fake.timing.never_started_after_s or "never-started-too-early" in self.faults
        if not old_enough or "never-started-never-closed" in self.faults:
            return
        if "start-after-never-started" not in self.faults:
            self.fake.claim_start(eid)
        self.close(eid, STATE_CODES["FAILED"], REASON_NEVER_STARTED, now_ms(), never_started=True)

    def _lose(self, eid: int, reason: str, label: dict | None) -> None:
        """Before an execution is declared lost its rows are read: an ending there wins.
        Otherwise its start is taken, so nothing starts it later, and it ended when its
        unit last showed that it was alive."""
        ending = next((r for r in reversed(self.rows(eid)) if r["kind"] == "state" and r["state"] in END_STATES),
                      None)
        if ending is not None:
            if "row-left-open" in self.faults:
                return
            detail = json.loads(ending["detail"] or "{}")
            why = detail.get("reason") or ((detail.get("errors") or [{}])[0].get("message"))
            self.close(eid, STATE_CODES[ending["state"]], why, ending["timeMs"])
            return
        if not self.fake.executions[eid]["started"]:
            self.fake.claim_start(eid)
        ended = now_ms() if label is None or "ended-at-now" in self.faults else label["beat_ms"]
        self.close(eid, STATE_CODES["FAILED"], reason, ended)

    # ----------------------------------------------------------------- expiry

    def expire(self, eid: int, with_replay_log: bool = False) -> None:
        e = self.fake.executions[eid]
        if e["results_expired_at"] is not None:
            return
        warehouse = self.fake.warehouse_of(e)
        if "expiry-keeps-results" not in self.faults:
            for namespace, name in self.stored_port_tables(eid):
                self.fake.lake.drop(warehouse, namespace, name)
            self.fake.lake.drop(warehouse, NAMESPACES["console"], table_name(e["wid"], eid, "console"))
        if "expiry-drops-record" in self.faults:
            for kind in KEPT:
                self.fake.lake.drop(warehouse, NAMESPACES[kind], table_name(e["wid"], eid, kind))
        e["results_expired_at"] = now_ms()
        if "stored-bytes-unchanged" not in self.faults:
            e["stored_bytes"] = self._size(eid, KEPT, ports=False)
        if with_replay_log:
            e["log"] = None

    def expire_replaced(self, wid: int, cuid: int, replaced_by: int) -> None:
        """What create does for the earlier executions of its workflow on its unit: close
        the ones whose run has just ended, then expire the closed ones."""
        earlier = [eid for eid, e in sorted(self.fake.executions.items())
                   if eid < replaced_by and (e["wid"], e["cuid"]) == (wid, cuid) and e.get("plan_uri")]
        for eid in earlier:
            if self.fake.executions[eid]["ended_at"] is None:
                self.close_if_ended(eid)
            if self.fake.executions[eid]["ended_at"] is not None:
                self.expire(eid)

    def expire_by_age(self) -> None:
        if "no-expiry-by-age" in self.faults:
            return
        ttl_ms = 0 if "expiry-too-early" in self.faults else self.fake.timing.result_ttl_s * 1000
        for eid, e in sorted(self.fake.executions.items()):
            if e.get("plan_uri") and e["ended_at"] is not None and e["ended_at"] < now_ms() - ttl_ms:
                self.expire(eid, with_replay_log=True)

    # ------------------------------------------------- what the routes answer

    def status(self, eid: int) -> int:
        """Design D21: the outcome of a closed execution; for an open one its label's
        state, 0 without a log, -1 when the lake cannot be read."""
        e = self.fake.executions[eid]
        if e["ended_at"] is not None:
            return e["outcome"]
        if self.fake.lake.unreadable:
            return -1
        label = self.label(eid)
        return STATE_CODES.get(label["state"], 0) if label and label["state"] else 0

    def completion_ms(self, eid: int) -> int | None:
        """D21: `ended_at` when closed; while open the time of the newest state change, never
        before the row's creation, and the creation when there is no label to read."""
        e = self.fake.executions[eid]
        if e["ended_at"] is not None:
            return e["ended_at"]
        if "completion-null-while-open" in self.faults:
            return None
        label = None if self.fake.lake.unreadable else self.label(eid)
        return max(label["state_time_ms"], e["starting_ms"]) if label else e["starting_ms"]

    def may_read(self, uid: int, eid: int) -> bool:
        e = self.fake.executions.get(eid)
        return e is not None and (e["uid"] == uid or self.fake.workflows.get(e["wid"], {}).get("owner") == uid)

    def entry_fields(self, eid: int, uid: int) -> dict:
        """What a history entry says of how the execution stands (design 3.5)."""
        e = self.fake.executions[eid]
        return {"status": self.status(eid), "startingTime": e["starting_ms"],
                "completionTime": self.completion_ms(eid),
                "reason": e["outcome_reason"] if self.may_read(uid, eid) else None}

    def state(self, uid: int, eid: int):
        if not self.may_read(uid, eid):
            return self.fake.err(403, f"no access to execution {eid}")
        e = self.fake.executions[eid]
        if e["ended_at"] is not None:
            return 200, {"eid": eid, "status": e["outcome"], "open": False, "reason": e["outcome_reason"],
                         "timeMs": e["ended_at"]}
        label = None if self.fake.lake.unreadable else self.label(eid)
        return 200, {"eid": eid, "status": self.status(eid), "open": True,
                     "reason": label["reason"] if label else None,
                     "timeMs": label["state_time_ms"] if label and label["state"] else None}

    def log(self, uid: int, eid: int):
        if not self.may_read(uid, eid):
            return self.fake.err(403, f"no access to execution {eid}")
        e = self.fake.executions[eid]
        entries = []
        for row in self.rows(eid):
            detail = json.loads(row["detail"] or "{}")
            entry = {"seq": row["seq"], "timeMs": row["timeMs"], "kind": row["kind"]}
            entries.append({**entry, "state": row["state"], **detail} if row["kind"] == "state"
                           else {**entry, **detail})
        closing = None if e["ended_at"] is None else {
            "outcome": e["outcome"], "reason": e["outcome_reason"], "endedAtMs": e["ended_at"]}
        return 200, {"eid": eid, "entries": entries, "closing": closing}

    def quota(self, uid: int):
        return 200, [{"eid": eid, "workflowId": e["wid"],
                      "workflowName": self.fake.workflows.get(e["wid"], {}).get("name"),
                      "storedBytes": e["stored_bytes"]}
                     for eid, e in sorted(self.fake.executions.items()) if e["uid"] == uid and e.get("plan_uri")]

    def admin_list(self, user: dict, page_size: int, page_index: int):
        """The newest execution of each workflow, by end time, newest first (open ones, which
        have none, before the closed ones, as NULLs sort in Postgres)."""
        if user["role"] != "ADMIN":
            return self.fake.err(403, "admin only")
        newest: dict[int, int] = {}
        for eid, e in self.fake.executions.items():
            newest[e["wid"]] = max(eid, newest.get(e["wid"], 0))
        eids = sorted(newest.values(), key=lambda eid: (self.fake.executions[eid].get("ended_at") is not None,
                                                         -(self.fake.executions[eid].get("ended_at") or 0)))
        page = eids[page_index * page_size:(page_index + 1) * page_size]
        return 200, [self._admin_entry(eid) for eid in page]

    def _admin_entry(self, eid: int) -> dict:
        e = self.fake.executions[eid]
        end = self.completion_ms(eid) or e["starting_ms"]
        return {"workflowName": self.fake.workflows.get(e["wid"], {}).get("name"), "workflowId": e["wid"],
                "userName": self.fake.users[e["uid"]]["name"], "userId": e["uid"], "executionId": eid,
                "executionStatus": STATUS_NAMES.get(self.status(eid), "UNKNOWN"),
                "executionTime": (end - e["starting_ms"]) / 1000.0, "executionName": e.get("name", ""),
                "startTime": e["starting_ms"], "endTime": end, "access": True,
                "reason": e["outcome_reason"]}
