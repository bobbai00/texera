#!/usr/bin/env python3
"""Browser smoke: the real workflow editor, in headless Chromium, against a running stack.

The API scenarios (e2e.py) speak the protocol themselves. This drives the page the
user sees: it opens a workflow in the editor, presses Run, Pause, Resume and Stop,
changes a paused operator in the property editor, and reads an operator's result in
the window the page opens beside the operator, and its messages and errors in the
console. What the page sent is recorded beside what it showed: every request to
/api/executions* and /api/environments* with its status, and every frame the page
sent on the workflow websocket.

Setup is the driver's (texera_api.py, workflow.py): log in, the CSV dataset, the
warehouse, the local computing unit, one workflow per case stored in UI format.
The page is signed in by putting the token where the frontend keeps it
(localStorage `access_token`, AuthService.TOKEN_KEY), and the unit is the one the
frontend remembers for the workflow (localStorage `computing-unit-of-workflow-<wid>`,
ComputingUnitSelectionComponent).

Cases
  B1  Run to completion: CSV scan -> Filter -> Aggregate; the rows of the last
      operator's result, opened beside it.
  B2  A compile error from the create (a Projection of a missing column): the console
      shows the operator's error, nothing is sent on the websocket, Run works again; then
      the operator is fixed in the property editor and the run completes.
  B3  Pause, resume, stop with the buttons on a slow Python UDF.
  B4  Change a paused operator: the UDF's code, in the code editor; resume; the rows.
  B5  Run again on the same page after a completed run: a second create and start, and
      the result window left open shows the second run's rows.
  B6  (extra) Stop pressed while the execution is still being created: the run is given
      up in the browser, nothing goes to the unit, and Run works again.
  B7  B4 with the page loaded again while its run is paused: the page that makes the
      change no longer holds the create's answer, only the execution the unit names.
  B8  B4 with the change made, and the run resumed, in a second tab opened on the paused
      run.
  B9  A Python environment kept at the Dashboard: made on the Environments page, picked
      in a UDF's property editor, installed by the unit when the run starts (the UDF's
      console says so); the computing-unit menu offers no environment action.

Writes <out>/report.json and one screenshot (or more) per case. Exit code 0 when every
selected case passes, 1 when one fails, 2 when setup fails.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import time
import traceback
import urllib.parse
import uuid
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from e2e import DATA_DIR, DATA_FILES, REPORTS, STACK_GENERATED, harness_git  # noqa: E402
from scenarios import TABULATE_LINES, UDF_TABULATE, Ctx, _installs_of, _precondition_no_tabulate  # noqa: E402
from texera_api import TexeraApi  # noqa: E402
from transport import make_transport  # noqa: E402
from workflow import Workflow, aggregate, csv_scan, filter_op, projection, python_udf, text_input  # noqa: E402

from playwright.sync_api import Error as PlaywrightError  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

STATUS_COMPLETED, STATUS_FAILED, STATUS_KILLED = 3, 4, 5
OLD_REQUESTS = ("WorkflowExecuteRequest", "ModifyLogicRequest")
WS_PATH = "/wsapi/workflow-websocket"
EXECUTIONS_PATH, ENVIRONMENTS_PATH = "/api/executions", "/api/environments"
UPDATES_PATH = re.compile(r"/api/executions/\d+/updates")
MISSING_COLUMN = "sce_no_such_column"
UNIT_CONTAINER = "sce-workflow-runtime-coordinator-service"

_T0 = time.monotonic()


def log(msg: str) -> None:
    print(f"[{time.monotonic() - _T0:7.1f}s] {msg}", flush=True)


class UiTimeout(RuntimeError):
    """The page did not get somewhere in time; the message says what it showed instead."""


# --------------------------------------------------------------------- workflows

SLOW_SLEEP_S = 0.2
TAG_SLEEP_S = 0.1

UDF_SLOW = f'''from pytexera import *
import time


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        time.sleep({SLOW_SLEEP_S})
        yield tuple_
'''

# The version is the last character of the code, so the change made in the code editor
# is three keys (to the end, Backspace, 2): nothing the editor completes or indents.
UDF_TAG = f'''from pytexera import *
import time


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        time.sleep({TAG_SLEEP_S})
        tuple_["tag"] = "v" + str(VERSION)
        yield tuple_


VERSION = 1'''

# Every run loads the module again, so each run's rows carry that run's stamp.
UDF_STAMP = '''from pytexera import *
import time

STAMP = str(time.time_ns())


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["stamp"] = STAMP
        yield tuple_
'''


def ui_content(wf: Workflow) -> dict:
    """workflow.py's UI content, moved right and down. The canvas starts at the window's
    left edge, under the dashboard's sidebar (200 px) and the editor's left panel, and
    workflow.py puts the first operator at x = 80: it could not be clicked there."""
    content = wf.ui_content()
    for pos in content["operatorPositions"].values():
        pos["x"] += 380
        pos["y"] += 120
    return content


# ----------------------------------------------------------------------- records

#: the texts a page hands the unit as it got them, reading nothing from them: the plan a
#: create answers and the change an update answers. A plan holds the links its operators
#: read files through, so the report gives each text by its length and digest only.
HANDED_ON = ("plan", "update")


def reported(value: Any) -> Any:
    """`value` as the report keeps it: each text a page hands on (HANDED_ON) by its length
    and digest."""
    if isinstance(value, dict):
        return {k: digest(v) if k in HANDED_ON and isinstance(v, str) else reported(v) for k, v in value.items()}
    if isinstance(value, list):
        return [reported(v) for v in value]
    return value


def digest(text: str) -> str:
    return f"<{len(text)} characters, sha256 {hashlib.sha256(text.encode()).hexdigest()[:16]}>"


@dataclass
class CaseRecord:
    key: str
    title: str
    outcome: str = "NOT RUN"
    duration_s: float = 0.0
    checks: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    screenshots: list[str] = field(default_factory=list)
    wids: list[int] = field(default_factory=list)
    eids: list[int] = field(default_factory=list)
    pages: list[dict] = field(default_factory=list)
    error: str | None = None

    def check(self, name: str, ok: bool, detail: Any = "") -> bool:
        detail = detail if isinstance(detail, str) else json.dumps(reported(detail), default=str)
        self.checks.append({"name": name, "ok": bool(ok), "detail": detail[:3000]})
        log(f"  [{'ok' if ok else 'FAIL'}] {name}{'' if ok else ' -- ' + detail[:500]}")
        return bool(ok)

    def note(self, text: str) -> None:
        self.notes.append(text)
        log(f"  [note] {text}")

    def to_json(self) -> dict:
        return {"key": self.key, "title": self.title, "outcome": self.outcome,
                "duration_s": round(self.duration_s, 1), "checks": self.checks, "notes": self.notes,
                "screenshots": self.screenshots, "wids": self.wids, "eids": self.eids,
                "pages": self.pages, "error": self.error}


# ------------------------------------------------------- what the page sent and got


class NetLog:
    """The network evidence of one page: requests to /api/executions* and
    /api/environments* with their status, and the frames of every websocket the page
    opened. Handlers only store; bodies are read later, from the main flow."""

    def __init__(self, page, token: str):
        self.token = token
        self._responses: list[tuple[float, Any]] = []
        self._failed: list[tuple[float, Any]] = []
        self._views: list[dict] = []  # of _responses, in step: each answer is read once
        self.http_errors: Counter = Counter()  # "METHOD path -> status" of every answer >= 400
        self._last_t = 0.0
        self.sockets: list[dict] = []
        page.on("response", lambda r: self._on_response(r))
        page.on("requestfailed", lambda r: self._on_failed(r))
        page.on("websocket", lambda ws: self._on_ws(ws))

    def _now(self) -> float:
        """The time of an event, strictly increasing in the order the events were reported, so
        that an answer and a frame of the same millisecond still compare."""
        self._last_t = max(time.time(), self._last_t + 1e-6)
        return self._last_t

    def redact(self, text: str) -> str:
        text = re.sub(r"(access-token=)[^&\s\"']+", r"\1<redacted>", text)
        return text.replace(self.token, "<token>") if self.token else text

    @staticmethod
    def _is_recorded(url: str) -> bool:
        return urllib.parse.urlsplit(url).path.startswith((EXECUTIONS_PATH, ENVIRONMENTS_PATH))

    def _on_response(self, resp) -> None:
        if self._is_recorded(resp.url):
            self._responses.append((self._now(), resp))
        if resp.status >= 400:
            path = urllib.parse.urlsplit(resp.url).path
            self.http_errors[f"{resp.request.method} {path} -> {resp.status}"] += 1

    def _on_failed(self, req) -> None:
        if self._is_recorded(req.url):
            self._failed.append((self._now(), req))

    def _on_ws(self, ws) -> None:
        sock = {"url": self.redact(ws.url), "opened_at": time.time(), "sent": [], "received": [],
                "closed_at": None}
        self.sockets.append(sock)
        ws.on("framesent", lambda payload: sock["sent"].append((self._now(), payload)))
        ws.on("framereceived", lambda payload: sock["received"].append((self._now(), payload)))
        ws.on("close", lambda _ws: sock.__setitem__("closed_at", time.time()))

    # ---- views

    @staticmethod
    def _parse(payload: Any) -> dict:
        if isinstance(payload, bytes):
            try:
                payload = payload.decode()
            except UnicodeDecodeError:
                return {"type": "<binary>", "bytes": len(payload)}
        try:
            msg = json.loads(payload)
        except (TypeError, ValueError):
            return {"type": "<text>", "text": str(payload)[:200]}
        return msg if isinstance(msg, dict) else {"type": "<json>", "value": msg}

    def workflow_sockets(self) -> list[dict]:
        return [s for s in self.sockets if WS_PATH in s["url"]]

    def sent(self, since: float = 0.0) -> list[tuple[float, dict]]:
        """Frames the page sent on the workflow websocket(s), in order."""
        out = [(t, self._parse(p)) for s in self.workflow_sockets() for t, p in s["sent"] if t >= since]
        return sorted(out, key=lambda x: x[0])

    def received(self, since: float = 0.0) -> list[tuple[float, dict]]:
        out = [(t, self._parse(p)) for s in self.workflow_sockets() for t, p in s["received"] if t >= since]
        return sorted(out, key=lambda x: x[0])

    def sent_types(self, since: float = 0.0, heartbeats: bool = False) -> list[str]:
        return [m.get("type", "?") for _, m in self.sent(since)
                if heartbeats or m.get("type") != "HeartBeatRequest"]

    def states(self, since: float = 0.0) -> list[str]:
        """The workflow states the unit reported (WorkflowStateEvent), in order."""
        return [m.get("state") for _, m in self.received(since) if m.get("type") == "WorkflowStateEvent"]

    def events(self, type_: str, since: float = 0.0) -> list[dict]:
        return [m for _, m in self.received(since) if m.get("type") == type_]

    def answered_at(self, resp) -> float | None:
        """When the answer `resp` to a request to /api/executions* was reported."""
        return next((t for t, r in self._responses if r is resp), None)

    def requests(self) -> list[dict]:
        """Every recorded request: method, path, status and a short view of the bodies (of
        a request that writes, and of what /api/environments answers to a read). An answer
        is read the first time it is listed (a body the browser no longer holds is noted):
        the browser drops the bodies of a document that is reloaded or left."""
        for t, resp in self._responses[len(self._views):]:
            req = resp.request
            path = urllib.parse.urlsplit(resp.url).path
            entry: dict[str, Any] = {"t": t, "method": req.method, "path": path, "status": resp.status}
            writes = req.method in ("POST", "PUT")
            if writes:
                try:
                    entry["request"] = self._brief_request(json.loads(req.post_data or "null"))
                except (ValueError, PlaywrightError) as e:
                    entry["request"] = f"<unreadable: {e}>"
            if writes or (req.method == "GET" and path.startswith(ENVIRONMENTS_PATH)):
                try:
                    entry["response"] = self._brief_response(reported(resp.json()))
                except Exception as e:  # noqa: BLE001 -- no body, or not JSON
                    try:
                        entry["response"] = self.redact(resp.text()[:600])
                    except Exception:  # noqa: BLE001
                        entry["response"] = f"<unreadable: {type(e).__name__}>"
            self._views.append(entry)
        out = list(self._views)
        for t, req in self._failed:
            out.append({"t": t, "method": req.method, "path": urllib.parse.urlsplit(req.url).path,
                        "status": None, "failure": req.failure})
        return sorted(out, key=lambda e: e["t"])

    def executions_requests(self) -> list[dict]:
        """Every request to /api/executions* (see `requests`)."""
        return [e for e in self.requests() if e["path"].startswith(EXECUTIONS_PATH)]

    def environments_requests(self) -> list[dict]:
        """Every request to /api/environments* (see `requests`)."""
        return [e for e in self.requests() if e["path"].startswith(ENVIRONMENTS_PATH)]

    @staticmethod
    def _brief_plan(plan: Any) -> Any:
        """A logical plan by its operators' ids, how many links it has and what it views."""
        if not isinstance(plan, dict):
            return plan
        return {"operators": [o.get("operatorID") for o in plan.get("operators") or []],
                "links": len(plan.get("links") or []), "opsToViewResult": plan.get("opsToViewResult")}

    @staticmethod
    def _brief_request(body: Any) -> Any:
        if not isinstance(body, dict):
            return body
        if "logicalPlan" in body:
            return {**{k: v for k, v in body.items() if k not in ("logicalPlan", "workflowSettings")},
                    "logicalPlan": NetLog._brief_plan(body.get("logicalPlan")), "keys": sorted(body)}
        if "operator" in body:
            op = body["operator"] or {}
            brief = {k: v for k, v in op.items() if k != "code"}
            if "code" in op:
                brief["code_tail"] = str(op["code"])[-60:]
                brief["code_sha256"] = hashlib.sha256(str(op["code"]).encode()).hexdigest()[:16]
            return {"operator": brief, "workflow": NetLog._brief_plan(body.get("workflow"))}
        return body

    def _kept(self, msg: dict) -> dict:
        """An event kept whole in the report (cut when it is very long)."""
        text = self.redact(json.dumps(msg, default=str))
        return json.loads(text) if len(text) <= 6000 else {"type": msg.get("type"), "cut": text[:6000]}

    @staticmethod
    def _brief_response(body: Any) -> Any:
        text = json.dumps(body, default=str)
        return body if len(text) <= 3000 else text[:3000] + "...<cut>"

    def to_json(self, t0: float) -> dict:
        def rel(t: float | None) -> float | None:
            return None if t is None else round(t - t0, 3)

        sockets = []
        others: Counter = Counter()
        for s in self.sockets:
            is_wf = WS_PATH in s["url"]
            sent = [(t, self._parse(p)) for t, p in s["sent"]]
            received = [(t, self._parse(p)) for t, p in s["received"]]
            if not is_wf and not sent and not received:
                # e.g. the shared-editing socket (/rtc/...), which this stack does not serve
                others[re.sub(r"/[0-9a-f-]{36}$|/\d+$", "/<id>", urllib.parse.urlsplit(s["url"]).path)] += 1
                continue
            entry: dict[str, Any] = {
                "url": s["url"], "opened_at": rel(s["opened_at"]), "closed_at": rel(s["closed_at"]),
                "frames_sent": len(sent), "frames_received": len(received),
                "sent_types": dict(Counter(m.get("type", "?") for _, m in sent)),
            }
            if is_wf:
                # every frame the page sent, whole but for what it hands on; heartbeats as a count
                entry["sent"] = [{"t": rel(t), **reported(m)} for t, m in sent if m.get("type") != "HeartBeatRequest"]
                entry["received_types"] = dict(Counter(m.get("type", "?") for _, m in received))
                entry["states"] = [{"t": rel(t), "state": m.get("state"), "executionId": m.get("executionId")}
                                   for t, m in received if m.get("type") == "WorkflowStateEvent"]
                entry["received_kept"] = [
                    {"t": rel(t), **self._kept(m)} for t, m in received
                    if m.get("type") in ("WorkflowErrorEvent", "ModifyLogicResponse", "ModifyLogicCompletedEvent")]
            sockets.append(entry)
        return {"executions_requests": [{**e, "t": rel(e["t"])} for e in self.executions_requests()],
                "environments_requests": [{**e, "t": rel(e["t"])} for e in self.environments_requests()],
                "websockets": sockets,
                "sockets_without_frames": dict(others),
                "http_answers_400_and_up": dict(self.http_errors)}


# ------------------------------------------------------------------------ the page

# The console (the bottom panel) as it is shown, a function of the page: whether it is open,
# the operator it is narrowed to ("Showing: <operator>"; null for every operator's messages),
# and its messages in order. A message's type is its badge's (PRINT, COMMAND, DEBUGGER, ERROR,
# ConsoleFrameComponent.labelMapping); `detail` is what a click on its title opens under it
# (in the page from the start, hidden until then: `opened`); the tags follow.
CONSOLE_JS = r"""() => {
  const frame = document.querySelector('#result-container texera-console-frame');
  if (!frame || frame.offsetParent === null) return { shown: false, showing: null, rows: [] };
  const text = e => (e ? e.textContent || '' : '').trim();
  const types = { default: 'PRINT', processing: 'COMMAND', warning: 'DEBUGGER', error: 'ERROR' };
  const notice = frame.querySelector('.operator-filter-notice');
  const rows = Array.from(frame.querySelectorAll('.console-message-entry')).map(li => {
    const dot = li.querySelector('.type-tag .ant-badge-status-dot');
    const status = dot
      ? (Array.from(dot.classList).find(c => c.startsWith('ant-badge-status-') && c !== 'ant-badge-status-dot') || '')
          .replace('ant-badge-status-', '')
      : null;
    const title = li.querySelector('.collapse-message-header');
    const body = li.querySelector('.console-message');
    const header = li.querySelector('.ant-collapse-header');
    return {
      type: status === null ? null : types[status] || status,
      title: text(title || body),
      detail: title ? text(body) : '',
      opened: header ? header.getAttribute('aria-expanded') === 'true' : null,
      operator: text(li.querySelector('.operator-tag')),
      source: text(li.querySelector('.source-tag')),
      time: text(li.querySelector('.timestamp-tag')),
      worker: text(li.querySelector('.worker-tag')),
    };
  });
  return { shown: true, showing: notice ? text(notice).replace(/^Showing:\s*/, '') : null, rows };
}"""

INIT_SCRIPT = r"""
(() => {
  if (window.__sce) return;
  const s = (window.__sce = { run: [], toasts: [], console: [], consoleKey: null });
  const readConsole = """ + CONSOLE_JS + r""";
  const tick = () => {
    try {
      const b = document.querySelector('#run-button');
      const text = b ? (b.innerText || '').trim() : null;
      if (b) {
        const disabled = !!b.disabled;
        const kill = document.querySelector('button[title^="Stop this run"]');
        const killDisabled = kill ? !!kill.disabled : null;
        const last = s.run[s.run.length - 1];
        if (!last || last.text !== text || last.disabled !== disabled || last.killDisabled !== killDisabled) {
          s.run.push({ t: Date.now(), text, disabled, killDisabled });
        }
      }
      document.querySelectorAll('.ant-message-notice').forEach(n => {
        const text = (n.textContent || '').trim();
        if (text && !n.__sceSeen) { n.__sceSeen = true; s.toasts.push({ t: Date.now(), text }); }
      });
      // what the console showed, as it changed, with what the run button said then
      const c = readConsole();
      if (!c.shown) {
        s.consoleKey = null;
      } else {
        const view = { button: text, showing: c.showing,
                       rows: c.rows.slice(-40).map(r => ({ type: r.type, title: r.title.slice(0, 300) })) };
        const key = JSON.stringify(view);
        if (key !== s.consoleKey) {
          s.consoleKey = key;
          if (s.console.length < 500) s.console.push({ t: Date.now(), ...view });
        }
      }
    } catch (e) {}
  };
  setInterval(() => {
    tick();
    // a state that lasts less than a tick (Submitting, when the create answers at once) is
    // caught by watching the button itself
    const b = document.querySelector('#run-button');
    if (b && !b.__sceWatched) {
      b.__sceWatched = true;
      new MutationObserver(tick).observe(b, { subtree: true, childList: true, characterData: true, attributes: true });
    }
  }, 40);
})();
"""


class Editor:
    """One browser page on one workflow of the editor, with its evidence."""

    def __init__(self, browser, *, base: str, token: str, cuid: int, wid: int, out: Path, key: str,
                 rec: CaseRecord, label: str = "", hold_compile: bool = False, tab_of: Editor | None = None):
        """A page in a browser context of its own, or, with `tab_of`, a second tab in that
        editor's context (the same sign-in and storage), on the same workflow."""
        self.base, self.wid, self.cuid, self.out, self.rec = base, wid, cuid, out, rec
        self.key = f"{key}-tab" if tab_of else key  # the prefix of this page's files
        self.label = label or f"wid {wid}"
        self.t0 = time.time()
        # what the page's earlier documents recorded (before a reload, or another address)
        self.earlier: dict[str, list[dict]] = {"run": [], "toasts": [], "console": []}
        self.loaded = False
        if tab_of:
            self.context = tab_of.context
        else:
            self.context = browser.new_context(viewport={"width": 1680, "height": 1050})
            storage = {"access_token": token, f"computing-unit-of-workflow-{wid}": str(cuid)}
            self.context.add_init_script(
                "try {" + "".join(f"localStorage.setItem({json.dumps(k)}, {json.dumps(v)});"
                                  for k, v in storage.items()) + "} catch (e) {}\n" + INIT_SCRIPT)
        self.page = self.context.new_page()
        self.page.set_default_timeout(30000)
        self.net = NetLog(self.page, token)
        # console errors and warnings and uncaught page errors, each text once with its count
        self.console: dict[tuple[str, str], dict] = {}
        self.page.on("console", lambda m: self._on_console(m.type, m.text))
        self.page.on("pageerror", lambda e: self._on_console("pageerror", str(e)))
        self.held_compiles: list[Any] = []
        self.compile_seen = 0
        if hold_compile:
            self.page.route("**/api/compile", self._hold)

    def _on_console(self, kind: str, text: str) -> None:
        if kind not in ("error", "warning", "pageerror"):
            return
        # one entry for the shared-editing socket's retries (/rtc/<id>), which this stack does not serve
        text = re.sub(r"(/rtc/)[0-9a-f-]{36}|(/rtc/)\d+", r"\1\2<id>", self.net.redact(text))[:1500]
        entry = self.console.setdefault((kind, text), {"t": time.time(), "count": 0})
        entry["count"] += 1

    # ---- the editor's own compile, held back (B2)

    def _hold(self, route) -> None:
        self.compile_seen += 1
        self.held_compiles.append(route)

    def release_compiles(self) -> int:
        """Let the held /api/compile requests go on, unchanged, and stop holding."""
        n = 0
        while self.held_compiles:
            route = self.held_compiles.pop(0)
            try:
                route.continue_()
                n += 1
            except PlaywrightError:
                pass
        self.page.unroute("**/api/compile")
        return n

    # ---- opening

    def open(self, operators: list[str], timeout: float = 90) -> None:
        """Load the workflow in the editor."""
        self._leave_document("(the workflow opened)")
        self.page.goto(f"{self.base}/user/workflow/{self.wid}", wait_until="domcontentloaded")
        self.loaded = True
        self._wait_loaded(operators, timeout)

    def goto(self, path: str, selector: str, timeout: float = 90) -> None:
        """Load another page of the app, by its path, and wait for `selector` on it."""
        self._leave_document(f"(left for {path})")
        self.page.goto(f"{self.base}{path}", wait_until="domcontentloaded")
        self.loaded = True
        self.page.wait_for_selector(selector, timeout=timeout * 1000)

    def reload(self, operators: list[str], timeout: float = 90) -> None:
        """Load the page again, as the browser's reload does: the page's code starts from
        nothing. What the page showed until now is kept for the report."""
        self._leave_document("(page reloaded)")
        self.page.reload(wait_until="domcontentloaded")
        self._wait_loaded(operators, timeout)

    def _leave_document(self, marker: str) -> None:
        """Before the page loads a document again or another one: keep what this one recorded,
        with `marker` among the run button's texts."""
        if not self.loaded:
            return
        self.net.requests()  # read while the browser holds the answers' bodies
        for name in self.earlier:
            self.earlier[name] = self._page_log(name)
        self.earlier["run"].append({"t": time.time() * 1000, "text": marker, "disabled": None,
                                    "killDisabled": None})

    def _wait_loaded(self, operators: list[str], timeout: float) -> None:
        deadline = time.monotonic() + timeout
        self.page.wait_for_selector("#run-button", timeout=timeout * 1000)
        missing = list(operators)
        while time.monotonic() < deadline:
            missing = [o for o in operators if self.page.locator(f'[model-id="{o}"]').count() == 0]
            if not missing:
                break
            self.page.wait_for_timeout(200)
        if missing:
            raise UiTimeout(f"the editor did not show operators {missing} of workflow {self.wid} "
                            f"within {timeout}s (url {self.page.url})")

    # ---- the run button and the stop button

    def run_button(self) -> dict:
        return self.page.evaluate("""() => {
            const b = document.querySelector('#run-button');
            const kill = document.querySelector('button[title^="Stop this run"]');
            return {text: b ? (b.innerText || '').trim() : null, disabled: b ? !!b.disabled : null,
                    killDisabled: kill ? !!kill.disabled : null};
        }""")

    def _page_log(self, name: str) -> list[dict]:
        """What the init script recorded under `name`, after what the page's earlier loads did."""
        return self.earlier[name] + self.page.evaluate(f"() => (window.__sce ? window.__sce.{name} : [])")

    def run_timeline(self) -> list[dict]:
        return [{"t": round(e["t"] / 1000 - self.t0, 3), "text": e["text"], "disabled": e["disabled"],
                 "killDisabled": e["killDisabled"]} for e in self._page_log("run")]

    def toasts(self) -> list[dict]:
        return [{"t": round(e["t"] / 1000 - self.t0, 3), "text": e["text"]} for e in self._page_log("toasts")]

    def console_timeline(self) -> list[dict]:
        """What the console showed while it was open, as it changed: the operator it was
        narrowed to, each message's type and title, and what the run button said then."""
        return [{"t": round(e["t"] / 1000 - self.t0, 3), "button": e["button"], "showing": e["showing"],
                 "rows": e["rows"]} for e in self._page_log("console")]

    def wait_run_button(self, *texts: str, timeout: float, enabled: bool | None = None) -> str:
        deadline = time.monotonic() + timeout
        last: dict = {}
        while time.monotonic() < deadline:
            last = self.run_button()
            if last["text"] in texts and (enabled is None or (not last["disabled"]) == enabled):
                return last["text"]
            self.page.wait_for_timeout(100)
        raise UiTimeout(f"the run button did not show {' or '.join(texts)}"
                        f"{'' if enabled is None else (' enabled' if enabled else ' disabled')} within "
                        f"{timeout:.0f}s; it shows {last}; its texts so far "
                        f"{[e['text'] for e in self.run_timeline()][-12:]}; toasts {self.toasts()[-4:]}")

    def click_run_button(self, expect_text: str) -> None:
        text = self.wait_run_button(expect_text, timeout=30, enabled=True)
        log(f"    click the run button ({text})")
        self.page.locator("#run-button").click()
        self.page.mouse.move(760, 620)  # off the button: its hover opens the Execution Settings popover

    def click_stop(self) -> None:
        log("    click the stop button")
        self.page.locator('button[title^="Stop this run"]').click()

    def wait_until(self, predicate: Callable[[], bool], timeout: float, what: str, every_ms: int = 150) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            self.page.wait_for_timeout(every_ms)
        raise UiTimeout(f"timed out after {timeout:.0f}s waiting for {what}; run button "
                        f"{self.run_button()}; states from the unit {self.net.states()[-8:]}; "
                        f"toasts {self.toasts()[-4:]}")

    # ---- the canvas

    def operator_states(self, operators: list[str]) -> dict[str, str | None]:
        return self.page.evaluate("""(ids) => Object.fromEntries(ids.map(id => {
            const g = document.querySelector(`[model-id="${id}"]`);
            const st = g && g.querySelector('.texera-operator-state');
            return [id, st ? (st.textContent || '').trim() : null];
        }))""", operators)

    def _operator_centre(self, op_id: str) -> tuple[float, float]:
        box = self.page.locator(f'[model-id="{op_id}"] rect.body').first.bounding_box()
        if not box:
            raise UiTimeout(f"operator {op_id} is not on the canvas")
        return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

    def select_operator(self, op_id: str) -> None:
        """Click the operator on the canvas, so the property editor shows it and the
        console is narrowed to it."""
        # By coordinates: the operator's own boundary rect lies over its body, so an
        # element click on the body waits forever for "nothing else to receive the click".
        self.page.mouse.click(*self._operator_centre(op_id))
        self.page.wait_for_timeout(300)

    # ---- an operator's result: the window the page pins beside the operator

    @staticmethod
    def result_window(op_id: str) -> str:
        return f'texera-pinned-result-window[data-operator-id="{op_id}"]'

    def result_is_open(self, op_id: str) -> bool:
        window = self.page.locator(self.result_window(op_id))
        return window.count() > 0 and window.first.is_visible()

    def open_result(self, op_id: str, how: str = "double-click", timeout: float = 15) -> None:
        """Open the operator's result beside it, as a user does: a double-click on the
        operator, or "pin result" in its right-click menu (`how` "menu"). The window stays
        until it is closed, so one that is open is left as it is."""
        if self.result_is_open(op_id):
            return
        x, y = self._operator_centre(op_id)
        way = "'pin result' in its right-click menu" if how == "menu" else "a double-click"
        if how == "menu":
            log("    right-click the operator, then 'pin result'")
            self.page.mouse.click(x, y, button="right")
            item = self.page.locator("texera-context-menu li", has_text=re.compile(r"^\s*pin result\s*$"))
            try:
                item.first.wait_for(state="visible", timeout=10000)
            except PlaywrightError:
                items = [t.strip() for t in self.page.locator("texera-context-menu li").all_inner_texts()]
                raise UiTimeout(f"the operator's right-click menu has no 'pin result'; its items: {items}")
            item.first.click()
        else:
            log("    double-click the operator")
            self.page.mouse.dblclick(x, y)
        try:
            self.page.locator(self.result_window(op_id)).first.wait_for(state="visible", timeout=timeout * 1000)
        except PlaywrightError:
            raise UiTimeout(f"no result window opened beside operator {op_id} within {timeout:.0f}s of {way}; "
                            f"result windows on the page: "
                            f"{self.page.locator('texera-pinned-result-window').count()}")

    def read_table(self, op_id: str) -> dict:
        """The operator's result window as shown: its title, the table's header texts, the
        rows of the current page and the pagination's page numbers. A window without a table
        (no result kept, an error) gives what it says instead, in `says`."""
        return self.page.evaluate("""(selector) => {
            const txt = e => (e.textContent || '').trim();
            const root = document.querySelector(selector);
            const none = {shown: false, open: !!root, title: '', says: '', columns: [], rows: [], pages: [],
                          current: null};
            if (!root) return none;
            const title = root.querySelector('.pinned-result__title');
            const tables = Array.from(root.querySelectorAll('.result-table'));
            const table = tables.find(t => t.offsetParent !== null) || null;
            if (!table) {
                const body = root.querySelector('.pinned-result__body');
                return {...none, title: title ? txt(title) : '',
                        says: body ? txt(body).replace(/\\s+/g, ' ').slice(0, 400) : ''};
            }
            const columns = Array.from(table.querySelectorAll('thead tr:first-child th')).map(txt);
            const rows = Array.from(table.querySelectorAll('tbody tr.table-row-hover'))
                .map(tr => Array.from(tr.querySelectorAll('td')).map(td => {
                    const c = td.querySelector('.cell-content');
                    return txt(c || td);
                }));
            const pages = Array.from(table.querySelectorAll('.ant-pagination li.ant-pagination-item')).map(txt);
            const cur = table.querySelector('.ant-pagination li.ant-pagination-item-active');
            return {shown: true, open: true, title: title ? txt(title) : '', says: '', columns, rows, pages,
                    current: cur ? txt(cur) : null};
        }""", self.result_window(op_id))

    def wait_table(self, op_id: str, predicate: Callable[[dict], bool], timeout: float, what: str) -> dict:
        deadline = time.monotonic() + timeout
        table: dict = {}
        while time.monotonic() < deadline:
            table = self.read_table(op_id)
            if table.get("shown") and predicate(table):
                return table
            self.page.wait_for_timeout(200)
        raise UiTimeout(f"the result window of {op_id} did not show {what} within {timeout:.0f}s; it shows "
                        f"{json.dumps(table)[:800]}")

    def table_dicts(self, table: dict) -> list[dict]:
        return [dict(zip(table["columns"], row)) for row in table["rows"]]

    def _pager(self, op_id: str, css: str):
        """The visible pagination control `css` of the operator's result table, or None."""
        loc = self.page.locator(f"{self.result_window(op_id)} .result-table .ant-pagination {css}")
        return next((loc.nth(i) for i in range(loc.count()) if loc.nth(i).is_visible()), None)

    def _turn_page(self, op_id: str, control, table: dict, what: str) -> dict:
        """Click a pagination control and wait for another page's rows: the page number
        turns at once, its rows come over the websocket a moment later."""
        before = (table["current"], table["rows"])
        control.click()
        return self.wait_table(op_id, lambda t: t["current"] != before[0] and t["rows"] != before[1]
                               and len(t["rows"]) > 0, 15, what)

    def read_all_pages(self, op_id: str, table: dict, max_pages: int = 80) -> list[dict]:
        """The rows of every page of the operator's result table, first page to last. (A
        window left open on page 2 over a new run is still on page 2 after it.)"""
        if table["current"] not in (None, "1"):
            first = self._pager(op_id, "li.ant-pagination-item")
            if first is not None:
                table = self._turn_page(op_id, first, table, "the first page")
        rows = self.table_dicts(table)
        for _ in range(max_pages):
            nxt = self._pager(op_id, "li.ant-pagination-next")
            if nxt is None or "ant-pagination-disabled" in (nxt.get_attribute("class") or ""):
                break
            table = self._turn_page(op_id, nxt, table, "the next page")
            rows.extend(self.table_dicts(table))
        return rows

    def goto_last_page(self, op_id: str) -> str | None:
        items = self.page.locator(f"{self.result_window(op_id)} .result-table .ant-pagination "
                                  f"li.ant-pagination-item")
        visible = [items.nth(i) for i in range(items.count()) if items.nth(i).is_visible()]
        if not visible:
            return None
        last = visible[-1]
        number = last.inner_text().strip()
        before = self.read_table(op_id)["rows"]
        last.click()
        # the page number turns at once; its rows come over the websocket a moment later
        self.wait_table(op_id, lambda t: t["current"] == number and t["rows"] != before and len(t["rows"]) > 0,
                        15, f"the rows of page {number}")
        return number

    # ---- the console: the bottom panel, with every message and error of the operators

    def open_console(self) -> None:
        """Open the console. Nothing opens it by itself: its button at the bottom left does."""
        content = self.page.locator("#result-container #content")
        if content.count() == 0 or not content.first.is_visible():
            log("    open the console")
            self.page.locator("#result-buttons .anticon-border").first.click()
            content.first.wait_for(state="visible", timeout=10000)
            self.page.mouse.move(760, 620)  # off the button, whose hover shows its tooltip

    def read_console(self) -> dict:
        """The console as shown (CONSOLE_JS): the operator it is narrowed to and its messages."""
        return self.page.evaluate(CONSOLE_JS)

    def open_console_message(self, title: str, timeout: float = 10) -> dict:
        """Click the title of the console message `title`, which opens what the message
        holds under it, and return the message as the console then shows it."""
        def find() -> dict | None:
            return next((r for r in self.read_console()["rows"] if r["title"] == title), None)

        row = find()
        if row is None:
            raise UiTimeout(f"the console has no message titled {title!r}")
        if not row["opened"]:
            self.page.locator("#result-container texera-console-frame .console-message-entry "
                              ".ant-collapse-header", has_text=title).first.click()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            row = find()
            if row and row["opened"]:
                self.page.wait_for_timeout(300)  # the panel slides open
                return row
            self.page.wait_for_timeout(150)
        raise UiTimeout(f"the console message {title!r} did not open within {timeout:.0f}s: {row}")

    # ---- evidence

    def screenshot(self, name: str) -> str:
        path = self.out / f"{self.key}-{name}.png"
        try:
            self.page.screenshot(path=str(path))
            self.rec.screenshots.append(str(path))
            log(f"    screenshot {path}")
        except PlaywrightError as e:
            self.rec.note(f"screenshot {name} failed: {e}")
        return str(path)

    def dump_html(self, name: str) -> None:
        try:
            (self.out / f"{self.key}-{name}.html").write_text(self.net.redact(self.page.content()))
        except Exception as e:  # noqa: BLE001
            self.rec.note(f"could not save the page's HTML: {e}")

    def evidence(self) -> dict:
        try:
            timeline, toasts, console, url = (self.run_timeline(), self.toasts(), self.console_timeline(),
                                              self.page.url)
        except PlaywrightError as e:
            timeline, toasts, console, url = [], [], [], f"<page gone: {e}>"
        return {"label": self.label, "wid": self.wid, "url": url,
                "network": self.net.to_json(self.t0),
                "run_button_timeline": timeline, "toasts": toasts, "console_timeline": console,
                "console": [{"first_at": round(e["t"] - self.t0, 3), "type": kind, "count": e["count"], "text": text}
                            for (kind, text), e in sorted(self.console.items(), key=lambda kv: kv[1]["t"])],
                "page_errors": sum(e["count"] for (kind, _), e in self.console.items() if kind == "pageerror"),
                "compile_requests_held": self.compile_seen or None}

    def close(self) -> None:
        """Keep the page's evidence and close the page. Its context, which a second tab may
        share, is closed when the case is over."""
        self.rec.pages.append(self.evidence())
        try:
            self.page.close()
        except PlaywrightError:
            pass


# ---------------------------------------------------------------------- the cases


class UnitChecks(Ctx):
    """scenarios.py's context, for what scenario g does on the unit (its precondition, the
    directory the unit installs environments in): a command runs in the unit's container,
    and its checks and notes go to the case's record."""

    def __init__(self, smoke: Smoke, rec: CaseRecord):
        super().__init__(smoke.api, smoke.transport, run_id=smoke.run_id, cuid=smoke.cuid, whid=smoke.whid,
                         paths=smoke.paths, data_dir=DATA_DIR, timeout=smoke.a.timeout, log=log,
                         transport_name="create-ws", unit_container=smoke.unit_container)
        self.case = rec

    def check(self, name: str, ok: bool, detail: Any = "") -> bool:
        return self.case.check(name, ok, detail)

    def note(self, text: str) -> None:
        self.case.note(text)


class Smoke:
    def __init__(self, a, api: TexeraApi, browser, *, cuid: int, whid: int | None, paths: dict[str, str],
                 run_id: str, out: Path, transport, unit_container: str = UNIT_CONTAINER):
        self.a, self.api, self.browser = a, api, browser
        self.cuid, self.whid, self.paths, self.run_id, self.out = cuid, whid, paths, run_id, out
        self.transport = transport
        self.unit_container = unit_container
        self.data = {name: list(csv.DictReader(io.StringIO((DATA_DIR / name).read_text()))) for name in paths}
        self.editors: list[Editor] = []

    # ---- helpers

    def workflow(self, key: str) -> Workflow:
        return Workflow(f"sce-browser {self.run_id} {key}")

    def save(self, rec: CaseRecord, wf: Workflow) -> int:
        wid = self.api.create_workflow(wf.name, ui_content(wf))
        rec.wids.append(wid)
        log(f"  workflow {wid} '{wf.name}' saved")
        return wid

    def editor(self, rec: CaseRecord, wid: int, *, label: str = "", hold_compile: bool = False,
               tab_of: Editor | None = None) -> Editor:
        ed = Editor(self.browser, base=self.a.base, token=self.api.token, cuid=self.cuid, wid=wid,
                    out=self.out, key=rec.key, rec=rec, label=label, hold_compile=hold_compile, tab_of=tab_of)
        self.editors.append(ed)
        return ed

    def press_run(self, ed: Editor, rec: CaseRecord, what: str = "Run") -> tuple[Any, Any, float]:
        """Click Run and return the create's response (status, body) and when it was pressed."""
        t_click = time.time()
        with ed.page.expect_response(
                lambda r: r.request.method == "POST" and urllib.parse.urlsplit(r.url).path == "/api/executions",
                timeout=150000) as info:
            ed.click_run_button("Run")
        resp = info.value
        try:
            body = resp.json()
        except Exception:  # noqa: BLE001
            body = resp.text()
        log(f"    {what}: POST /api/executions -> {resp.status} {json.dumps(reported(body), default=str)[:300]}")
        if isinstance(body, dict) and isinstance(body.get("eid"), int):
            rec.eids.append(body["eid"])
        return resp, body, t_click

    def check_start(self, ed: Editor, rec: CaseRecord, body: dict, since: float, what: str = "",
                    resp: Any = None) -> bool:
        """After a 201: the page sent WorkflowStartRequest with the create's eid and plan."""
        want = {"type": "WorkflowStartRequest", "executionId": body.get("eid"), "plan": body.get("plan")}
        try:
            ed.wait_until(lambda: any(m.get("type") == "WorkflowStartRequest" for _, m in ed.net.sent(since)),
                          20, "the page to send WorkflowStartRequest")
        except UiTimeout:
            pass
        starts = [(t, m) for t, m in ed.net.sent(since) if m.get("type") == "WorkflowStartRequest"]
        answered = ed.net.answered_at(resp) if resp is not None else None
        after = bool(starts) and answered is not None and starts[0][0] > answered
        return rec.check(f"{what}the page sent WorkflowStartRequest{{executionId, plan}} of the create's answer, "
                         f"after that answer", [m for _, m in starts] == [want] and after,
                         {"sent": [m for _, m in starts], "want": want,
                          "create_answered_at": answered and round(answered - ed.t0, 3),
                          "start_sent_at": starts and round(starts[0][0] - ed.t0, 3)})

    def wait_completed(self, ed: Editor, rec: CaseRecord, operators: list[str], since: float,
                       timeout: float, what: str = "") -> bool:
        """Completed, as the page shows it: the run button is Run again and every operator
        on the canvas says Completed."""
        try:
            ed.wait_until(lambda: "Completed" in ed.net.states(since) or "Failed" in ed.net.states(since)
                          or bool(ed.net.events("WorkflowErrorEvent", since)),
                          timeout, "the unit to report Completed")
            ed.wait_run_button("Run", timeout=20, enabled=True)
            ed.wait_until(lambda: all(s == "Completed" for s in ed.operator_states(operators).values()),
                          20, "every operator on the canvas to say Completed")
        except UiTimeout as e:
            rec.check(f"{what}the page shows the run Completed", False, str(e))
            return False
        errors = ed.net.events("WorkflowErrorEvent", since)
        button = ed.run_button()
        return rec.check(
            f"{what}the page shows the run Completed (run button Run, stop disabled, every operator Completed)",
            button["text"] == "Run" and not button["disabled"] and button["killDisabled"] is True
            and not errors and "Completed" in ed.net.states(since),
            {"run_button": button, "operators": ed.operator_states(operators),
             "states_from_unit": ed.net.states(since), "errors": errors[:2]})

    def persisted(self, rec: CaseRecord, wid: int, eid: int | None, want: int, what: str = "") -> None:
        if eid is None:
            entry = self.api.wait_execution_status(wid, want, timeout=30)
        else:
            entry = self.api.wait_entry_status(wid, eid, want, timeout=30)
        got = {k: (entry or {}).get(k) for k in ("eId", "status", "cuId", "whId")}
        rec.check(f"{what}the Dashboard records execution {eid if eid is not None else '(latest)'} with status {want}",
                  bool(entry) and entry.get("status") == want, got)

    def no_old_requests(self, rec: CaseRecord, ed: Editor, page: str = "the page") -> None:
        types = ed.net.sent_types()
        old = [t for t in types if t in OLD_REQUESTS]
        rec.check(f"{page} never sent WorkflowExecuteRequest or ModifyLogicRequest", not old,
                  {"sent_types": dict(Counter(types))})
        uncaught = [text for (kind, text) in ed.console if kind == "pageerror"]
        rec.check(f"no uncaught error in {page}", not uncaught, uncaught[:3])

    # ---- B1

    def b1(self, rec: CaseRecord) -> None:
        people = self.data["people.csv"]
        groups: dict[str, dict] = {}
        for p in people:
            if int(p["age"]) > 30:
                g = groups.setdefault(p["dept"], {"dept": p["dept"], "total_salary": 0.0, "n": 0})
                g["total_salary"] += float(p["salary"])
                g["n"] += 1
        expected = sorted(groups.values(), key=lambda r: r["dept"])

        wf = self.workflow("B1 scan-filter-aggregate")
        scan = wf.add("people", "CSVFileScan", csv_scan(self.paths["people.csv"]), n_in=0)
        flt = wf.add("age-over-30", "Filter", filter_op(("age", ">", "30")))
        agg = wf.add("by-dept", "Aggregate",
                     aggregate(["dept"], ("sum", "salary", "total_salary"), ("count", "salary", "n")))
        wf.link(scan, flt)
        wf.link(flt, agg)
        ops = [scan, flt, agg]
        wid = self.save(rec, wf)

        ed = self.editor(rec, wid)
        ed.open(ops)
        ed.wait_run_button("Run", timeout=90, enabled=True)
        rec.check("the editor opened the workflow and Run is enabled", True, ed.run_button())

        resp, body, t_click = self.press_run(ed, rec)
        if not rec.check("Run: POST /api/executions answers 201 with {eid, plan}",
                         resp.status == 201 and isinstance(body, dict) and isinstance(body.get("eid"), int)
                         and isinstance(body.get("plan"), str) and bool(body["plan"]),
                         {"status": resp.status, "body": body}):
            ed.screenshot("create-failed")
            return
        sent_body = json.loads(resp.request.post_data or "{}")
        rec.check("the create's body names the workflow, the unit and the warehouse, and carries the plan",
                  sent_body.get("wid") == wid and sent_body.get("computingUnitId") == self.cuid
                  and sent_body.get("warehouseId") == self.whid
                  and sorted(o.get("operatorID") for o in (sent_body.get("logicalPlan") or {}).get("operators") or [])
                  == sorted(ops)
                  and {"executionName", "engineVersion", "workflowSettings", "emailNotificationEnabled"} <= set(sent_body),
                  {"keys": sorted(sent_body), "wid": sent_body.get("wid"),
                   "computingUnitId": sent_body.get("computingUnitId"), "warehouseId": sent_body.get("warehouseId"),
                   "want": {"wid": wid, "computingUnitId": self.cuid, "warehouseId": self.whid}})
        self.check_start(ed, rec, body, t_click, resp=resp)
        completed = self.wait_completed(ed, rec, ops, t_click, self.a.timeout)
        if completed:
            self.check_rows(ed, rec, agg, expected, key="dept",
                            columns=["dept", "total_salary", "n"])
        ed.screenshot("completed")
        self.persisted(rec, wid, body.get("eid"), STATUS_COMPLETED)
        self.no_old_requests(rec, ed)

    def check_rows(self, ed: Editor, rec: CaseRecord, op: str, expected: list[dict], *, key: str,
                   columns: list[str], what: str = "", whose: str = "the last operator's",
                   how: str = "double-click") -> None:
        """Open the operator's result beside it (`how`: Editor.open_result) and compare the
        table it shows with `expected`."""
        by = "'pin result' in its right-click menu" if how == "menu" else "a double-click on it"
        try:
            ed.open_result(op, how)
            table = ed.wait_table(op, lambda t: len(t["rows"]) >= min(len(expected), 1)
                                  and t["columns"] == columns, 30, f"columns {columns} with rows")
        except (UiTimeout, PlaywrightError) as e:
            rec.check(f"{what}{whose} result table is shown beside it ({by})", False, str(e))
            return
        rec.check(f"{what}{whose} result table is shown beside it ({by}), with its columns",
                  table["columns"] == columns, {"columns": table["columns"], "window": table["title"]})
        try:
            shown = sorted(ed.read_all_pages(op, table), key=lambda r: r.get(key, ""))
        except (UiTimeout, PlaywrightError) as e:
            rec.check(f"{what}every page of the result table can be read", False, str(e))
            return
        want = sorted(expected, key=lambda r: str(r[key]))
        ok = len(shown) == len(want) and all(_same_row(s, w) for s, w in zip(shown, want))
        rec.check(f"{what}the rows shown are the expected ones ({len(want)} rows over "
                  f"{max(len(table['pages']), 1)} page(s), in any order)", ok,
                  {"shown": shown, "expected": want})

    # ---- B2

    def b2(self, rec: CaseRecord) -> None:
        def build(key: str) -> tuple[Workflow, str, str]:
            wf = self.workflow(key)
            scan = wf.add("people", "CSVFileScan", csv_scan(self.paths["people.csv"]), n_in=0)
            prj = wf.add("missing-column", "Projection", projection((MISSING_COLUMN, "")))
            wf.link(scan, prj)
            return wf, scan, prj

        # (1) As the page is: once the editor's own compile (POST /api/compile, half a second
        # after the workflow loads) has answered, Run is not offered for this workflow.
        wf0, scan0, prj0 = build("B2 compile-error (as the page is)")
        wid0 = self.save(rec, wf0)
        ed0 = self.editor(rec, wid0, label="as the page is: the editor's own compile answers")
        try:
            ed0.open([scan0, prj0])
            try:
                shown = ed0.wait_run_button("Invalid Workflow", timeout=40)
                rec.note("Once the editor's own compile has answered, the run button of a workflow with a "
                         f"Projection of a missing column shows '{shown}' and is disabled: for this workflow the "
                         "create's 400 is reachable from the page only before that answer (the rest of this case "
                         "holds the editor's POST /api/compile back until Run has been pressed; nothing is faked)")
            except UiTimeout as e:
                rec.note(f"with the editor's own compile answering, the run button did not turn to "
                         f"'Invalid Workflow': {e}")
            ed0.screenshot("editor-compile-disables-run")
        finally:
            ed0.close()

        # (2) Run pressed before the editor's compile answers: the create compiles, and refuses.
        wf, scan, prj = build("B2 compile-error-from-create")
        wid = self.save(rec, wf)
        ed = self.editor(rec, wid, label="the editor's compile held back until Run was pressed",
                         hold_compile=True)
        ed.open([scan, prj])
        ed.wait_run_button("Run", timeout=90, enabled=True)
        resp, body, t_click = self.press_run(ed, rec)
        body = body if isinstance(body, dict) else {}
        errors = body.get("operatorErrors") or {}
        rec.check("Run: POST /api/executions answers 400 with the Projection's error naming the column",
                  resp.status == 400 and prj in errors and MISSING_COLUMN in json.dumps(errors[prj]),
                  {"status": resp.status, "operatorErrors": {k: (v or {}).get("message") for k, v in errors.items()},
                   "errors": body.get("errors"), "eid": body.get("eid")})
        try:
            ed.wait_run_button("Run", timeout=20, enabled=True)
        except UiTimeout as e:
            rec.check("after the 400 the run button is Run again, enabled", False, str(e))
        else:
            b = ed.run_button()
            rec.check("after the 400 the run button is Run again, enabled, and stop is disabled",
                      b["text"] == "Run" and not b["disabled"] and b["killDisabled"] is True, b)
        ed.page.wait_for_timeout(1500)  # a start, if the page sent one, would be out by now
        rec.check("nothing was sent on the websocket for the refused run (no WorkflowStartRequest)",
                  ed.net.sent_types(t_click) == [], {"sent_after_run": ed.net.sent_types(t_click)})

        # the page shows the operator's error: in the console, as an error message of the Projection
        def projection_errors() -> list[dict]:
            console = ed.read_console()
            return [r for r in console["rows"] if console["showing"] == wf.op(prj).title
                    and r["type"] == "ERROR" and MISSING_COLUMN in r["title"]]

        try:
            ed.select_operator(prj)
            ed.open_console()
            ed.wait_until(lambda: bool(projection_errors()), 15,
                          "the console, narrowed to the Projection, to show an error naming the column")
        except (UiTimeout, PlaywrightError) as e:
            rec.check("the console shows the Projection's error", False,
                      f"{e} -- the console: {json.dumps(_console_brief(ed.read_console()))[:1500]}")
        else:
            console = ed.read_console()
            rec.check("the console shows the Projection's error (the Projection selected: an error message "
                      "naming the column)", bool(projection_errors()), _console_brief(console))
        ed.screenshot("compile-error-shown")

        # Run is usable again: press it once more, as it is
        resp2, body2, t_click2 = self.press_run(ed, rec, what="Run again")
        body2 = body2 if isinstance(body2, dict) else {}
        rec.check("Run pressed again creates again: a second 400, another execution",
                  resp2.status == 400 and isinstance(body2.get("eid"), int) and body2.get("eid") != body.get("eid"),
                  {"status": resp2.status, "eid": body2.get("eid"), "first_eid": body.get("eid")})
        for eid in (body.get("eid"), body2.get("eid")):
            if isinstance(eid, int):
                self.persisted(rec, wid, eid, STATUS_FAILED)

        # (3) Fix the operator in the property editor, run again, Completed.
        released = ed.release_compiles()
        rec.note(f"released {released} held POST /api/compile request(s) of the editor")
        try:
            shown = ed.wait_run_button("Invalid Workflow", timeout=30)
            rec.note(f"with the editor's compile answered, the run button shows '{shown}' (disabled) and the "
                     f"editor has emptied the Projection's attribute")
        except UiTimeout as e:
            rec.note(f"after the editor's compile was let through the run button did not turn to "
                     f"'Invalid Workflow': {e}")
        if not self._fix_projection_in_ui(ed, rec, prj):
            ed.screenshot("fix-failed")
            self.no_old_requests(rec, ed)
            return
        ed.wait_run_button("Run", timeout=40, enabled=True)
        resp3, body3, t_click3 = self.press_run(ed, rec, what="Run after the fix")
        body3 = body3 if isinstance(body3, dict) else {}
        if rec.check("after the fix Run creates the execution (201)", resp3.status == 201,
                     {"status": resp3.status, "body": body3}):
            self.check_start(ed, rec, body3, t_click3, what="after the fix ", resp=resp3)
            if self.wait_completed(ed, rec, [scan, prj], t_click3, self.a.timeout, what="after the fix "):
                expected = [{"name": p["name"]} for p in self.data["people.csv"]]
                self.check_rows(ed, rec, prj, expected, key="name", columns=["name"], what="after the fix ",
                                how="menu")
            self.persisted(rec, wid, body3.get("eid"), STATUS_COMPLETED, what="after the fix ")
        rec.check("exactly one WorkflowStartRequest went out on this page (the fixed run's)",
                  ed.net.sent_types().count("WorkflowStartRequest") == 1,
                  {"sent_types": dict(Counter(ed.net.sent_types()))})
        ed.screenshot("fixed-completed")
        self.no_old_requests(rec, ed)

    def _fix_projection_in_ui(self, ed: Editor, rec: CaseRecord, prj: str) -> bool:
        """Pick an existing column for the Projection in the property editor."""
        try:
            ed.select_operator(prj)
            select = ed.page.locator("#property-editor nz-select").first
            select.wait_for(state="visible", timeout=20000)
            select.click()
            option = ed.page.locator(".ant-select-dropdown .ant-select-item-option", has_text=re.compile(r"^\s*name\s*$"))
            option.first.wait_for(state="visible", timeout=10000)
            option.first.click()
            ed.page.wait_for_timeout(500)
            ed.page.keyboard.press("Escape")
            ed.wait_run_button("Run", timeout=40, enabled=True)
        except (UiTimeout, PlaywrightError) as e:
            rec.check("the Projection is fixed in the property editor (an existing column picked)", False, str(e))
            ed.dump_html("fix-failed")
            return False
        return rec.check("the Projection is fixed in the property editor (column `name` picked) and Run is "
                         "offered again", True, ed.run_button())

    # ---- B3

    def b3(self, rec: CaseRecord) -> None:
        total = len(self.data["numbers.csv"])
        wf = self.workflow("B3 pause-resume-kill")
        scan = wf.add("numbers", "CSVFileScan", csv_scan(self.paths["numbers.csv"]), n_in=0)
        udf = wf.add("slow-udf", "PythonUDFV2", python_udf(UDF_SLOW))
        wf.link(scan, udf)
        wid = self.save(rec, wf)

        ed = self.editor(rec, wid)
        ed.open([scan, udf])
        ed.wait_run_button("Run", timeout=90, enabled=True)
        resp, body, t_click = self.press_run(ed, rec)
        if not rec.check("Run: POST /api/executions answers 201", resp.status == 201,
                         {"status": resp.status, "body": body}):
            ed.screenshot("create-failed")
            return
        self.check_start(ed, rec, body, t_click, resp=resp)

        def shows(text: str, timeout: float, what: str) -> bool:
            try:
                ed.wait_run_button(text, timeout=timeout, enabled=True)
            except UiTimeout as e:
                rec.check(what, False, str(e))
                return False
            return True

        if not shows("Pause", self.a.timeout, "Running: the run button offers Pause"):
            ed.screenshot("not-running")
            return
        rec.check("Running: the run button offers Pause, stop is enabled",
                  ed.run_button()["killDisabled"] is False, ed.run_button())
        ed.page.wait_for_timeout(3000)  # let the UDF emit some rows
        ed.screenshot("running")

        t_pause = time.time()
        ed.click_run_button("Pause")
        if not shows("Resume", 120, "Pause pressed: the run button offers Resume (Paused)"):
            ed.screenshot("not-paused")
            return
        states = ed.operator_states([scan, udf])
        rec.check("Paused: the run button offers Resume and the UDF on the canvas says Paused",
                  states.get(udf) == "Paused", {"operators": states, "states_from_unit": ed.net.states(t_pause)})
        ed.page.wait_for_timeout(3000)
        rec.check("still Paused after 3 s", ed.run_button()["text"] == "Resume"
                  and "Running" not in ed.net.states(t_pause),
                  {"run_button": ed.run_button(), "states_from_unit": ed.net.states(t_pause)})
        ed.screenshot("paused")

        t_resume = time.time()
        ed.click_run_button("Resume")
        if not shows("Pause", 120, "Resume pressed: the run button offers Pause again (Running)"):
            ed.screenshot("not-resumed")
            return
        try:
            ed.wait_until(lambda: ed.operator_states([udf]).get(udf) == "Running", 30,
                          "the UDF on the canvas to say Running")
        except UiTimeout:
            pass
        rec.check("Resumed: the run button offers Pause and the UDF on the canvas says Running",
                  ed.operator_states([udf]).get(udf) == "Running",
                  {"operators": ed.operator_states([scan, udf]), "states_from_unit": ed.net.states(t_resume)})
        ed.page.wait_for_timeout(2000)

        t_kill = time.time()
        ed.click_stop()
        try:
            ed.wait_until(lambda: "Killed" in ed.net.states(t_kill), 60, "the unit to report Killed")
            ed.wait_run_button("Run", timeout=20, enabled=True)
        except UiTimeout as e:
            rec.check("Stop pressed: the run ends Killed", False, str(e))
        else:
            b = ed.run_button()
            rec.check("Stop pressed: the unit reports Killed; the run button is Run again and stop is disabled",
                      b["text"] == "Run" and not b["disabled"] and b["killDisabled"] is True,
                      {"run_button": b, "states_from_unit": ed.net.states(t_kill),
                       "operators": ed.operator_states([scan, udf])})
        ed.screenshot("killed")

        all_states = ed.net.states(t_click)
        rec.check("states from the unit, in order: Running, Paused, Running, Killed; never Completed",
                  _is_subsequence(["Running", "Paused", "Running", "Killed"], all_states)
                  and "Completed" not in all_states, all_states)
        texts = [e["text"] for e in ed.run_timeline()]
        rec.check("the run button went Run, Pause, Resume, Pause, Run",
                  _is_subsequence(["Run", "Pause", "Resume", "Pause", "Run"], texts), texts)
        sent = ed.net.sent_types(t_click)
        control = [t for t in sent if t in ("WorkflowStartRequest", "WorkflowPauseRequest",
                                            "WorkflowResumeRequest", "WorkflowKillRequest")]
        rec.check("frames sent: WorkflowStartRequest, WorkflowPauseRequest, WorkflowResumeRequest, "
                  "WorkflowKillRequest, once each, in that order",
                  control == ["WorkflowStartRequest", "WorkflowPauseRequest", "WorkflowResumeRequest",
                              "WorkflowKillRequest"], {"sent_types": sent})
        self.persisted(rec, wid, body.get("eid"), STATUS_KILLED)
        rec.note(f"{total} rows at {SLOW_SLEEP_S}s each: the run was stopped long before its end")
        self.no_old_requests(rec, ed)

    # ---- B4, B7, B8: a change to a paused operator, on the page that started the run or another

    def b4(self, rec: CaseRecord) -> None:
        wid, scan, udf = self.tagger(rec, "B4 change-paused-operator")
        ed = self.editor(rec, wid)
        eid = self.run_and_pause(ed, rec, [scan, udf])
        if eid is not None:
            self.change_paused_udf(ed, rec, wid, scan, udf, eid)

    def b7(self, rec: CaseRecord) -> None:
        """The page is loaded again while its run is paused. Nothing in it holds the create's
        answer any more: the execution it changes is the one the unit names."""
        wid, scan, udf = self.tagger(rec, "B7 change-after-reload")
        ed = self.editor(rec, wid)
        eid = self.run_and_pause(ed, rec, [scan, udf])
        if eid is None:
            return
        t_reload = time.time()
        log("    reload the page")
        ed.reload([scan, udf])
        if self.check_joined_paused(ed, rec, [scan, udf], eid, t_reload, "after the reload"):
            self.change_paused_udf(ed, rec, wid, scan, udf, eid)
        else:
            self.no_old_requests(rec, ed)

    def b8(self, rec: CaseRecord) -> None:
        """The change is made, and the run resumed, in a second tab of the same browser,
        opened on the workflow while the first page holds its run paused."""
        wid, scan, udf = self.tagger(rec, "B8 change-in-second-tab")
        first = self.editor(rec, wid, label="the first page: starts the run and pauses it")
        eid = self.run_and_pause(first, rec, [scan, udf])
        if eid is None:
            return
        t_paused = time.time()
        log("    open the workflow in a second tab")
        second = self.editor(rec, wid, label="the second tab: opened on the paused run, changes the UDF and resumes",
                             tab_of=first)
        second.open([scan, udf])
        if self.check_joined_paused(second, rec, [scan, udf], eid, t_paused, "in the second tab"):
            self.change_paused_udf(second, rec, wid, scan, udf, eid)
            # the first page only watched
            sent = first.net.sent_types(t_paused)
            posts = [e["path"] for e in first.net.executions_requests()
                     if e["method"] == "POST" and e["t"] >= t_paused]
            rec.check("the first page sent neither the change nor the resume: both were the second tab's",
                      not posts and not {"OperatorUpdateRequest", "WorkflowResumeRequest"} & set(sent),
                      {"sent_since_paused": sent, "posts_since_paused": posts})
            self.wait_completed(first, rec, [scan, udf], t_paused, 60, what="the first page: ")
            first.screenshot("first-page-completed")
        else:
            self.no_old_requests(rec, second)
        self.no_old_requests(rec, first, page="the first page")

    def tagger(self, rec: CaseRecord, name: str) -> tuple[int, str, str]:
        """The workflow of these cases, saved: numbers.csv -> the UDF tagging "v" + str(VERSION).
        Returns its wid and the two operators."""
        wf = self.workflow(name)
        scan = wf.add("numbers", "CSVFileScan", csv_scan(self.paths["numbers.csv"]), n_in=0)
        udf = wf.add("tagger", "PythonUDFV2", python_udf(UDF_TAG, out_columns=[("tag", "string")]))
        wf.link(scan, udf)
        return self.save(rec, wf), scan, udf

    def run_and_pause(self, ed: Editor, rec: CaseRecord, ops: list[str]) -> int | None:
        """Open the workflow, press Run and, once the run is going, Pause. Returns the
        execution, or None when it was not created."""
        ed.open(ops)
        ed.wait_run_button("Run", timeout=90, enabled=True)
        resp, body, t_click = self.press_run(ed, rec)
        if not rec.check("Run: POST /api/executions answers 201", resp.status == 201,
                         {"status": resp.status, "body": body}):
            ed.screenshot("create-failed")
            return None
        self.check_start(ed, rec, body, t_click, resp=resp)
        ed.wait_run_button("Pause", timeout=self.a.timeout, enabled=True)
        ed.page.wait_for_timeout(2500)
        ed.click_run_button("Pause")
        ed.wait_run_button("Resume", timeout=120, enabled=True)
        rec.check("the run is Paused (run button Resume)", True, ed.operator_states(ops))
        return body.get("eid")

    def check_joined_paused(self, ed: Editor, rec: CaseRecord, ops: list[str], eid: int, since: float,
                            where: str) -> bool:
        """A page loaded (since `since`) on a run it did not start, held paused: it shows the
        run Paused, having been told the state as it stands and the execution it is of, and
        has created and started nothing itself. False when it does not show the run Paused."""
        try:
            ed.wait_run_button("Resume", timeout=60, enabled=True)
        except UiTimeout as e:
            rec.check(f"{where} the page shows the run Paused (run button Resume)", False,
                      f"{e} -- states from the unit {ed.net.events('WorkflowStateEvent', since)}")
            ed.screenshot("not-paused")
            return False
        button = ed.run_button()
        rec.check(f"{where} the page shows the run Paused (run button Resume, stop enabled)",
                  button["killDisabled"] is False, {"run_button": button, "operators": ed.operator_states(ops)})
        states = ed.net.events("WorkflowStateEvent", since)
        rec.check(f"{where} the unit named the paused execution to the page: "
                  "WorkflowStateEvent{state: Paused, executionId} of the run's eid",
                  any(s.get("state") == "Paused" and s.get("executionId") == eid for s in states),
                  {"eid": eid, "state_events": states})
        posts = [f"{e['path']} -> {e['status']}" for e in ed.net.executions_requests()
                 if e["method"] == "POST" and e["t"] >= since]
        sent = ed.net.sent_types(since)
        rec.check(f"{where} the page created no execution and started none",
                  not posts and "WorkflowStartRequest" not in sent, {"posts": posts, "sent_types": sent})
        ed.screenshot("joined-paused")
        return True

    def change_paused_udf(self, ed: Editor, rec: CaseRecord, wid: int, scan: str, udf: str, eid: int) -> None:
        """On a page that shows the run of execution `eid` Paused: change the UDF's code in the
        code editor (VERSION = 2), confirm, resume; then the update, the frames and the rows."""
        total = len(self.data["numbers.csv"])
        # the property editor of the UDF: unlock, change the code, confirm
        t_edit = time.time()
        update_resp = None
        try:
            ed.select_operator(udf)
            unlock = ed.page.locator("button", has_text="Unlock for Logic Change")
            unlock.first.wait_for(state="visible", timeout=20000)
            unlock.first.click()
            confirm = ed.page.locator("button", has_text="Confirm Change")
            confirm.first.wait_for(state="visible", timeout=10000)
            ed.page.locator("#editor-button button", has_text="Edit code content").first.click()
            lines = ed.page.locator("#code-editor .monaco-editor .view-lines")
            lines.first.wait_for(state="visible", timeout=90000)
            ed.wait_until(lambda: "VERSION = 1" in self._editor_text(ed), 30, "the code editor to show the code")
            ed.page.wait_for_timeout(1000)  # the editor lays itself out once more after its first paint
            # Click behind the last line (the version), then End, Backspace, 2.
            last = ed.page.evaluate("""() => {
                const lines = Array.from(document.querySelectorAll('#code-editor .monaco-editor .view-lines .view-line'))
                    .map(l => { const r = (l.querySelector('span') || l).getBoundingClientRect();
                                return {top: r.top, right: r.right, height: r.height, text: l.innerText}; })
                    .sort((a, b) => a.top - b.top);
                return lines[lines.length - 1];
            }""")
            ed.page.mouse.click(last["right"] + 30, last["top"] + last["height"] / 2)
            ed.page.keyboard.press("End")
            ed.page.keyboard.press("Backspace")
            ed.page.keyboard.type("2")
            ed.wait_until(lambda: "VERSION = 2" in self._editor_text(ed), 10,
                          "the code editor to show VERSION = 2")
            ed.screenshot("code-changed")
            ed.page.locator("#code-editor-container #close-button").first.click()
            # the update of whichever execution the page names: which one is checked below
            with ed.page.expect_response(
                    lambda r: r.request.method == "POST"
                    and UPDATES_PATH.fullmatch(urllib.parse.urlsplit(r.url).path) is not None,
                    timeout=60000) as info:
                confirm.first.click()
            update_resp = info.value
        except (UiTimeout, PlaywrightError) as e:
            rec.check("the UDF's code is changed in the code editor and confirmed (Unlock for Logic Change, "
                      "Edit code content, Confirm Change)", False,
                      f"{e} -- editor text: {self._editor_text(ed)[-200:]!r}; run button {ed.run_button()}; "
                      f"toasts {ed.toasts()[-4:]}")
            ed.screenshot("edit-failed")
            ed.dump_html("edit-failed")
        if update_resp is None:
            # leave the unit idle for the next case
            try:
                ed.click_stop()
                ed.wait_run_button("Run", timeout=60, enabled=True)
            except (UiTimeout, PlaywrightError):
                pass
            self.no_old_requests(rec, ed)
            return
        try:
            update_body = update_resp.json()
        except Exception:  # noqa: BLE001
            update_body = update_resp.text()
        sent = json.loads(update_resp.request.post_data or "{}") or {}
        sent_op = sent.get("operator") or {}
        update_path = urllib.parse.urlsplit(update_resp.url).path
        rec.check("Confirm Change: POST /api/executions/{eid}/updates, of the run's execution, answers 201 "
                  "with {operatorId, update}",
                  update_path == f"/api/executions/{eid}/updates" and update_resp.status == 201
                  and isinstance(update_body, dict) and update_body.get("operatorId") == udf
                  and isinstance(update_body.get("update"), str) and bool(update_body["update"]),
                  {"path": update_path, "eid": eid, "status": update_resp.status, "body": update_body})
        rec.check("the update carries the operator as the editor holds it: the UDF with VERSION = 2",
                  sent_op.get("operatorID") == udf and str(sent_op.get("code", "")).rstrip().endswith("VERSION = 2"),
                  {"operatorID": sent_op.get("operatorID"), "operatorType": sent_op.get("operatorType"),
                   "code_tail": str(sent_op.get("code", ""))[-40:]})
        # The page takes the workflow as an operator is unlocked for the change, before the edit.
        ran = {o.get("operatorID"): o for o in (sent.get("workflow") or {}).get("operators") or []}
        ran_code = str((ran.get(udf) or {}).get("code", ""))
        rec.check("the update carries the workflow the run ran, as it was before the change: both operators, "
                  "the UDF with VERSION = 1",
                  sorted(ran) == sorted([scan, udf]) and ran_code.rstrip().endswith("VERSION = 1"),
                  {"operators": sorted(ran), "udf_code_tail": ran_code[-40:]})
        want = {"type": "OperatorUpdateRequest", "executionId": eid,
                "update": update_body.get("update") if isinstance(update_body, dict) else None}
        try:
            ed.wait_until(lambda: any(m.get("type") == "OperatorUpdateRequest" for _, m in ed.net.sent(t_edit)),
                          20, "the page to send OperatorUpdateRequest")
            ed.wait_until(lambda: bool(ed.net.events("ModifyLogicResponse", t_edit)), 30,
                          "the unit's ModifyLogicResponse")
        except UiTimeout:
            pass
        updates = [m for _, m in ed.net.sent(t_edit) if m.get("type") == "OperatorUpdateRequest"]
        rec.check("the page sent OperatorUpdateRequest{executionId, update} of the update's answer",
                  updates == [want], {"sent": updates, "want": want})
        answers = ed.net.events("ModifyLogicResponse", t_edit)
        rec.check("the unit answered ModifyLogicResponse with isValid true",
                  len(answers) == 1 and answers[0].get("isValid") is True, answers)
        ed.page.wait_for_timeout(500)
        rec.check("the page says the change is registered (toast)",
                  any("reconfiguration registered" in t["text"] for t in ed.toasts()), ed.toasts()[-5:])
        ed.screenshot("change-confirmed")

        t_resume = time.time()
        ed.click_run_button("Resume")
        self.wait_completed(ed, rec, [scan, udf], t_resume, self.a.timeout, what="resumed: ")
        done = ed.net.events("ModifyLogicCompletedEvent", t_edit)
        rec.check("the unit reported ModifyLogicCompletedEvent for the UDF",
                  any(udf in (e.get("opIds") or []) for e in done), done)

        # the rows, as the page shows them beside the UDF: the first page is v1, the last page v2
        try:
            ed.open_result(udf)
            first = ed.wait_table(udf, lambda t: len(t["rows"]) > 0 and "tag" in t["columns"], 30,
                                  "rows with a tag column")
            first_rows = ed.table_dicts(first)
            ed.screenshot("result-first-page")
            last_no = ed.goto_last_page(udf)
            last = ed.read_table(udf)
            last_rows = ed.table_dicts(last)
            ed.screenshot("result-last-page")
        except (UiTimeout, PlaywrightError) as e:
            rec.check("the result table of the UDF, opened beside it, shows v1 on its first page and v2 on its "
                      "last", False, str(e))
        else:
            rec.check("the result table of the UDF, opened beside it (a double-click), shows v1 rows on its "
                      "first page and v2 rows on its last",
                      first.get("current") == "1" and bool(first_rows)
                      and all(r.get("tag") == "v1" for r in first_rows)
                      and bool(last_rows) and all(r.get("tag") == "v2" for r in last_rows),
                      {"first_page": first_rows[:3], "last_page_number": last_no, "last_page": last_rows[-3:],
                       "pages": first.get("pages"), "window": first.get("title")})

        # all rows, read back over a second socket on the same run (the driver's transport)
        try:
            handle = self.transport.open_socket(wid, self.cuid)
            try:
                rows = handle.results(udf)["rows"]
            finally:
                handle.close()
            tags = Counter(r.get("tag") for r in rows)
            v1 = [int(r["n"]) for r in rows if r.get("tag") == "v1"]
            v2 = [int(r["n"]) for r in rows if r.get("tag") == "v2"]
            rec.check(f"all {total} rows read back: some v1, the rest v2, every v1 before every v2",
                      len(rows) == total and set(tags) == {"v1", "v2"} and max(v1) < min(v2),
                      {"tags": dict(tags), "v1_n": [min(v1, default=None), max(v1, default=None)],
                       "v2_n": [min(v2, default=None), max(v2, default=None)]})
        except Exception as e:  # noqa: BLE001
            rec.check(f"all {total} rows read back over a second socket", False, f"{type(e).__name__}: {e}")
        self.persisted(rec, wid, eid, STATUS_COMPLETED)
        self.no_old_requests(rec, ed)

    @staticmethod
    def _editor_text(ed: Editor) -> str:
        try:
            return ed.page.evaluate("""() => {
                const lines = document.querySelector('#code-editor .monaco-editor .view-lines');
                return lines ? (lines.innerText || '').replace(/\\u00a0/g, ' ') : '';
            }""")
        except PlaywrightError:
            return ""

    # ---- B5

    def b5(self, rec: CaseRecord) -> None:
        people = self.data["people.csv"]
        wf = self.workflow("B5 run-again")
        scan = wf.add("people", "CSVFileScan", csv_scan(self.paths["people.csv"]), n_in=0)
        udf = wf.add("stamp", "PythonUDFV2", python_udf(UDF_STAMP, out_columns=[("stamp", "string")]))
        wf.link(scan, udf)
        ops = [scan, udf]
        wid = self.save(rec, wf)
        ed = self.editor(rec, wid)
        ed.open(ops)
        ed.wait_run_button("Run", timeout=90, enabled=True)

        stamps: list[str] = []
        bodies: list[dict] = []
        left_open: list[bool] = []  # per run: the UDF's result window was open when the run ended
        for n, what in ((1, "first run: "), (2, "second run: ")):
            resp, body, t_click = self.press_run(ed, rec, what=what.strip(": "))
            body = body if isinstance(body, dict) else {}
            if not rec.check(f"{what}POST /api/executions answers 201", resp.status == 201,
                             {"status": resp.status, "body": body}):
                ed.screenshot(f"run{n}-create-failed")
                return
            bodies.append(body)
            self.check_start(ed, rec, body, t_click, what=what, resp=resp)
            if not self.wait_completed(ed, rec, ops, t_click, self.a.timeout, what=what):
                ed.screenshot(f"run{n}-not-completed")
                return
            try:
                # the first run's window is not closed: the second run's rows are read in it
                left_open.append(ed.result_is_open(udf))
                ed.open_result(udf)
                table = ed.wait_table(
                    udf, lambda t: len(t["rows"]) > 0 and "stamp" in t["columns"]
                    and not ({r.get("stamp") for r in ed.table_dicts(t)} & set(stamps)),
                    30, "rows with this run's stamp")
            except (UiTimeout, PlaywrightError) as e:
                rec.check(f"{what}the UDF's result window shows this run's rows", False, str(e))
                ed.screenshot(f"run{n}-no-result")
                return
            try:
                rows = ed.read_all_pages(udf, table)
            except (UiTimeout, PlaywrightError) as e:
                rec.check(f"{what}every page of the result table can be read", False, str(e))
                return
            seen = {r.get("stamp") for r in rows}
            names = sorted(r.get("name") for r in rows)
            rec.check(f"{what}the UDF's result window shows this run's rows (one stamp on all {len(people)} "
                      f"people)", len(seen) == 1 and names == sorted(p["name"] for p in people),
                      {"stamps": sorted(seen), "names": names, "earlier_stamps": stamps,
                       "window_open_when_the_run_ended": left_open[-1]})
            stamps.extend(sorted(seen))
            ed.screenshot(f"run{n}-completed")
            self.persisted(rec, wid, body.get("eid"), STATUS_COMPLETED, what=what)
        rec.check("the second run is another execution with another plan",
                  bodies[0].get("eid") != bodies[1].get("eid") and bodies[0].get("plan") != bodies[1].get("plan"),
                  {"first": bodies[0], "second": bodies[1]})
        rec.check("the second run's rows replaced the first's in the result window, left open over the second "
                  "run (a later stamp)",
                  len(stamps) == 2 and stamps[0].isdigit() and stamps[1].isdigit() and int(stamps[1]) > int(stamps[0])
                  and left_open == [False, True], {"stamps": stamps, "window_open_when_each_run_ended": left_open})
        starts = [m for _, m in ed.net.sent() if m.get("type") == "WorkflowStartRequest"]
        rec.check("two WorkflowStartRequest frames, one per run, each with its own execution",
                  [s.get("executionId") for s in starts] == [b.get("eid") for b in bodies], starts)
        self.no_old_requests(rec, ed)

    # ---- B6 (extra)

    def b6(self, rec: CaseRecord) -> None:
        """Stop pressed while the execution is still being created. The create is sent to
        the Dashboard as it is; only its answer is kept from the page until Stop has been
        pressed, as on a slow network."""
        wf = self.workflow("B6 stop-before-start")
        scan = wf.add("people", "CSVFileScan", csv_scan(self.paths["people.csv"]), n_in=0)
        flt = wf.add("age-over-30", "Filter", filter_op(("age", ">", "30")))
        wf.link(scan, flt)
        ops = [scan, flt]
        wid = self.save(rec, wf)
        ed = self.editor(rec, wid)
        late: list[tuple[Any, Any]] = []

        def keep_answer(route) -> None:
            if route.request.method != "POST":
                route.continue_()
                return
            late.append((route, route.fetch()))  # the Dashboard creates the execution now

        is_create = lambda url: urllib.parse.urlsplit(url).path == "/api/executions"  # noqa: E731
        ed.page.route(is_create, keep_answer)
        ed.open(ops)
        ed.wait_run_button("Run", timeout=90, enabled=True)
        t_click = time.time()
        ed.click_run_button("Run")
        try:
            ed.wait_until(lambda: bool(late), 30, "the create to reach the Dashboard")
            ed.wait_run_button("Submitting", timeout=10)
        except UiTimeout as e:
            rec.check("Run pressed: the run button shows Submitting while the execution is created", False, str(e))
            ed.screenshot("not-submitting")
            return
        b = ed.run_button()
        answer = late[0][1]
        created = answer.json() if answer.status == 201 else {}
        if isinstance(created.get("eid"), int):
            rec.eids.append(created["eid"])
        rec.check("Run pressed: the Dashboard created the execution (201); the page, still without the answer, "
                  "shows Submitting and offers Stop",
                  answer.status == 201 and b["text"] == "Submitting" and b["killDisabled"] is False,
                  {"status": answer.status, "body": created, "run_button": b})
        ed.screenshot("submitting")
        ed.click_stop()
        try:
            ed.wait_run_button("Run", timeout=10, enabled=True)
        except UiTimeout as e:
            rec.check("Stop pressed before the start: the run button is Run again", False, str(e))
        else:
            b = ed.run_button()
            rec.check("Stop pressed before the start: the run is given up in the browser (run button Run, stop disabled)",
                      b["text"] == "Run" and b["killDisabled"] is True, b)
        for route, resp in late:
            try:
                route.fulfill(response=resp)  # the answer, now; the page has dropped the request
            except PlaywrightError:
                pass
        ed.page.unroute(is_create)
        ed.page.wait_for_timeout(2500)  # a start or a kill, if the page sent one, would be out by now
        dropped = [e for e in ed.net.executions_requests() if e["method"] == "POST" and e["status"] is None]
        rec.note(f"the create's 201 was handed to the page only after Stop; by then the page had dropped the "
                 f"request ({[e.get('failure') for e in dropped]})")
        rec.check("nothing went to the unit for the run that was given up: no WorkflowStartRequest, "
                  "no WorkflowKillRequest", ed.net.sent_types(t_click) == [],
                  {"sent_after_run": ed.net.sent_types(t_click), "states_from_unit": ed.net.states(t_click)})
        rec.check("the run button is still Run", ed.run_button()["text"] == "Run", ed.run_button())
        if isinstance(created.get("eid"), int):
            entry = self.api.execution_entry(wid, created["eid"])
            rec.note(f"the execution the Dashboard created for the given-up run stays as it was created: "
                     f"{ {k: (entry or {}).get(k) for k in ('eId', 'status')} } (status 0; the frontend commit "
                     f"names this)")
        ed.screenshot("given-up")

        # the page still runs
        resp, body, t_click2 = self.press_run(ed, rec, what="Run after giving up")
        body = body if isinstance(body, dict) else {}
        if rec.check("Run pressed again: another execution is created (201)",
                     resp.status == 201 and body.get("eid") != created.get("eid"),
                     {"status": resp.status, "body": body, "given_up": created.get("eid")}):
            self.check_start(ed, rec, body, t_click2, what="again: ", resp=resp)
            self.wait_completed(ed, rec, ops, t_click2, self.a.timeout, what="again: ")
            self.persisted(rec, wid, body.get("eid"), STATUS_COMPLETED, what="again: ")
        starts = [m.get("executionId") for _, m in ed.net.sent() if m.get("type") == "WorkflowStartRequest"]
        rec.check("the only WorkflowStartRequest on this page is the second run's",
                  starts == [body.get("eid")], {"starts": starts})
        ed.screenshot("ran-again")
        self.no_old_requests(rec, ed)

    # ---- B9: a Python environment kept at the Dashboard

    def b9(self, rec: CaseRecord) -> None:
        """A Python environment as a user has one now that a unit keeps none of its own: made
        on the Dashboard's Environments page, picked in a UDF's property editor, installed by
        the unit when the run starts. What the unit holds is looked at as scenario g does."""
        unit = UnitChecks(self, rec)
        _precondition_no_tabulate(unit)  # scenario g's; raises when the unit's own python3 has tabulate
        # As in scenario g: an install is reused by its requirements, whatever the environment
        # is called, so one that a kept stack still holds is removed for this run to install.
        for d in _installs_of(unit.environment_dirs(), TABULATE_LINES):
            p = unit.unit_exec("rm", "-rf", d["path"])
            rec.note(f"removed an earlier install of {TABULATE_LINES} at {d['path']} (exit {p.returncode}) so "
                     f"that this run installs afresh")
        name = f"sce-browser-env-{uuid.uuid4().hex[:8]}"
        wf = self.workflow("B9 python-environment")
        src = wf.add("one-line", "TextInput", text_input(["sce-e2e"]), n_in=0)
        # saved as a new UDF is: in the engine's own environment. The page picks the other one.
        udf = wf.add("tabulate-version", "PythonUDFV2",
                     python_udf(UDF_TABULATE, out_columns=[("tabulate_version", "string")]))
        wf.link(src, udf)
        ops = [src, udf]
        wid = self.save(rec, wf)
        ed = self.editor(rec, wid)

        # (1) the Environments page: a new environment holding tabulate==0.9.0
        if not self._make_environment(ed, rec, name):
            return
        # (2) the editor: the UDF's property editor lists the environment, and it is picked there
        ed.open(ops)
        ed.wait_run_button("Run", timeout=90, enabled=True)
        if not self._pick_environment(ed, rec, udf, name):
            self.no_old_requests(rec, ed)
            return

        # (3) Run, with the console open: the UDF is selected, so the console is the UDF's
        ed.open_console()
        shows = wf.op(udf).title
        resp, body, t_click = self.press_run(ed, rec)
        body = body if isinstance(body, dict) else {}
        if not rec.check("Run: POST /api/executions answers 201", resp.status == 201,
                         {"status": resp.status, "body": body}):
            ed.screenshot("create-failed")
            self.no_old_requests(rec, ed)
            return
        sent_ops = ((json.loads(resp.request.post_data or "{}") or {}).get("logicalPlan") or {}).get("operators") or []
        sent_udf = next((o for o in sent_ops if o.get("operatorID") == udf), {})
        rec.check("the create carries the UDF in the environment picked (defaultEnv false, envName)",
                  sent_udf.get("defaultEnv") is False and sent_udf.get("envName") == name,
                  {"defaultEnv": sent_udf.get("defaultEnv"), "envName": sent_udf.get("envName"), "picked": name})
        self.check_start(ed, rec, body, t_click, resp=resp)

        installing = f"Installing Python environment '{name}' (1 package)"
        ready = re.compile(rf"Python environment '{re.escape(name)}' is ready \(\d+(?:\.\d+)? s\)")

        def said_in_order(titles: list[str]) -> bool:
            i_ready = next((i for i, t in enumerate(titles) if ready.fullmatch(t)), None)
            return installing in titles and i_ready is not None and titles.index(installing) < i_ready

        try:  # a picture of the console while the unit installs; the timeline below has it either way
            ed.wait_until(lambda: installing in [r["title"] for r in ed.read_console()["rows"]]
                          or bool({"Running", "Completed", "Failed"} & set(ed.net.states(t_click))),
                          120, "the console to say that the environment is being installed")
            ed.screenshot("installing")
        except UiTimeout:
            pass
        completed = self.wait_completed(ed, rec, ops, t_click, self.a.timeout)

        # what the UDF's console showed before the run was Running: the install, as it went
        timeline = [e for e in ed.console_timeline() if e["t"] >= t_click - ed.t0]
        starting = [[r["title"] for r in e["rows"]] for e in timeline
                    if e["button"] == "Submitting" and e["showing"] == shows]
        rec.check("while the run was starting (run button Submitting) the UDF's console said that the "
                  "environment is being installed, then that it is ready (Installing Python environment "
                  "'<name>' (1 package); Python environment '<name>' is ready (N s))",
                  any(installing in said for said in starting) and any(said_in_order(said) for said in starting),
                  _timeline_brief(timeline))
        emptied = [e["t"] for e in timeline if e["button"] in ("Pause", "Pausing") and not e["rows"]]
        if emptied and any(said_in_order(said) for said in starting):
            back = next((e["t"] for e in timeline if e["t"] > emptied[0] and e["rows"]), None)
            rec.note(f"while the run was Running the UDF's console showed no message: the two it showed while "
                     f"the run was starting were gone {emptied[0] - (t_click - ed.t0):.1f} s after Run, and "
                     + (f"were shown again {back - emptied[0]:.1f} s later, when the run ended"
                        if back is not None else "did not come back while the console was watched")
                     + " (the console's own rule: a run that goes from Initializing to Running empties it "
                       "until the next message or state)")

        # and after the run: both are in the UDF's console, and the ready one says what it holds
        console = ed.read_console()
        titles = [r["title"] for r in console["rows"]]
        holds: list[str] = []
        try:
            if said_in_order(titles):
                holds = _held_packages(ed.open_console_message(next(t for t in titles if ready.fullmatch(t)))["detail"])
        except (UiTimeout, PlaywrightError) as e:
            rec.note(f"the console's ready message could not be opened: {e}")
        ed.screenshot("console-after-run")
        rec.check("with the run ended the UDF's console shows both messages, in that order, and the ready one, "
                  f"opened, lists what the environment holds: {TABULATE_LINES}",
                  console["showing"] == shows and said_in_order(titles) and holds == TABULATE_LINES,
                  {**_console_brief(ed.read_console()), "the_ready_message_lists": holds})

        if completed:
            self.check_rows(ed, rec, udf, [{"line": "sce-e2e", "tabulate_version": "0.9.0"}], key="line",
                            columns=["line", "tabulate_version"], whose="the UDF's")
        ed.screenshot("completed")
        self.persisted(rec, wid, body.get("eid"), STATUS_COMPLETED)

        # (4) the unit keeps no environment of its own: its menu has no action for one
        try:
            menu = self._unit_menu(ed)
        except (UiTimeout, PlaywrightError) as e:
            rec.check("the computing-unit menu offers no environment action", False, str(e))
            ed.screenshot("unit-menu-not-read")
        else:
            actions = [a for u in menu["units"] for a in u["actions"]]
            said = " | ".join([menu["text"], *(t for a in actions for t in a["tooltips"])]).lower()
            rec.check("the computing-unit menu offers no environment action: no unit's row has a '+' (it was "
                      "'Python Environment'), and nothing in the menu names an environment",
                      any(u["unit"] == self.a.unit_name and u["actions"] for u in menu["units"])
                      and all(a["icon"] != "plus" for a in actions) and "environment" not in said, menu)
        self.no_old_requests(rec, ed)

    def _make_environment(self, ed: Editor, rec: CaseRecord, name: str) -> bool:
        """On the Dashboard's Environments page (the sidebar's Environments): Create
        Environment, the name, one package row (tabulate, ==, 0.9.0), Save."""
        page = ed.page
        packages = {"tabulate": "==0.9.0"}
        operator = None
        try:
            ed.goto("/user/workflow", 'li[nz-menu-item]:has-text("Environments")')
            log("    the sidebar's Environments, then Create Environment")
            page.locator("li[nz-menu-item]", has_text=re.compile(r"^\s*Environments\s*$")).first.click()
            page.wait_for_selector("texera-user-venv", timeout=30000)
            page.locator("texera-user-venv button.create-btn").click()
            form = page.locator(".ant-modal.pve-modal")
            form.locator('input[placeholder="Environment Name"]').fill(name)
            form.locator(".add-btn button").click()  # a row for one more package
            form.locator('input[placeholder="Package Name"]').fill("tabulate")
            form.locator('input[placeholder="Package Version"]').fill("0.9.0")
            operator = form.locator(".operator-select .ant-select-selection-item").first.inner_text().strip()
            ed.screenshot("environment-form")
            with page.expect_response(
                    lambda r: r.request.method == "POST"
                    and urllib.parse.urlsplit(r.url).path == ENVIRONMENTS_PATH, timeout=60000) as info:
                form.locator(".ant-modal-footer button", has_text=re.compile(r"^\s*Save\s*$")).click()
            resp = info.value
        except (UiTimeout, PlaywrightError) as e:
            rec.check("an environment is made on the Environments page (Create Environment, its name, a "
                      "package, Save)", False, f"{e} -- at {page.url}; toasts {ed.toasts()[-3:]}")
            ed.screenshot("environment-not-made")
            ed.dump_html("environment-not-made")
            return False
        try:
            row = resp.json()
        except Exception:  # noqa: BLE001
            row = resp.text()
        try:
            sent = json.loads(resp.request.post_data or "null")
        except ValueError:
            sent = resp.request.post_data
        if not rec.check("the Environments page saves the environment: POST /api/environments answers 201 with "
                         "the row, {veid, name, packages: {tabulate: ==0.9.0}}",
                         resp.status == 201 and sent == {"name": name, "packages": packages}
                         and isinstance(row, dict) and isinstance(row.get("veid"), int)
                         and row.get("name") == name and row.get("packages") == packages,
                         {"status": resp.status, "sent": sent, "answer": row, "version_operator_shown": operator}):
            ed.screenshot("environment-not-saved")
            return False

        def listed() -> list[str]:
            return [t.strip() for t in page.locator("texera-user-venv .python-env-name").all_inner_texts()]

        def said_saved() -> bool:
            return any(f'Saved environment "{name}"' in t["text"] for t in ed.toasts())

        try:
            ed.wait_until(lambda: said_saved() and name in listed(), 15,
                          "the page to say that the environment is saved, and to list it")
        except UiTimeout:
            pass
        kept = [e for e in self.api.list_environments() if e.get("name") == name]
        ed.screenshot("environment-saved")
        return rec.check("the page says the environment is saved and lists it, and the Dashboard lists it for "
                         "the user (GET /api/environments)",
                         said_saved() and name in listed() and len(kept) == 1
                         and kept[0].get("packages") == packages,
                         {"toasts": ed.toasts()[-3:], "listed_on_the_page": listed(), "dashboard": kept})

    def _pick_environment(self, ed: Editor, rec: CaseRecord, udf: str, name: str) -> bool:
        """In the UDF's property editor: Default Python Environment unchecked, which brings up
        the Virtual Environment list; the environment picked in it."""
        page = ed.page
        picker = page.locator('#property-editor nz-select[id*="_enum_envName_"]')
        option = page.locator(".ant-select-dropdown .ant-select-item-option")
        options: list[str] = []
        from_dashboard: Any = None
        with_default: bool | None = None

        def picked() -> str:
            item = picker.locator(".ant-select-selection-item")
            return item.first.inner_text().strip() if item.count() else ""

        try:
            # The property editor of a Python UDF asks the Dashboard for the user's environments
            # and lays its form out again with them: the form is used once that has happened.
            with page.expect_response(
                    lambda r: r.request.method == "GET"
                    and urllib.parse.urlsplit(r.url).path == ENVIRONMENTS_PATH, timeout=30000) as info:
                ed.select_operator(udf)
            try:
                from_dashboard = [e.get("name") for e in info.value.json()]
            except Exception as e:  # noqa: BLE001
                from_dashboard = f"<unreadable: {type(e).__name__}>"
            default = page.locator('#property-editor label[nz-checkbox][id*="_boolean_defaultEnv_"]')
            default.first.wait_for(state="visible", timeout=20000)
            ed.wait_until(lambda: page.locator('#property-editor input[id*="_string_envName_"]').count() == 0,
                          10, "the property editor to lay its form out with the user's environments")
            page.wait_for_timeout(300)
            with_default = picker.count() > 0 and picker.first.is_visible()
            if "ant-checkbox-wrapper-checked" in (default.first.get_attribute("class") or ""):
                log("    uncheck Default Python Environment")
                default.first.click()
            picker.first.wait_for(state="visible", timeout=10000)
            picker.first.click()
            option.first.wait_for(state="visible", timeout=10000)
            options = [t.strip() for t in option.all_inner_texts()]
            if name not in options:
                # a long list is drawn in part: the picker's own search narrows it
                page.keyboard.type(name)
                ed.wait_until(lambda: name in [t.strip() for t in option.all_inner_texts()], 10,
                              "the picker's search to bring up the environment")
                options += [t.strip() for t in option.all_inner_texts()]
            ed.screenshot("environment-picker")
            option.filter(has_text=re.compile(rf"^\s*{re.escape(name)}\s*$")).first.click()
            ed.wait_until(lambda: picked() == name, 10, "the picker to show the environment")
            ed.wait_run_button("Run", timeout=40, enabled=True)
        except (UiTimeout, PlaywrightError) as e:
            rec.check("the environment is picked in the UDF's property editor", False,
                      f"{e} -- the picker listed {options}; it shows {picked()!r}; run button {ed.run_button()}")
            ed.screenshot("environment-not-picked")
            ed.dump_html("environment-not-picked")
            return False
        ed.screenshot("environment-picked")
        return rec.check("the UDF's property editor lists the environment (Default Python Environment unchecked, "
                         "the Virtual Environment list), and it is picked there",
                         name in options and picked() == name,
                         {"listed": options, "picked": picked(), "the_dashboard_answered": from_dashboard,
                          "list_shown_while_the_default_environment_was_checked": with_default,
                          "run_button": ed.run_button()})

    def _unit_menu(self, ed: Editor) -> dict:
        """Open the editor's computing-unit menu and read it: each unit's row with the actions
        it offers (each icon, with what a pointer on it brings up), the menu's other items and
        its whole text. The menu is closed again."""
        page = ed.page
        log("    open the computing-unit menu")
        page.locator("button.computing-units-dropdown-button").click()
        menu = page.locator("ul.computing-units-dropdown")
        menu.first.wait_for(state="visible", timeout=10000)
        units = []
        rows = menu.locator("li.computing-unit-option")
        for i in range(rows.count()):
            row = rows.nth(i)
            icons = row.locator(".computing-unit-row > i[nz-icon]")
            actions = []
            for j in range(icons.count()):
                icons.nth(j).hover()
                page.wait_for_timeout(600)
                tooltips = page.evaluate("""() => Array.from(document.querySelectorAll('.ant-tooltip'))
                    .filter(t => t.offsetParent !== null && !t.classList.contains('ant-tooltip-hidden'))
                    .map(t => (t.textContent || '').trim())""")
                actions.append({"icon": icons.nth(j).get_attribute("nztype"), "tooltips": tooltips})
            units.append({"unit": row.locator(".computing-unit-name").first.inner_text().strip(),
                          "actions": actions})
        others = [" ".join(t.split()) for t in menu.locator(
            "li:not(.computing-unit-option):not(.ant-dropdown-menu-item-divider)").all_inner_texts()]
        text = " ".join(menu.first.inner_text().split())
        ed.screenshot("unit-menu")
        page.keyboard.press("Escape")
        try:
            menu.first.wait_for(state="hidden", timeout=3000)
        except PlaywrightError:
            page.locator("button.computing-units-dropdown-button").click()  # the button closes it too
        return {"units": units, "other_items": others, "text": text}

    # ---- running a case

    CASES: dict[str, tuple[str, str]] = {
        "B1": ("b1", "Run to completion; the result table of the last operator"),
        "B2": ("b2", "A compile error from the create; Run usable again; fixed in the UI"),
        "B3": ("b3", "Pause, resume and stop with the buttons (slow Python UDF)"),
        "B4": ("b4", "Change a paused operator in the UI (the UDF's code), resume"),
        "B5": ("b5", "Run again on the same page after a completed run"),
        "B6": ("b6", "Extra: Stop while the execution is being created; nothing reaches the unit"),
        "B7": ("b7", "Change a paused operator after the page was loaded again"),
        "B8": ("b8", "Change a paused operator, and resume, in a second tab"),
        "B9": ("b9", "A Python environment of the Dashboard, picked in the UDF"),
    }

    def run_case(self, key: str) -> CaseRecord:
        method, title = self.CASES[key]
        rec = CaseRecord(key, title)
        t0 = time.monotonic()
        self.editors = []
        try:
            getattr(self, method)(rec)
        except Exception as e:  # noqa: BLE001
            rec.error = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
            log(f"  [FAIL] {key} raised {type(e).__name__}: {str(e)[:600]}")
            for ed in self.editors:
                if not ed.page.is_closed():
                    ed.screenshot("failure")
                    ed.dump_html("failure")
        finally:
            for ed in self.editors:
                if not ed.page.is_closed():
                    self._leave_idle(ed, rec)
                    ed.close()
            for context in {ed.context for ed in self.editors}:
                try:
                    context.close()
                except PlaywrightError:
                    pass
        rec.duration_s = time.monotonic() - t0
        rec.outcome = "PASS" if rec.checks and all(c["ok"] for c in rec.checks) and not rec.error else "FAIL"
        return rec

    @staticmethod
    def _leave_idle(ed: Editor, rec: CaseRecord) -> None:
        """A run still alive when the case ends is stopped, so the next case finds the unit idle."""
        try:
            b = ed.run_button()
            if b.get("killDisabled") is False and b.get("text") in ("Pause", "Resume", "Pausing", "Resuming",
                                                                     "Submitting"):
                rec.note(f"the case ended with a run alive (run button {b['text']}); stopping it")
                ed.click_stop()
                ed.wait_run_button("Run", timeout=60)
        except (UiTimeout, PlaywrightError) as e:
            rec.note(f"could not stop the run left alive: {e}")


def _same_row(shown: dict, want: dict) -> bool:
    """A row of the table (cell texts) against the expected values."""
    if set(shown) != set(want):
        return False
    for k, v in want.items():
        s = shown[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            if s != str(v):
                return False
            continue
        try:
            if abs(float(s) - float(v)) > 1e-9 * max(1.0, abs(float(v))):
                return False
        except ValueError:
            return False
    return True


def _is_subsequence(needle: list[str], hay: list[str]) -> bool:
    it = iter(hay)
    return all(any(x == y for y in it) for x in needle)


def _console_brief(console: dict) -> dict:
    """The console as read (Editor.read_console), for a check's detail: each message with
    the tags it has, and what it holds cut short."""
    rows = []
    for r in console.get("rows", []):
        row = {k: r[k] for k in ("type", "title", "operator", "source", "worker", "time") if r.get(k)}
        if r.get("detail"):
            row["detail"] = r["detail"][:300]
            row["opened"] = r.get("opened")
        rows.append(row)
    return {"shown": console.get("shown"), "showing": console.get("showing"), "rows": rows}


def _timeline_brief(timeline: list[dict], last: int = 30) -> list[dict]:
    """A console timeline (Editor.console_timeline) with each entry's messages as their titles."""
    return [{"t": e["t"], "button": e["button"], "showing": e["showing"],
             "messages": [r["title"] for r in e["rows"]]} for e in timeline[-last:]]


def _held_packages(detail: str) -> list[str]:
    """The packages that the console's message of a ready environment lists: the lines under
    "It holds, beside the engine's packages:", up to the next empty line."""
    lines = [ln.strip() for ln in detail.splitlines()]
    try:
        start = lines.index("It holds, beside the engine's packages:") + 1
    except ValueError:
        return []
    end = next((i for i in range(start, len(lines)) if not lines[i]), len(lines))
    return lines[start:end]


# --------------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=os.environ.get("SCE_BASE", "http://localhost:8080"))
    ap.add_argument("--username", default=os.environ.get("SCE_USER", "texera"))
    ap.add_argument("--password", default=os.environ.get("SCE_PASSWORD", "texera"))
    ap.add_argument("--case", action="append", default=[],
                    help="case key, repeatable or comma-separated (default: all): "
                         + "; ".join(f"{k}={v[1]}" for k, v in Smoke.CASES.items()))
    ap.add_argument("--unit-uri", default=os.environ.get(
        "SCE_UNIT_URI", "http://workflow-runtime-coordinator-service:8085"))
    ap.add_argument("--unit-name", default="sce-e2e-unit")
    ap.add_argument("--warehouse-name", default="sce-e2e")
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("SCE_RUN_TIMEOUT", "300")),
                    help="seconds a run may take to reach Running or Completed (default %(default)s)")
    ap.add_argument("--ready-timeout", type=float, default=300)
    ap.add_argument("--out", type=Path, help="output directory (default reports/browser-smoke-<time>/)")
    ap.add_argument("--label", default="", help="free text stored in the report (e.g. the image tag)")
    ap.add_argument("--stack-manifest", type=Path, help="stack/generated/MANIFEST.json to embed in the report")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    ap.add_argument("--slow-mo", type=float, default=0, help="milliseconds between browser actions")
    ap.add_argument("--list", action="store_true", help="list the cases and exit")
    a = ap.parse_args()
    if a.list:
        for k, (_, title) in Smoke.CASES.items():
            print(f"{k:3} {title}")
        return 0
    keys: list[str] = []
    for item in a.case or [",".join(Smoke.CASES)]:
        for k in item.split(","):
            k = k.strip().upper()
            if k and k not in Smoke.CASES:
                raise SystemExit(f"unknown case {k}; known: {', '.join(Smoke.CASES)}")
            if k and k not in keys:
                keys.append(k)

    started = dt.datetime.now(dt.timezone.utc)
    run_id = started.strftime("%m%d-%H%M%S")
    out = a.out or REPORTS / f"browser-smoke-{started.strftime('%Y%m%dT%H%M%SZ')}"
    out.mkdir(parents=True, exist_ok=True)
    report_path = out / "report.json"
    manifest_path = a.stack_manifest or (STACK_GENERATED / "MANIFEST.json")
    report: dict = {
        "harness": "sce-e2e browser smoke", "harness_git": harness_git(), "label": a.label,
        "run_id": run_id, "started_at": started.isoformat(timespec="seconds"), "base": a.base,
        "cases_selected": keys, "setup": {}, "cases": [],
    }
    if manifest_path.exists():
        report["stack"] = json.loads(manifest_path.read_text())

    def write() -> None:
        tmp = report_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(report, indent=2, default=str) + "\n")
        tmp.replace(report_path)

    api = TexeraApi(a.base)
    records: list[CaseRecord] = []
    setup_ok = False
    try:
        log(f"waiting for {a.base}/api/healthcheck")
        api.wait_ready(a.ready_timeout)
        api.login(a.username, a.password)
        log(f"logged in as {a.username} (uid {api.uid})")
        files = {f: (DATA_DIR / f).read_bytes() for f in DATA_FILES}
        digest = hashlib.sha256(b"".join(f.encode() + b"\0" + files[f] for f in DATA_FILES)).hexdigest()[:10]
        ds = api.ensure_dataset(f"sce-e2e-{digest}", files, "sce-e2e harness data (people, depts, numbers)")
        log(f"dataset sce-e2e-{digest} (did {ds['did']}, {'reused' if ds['reused'] else 'uploaded'})")
        whid, wh_status = api.ensure_warehouse(a.warehouse_name)
        unit = api.ensure_local_unit(a.unit_name, a.unit_uri)
        cuid = int(unit["cuid"])
        log(f"warehouse {whid}; computing unit {cuid} -> {unit.get('uri')}")
        report["setup"] = {"user": {"uid": api.uid, "role": api.claims.get("role")},
                           "dataset": {"name": f"sce-e2e-{digest}", **ds},
                           "warehouse": {"enabled": bool(wh_status and wh_status.get("enabled")), "whid": whid},
                           "computing_unit": {"cuid": cuid, "uri": unit.get("uri"), "name": unit.get("name")}}
        transport = make_transport("create-ws", base=a.base, token_provider=lambda: api.token,
                                   uid_provider=lambda: api.uid, log=lambda m: log(f"    {m}"), api=api)
        setup_ok = True
    except Exception as e:  # noqa: BLE001
        report["setup"]["error"] = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
        log(f"SETUP FAILED: {type(e).__name__}: {e}")

    if setup_ok:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=not a.headed, slow_mo=a.slow_mo or None)
            report["browser"] = {"name": "chromium", "version": browser.version, "headless": not a.headed}
            containers = (report.get("stack") or {}).get("containers") or {}
            smoke = Smoke(a, api, browser, cuid=cuid, whid=whid, paths=ds["paths"], run_id=run_id, out=out,
                          transport=transport,
                          unit_container=containers.get("workflow-runtime-coordinator-service", UNIT_CONTAINER))
            for key in keys:
                log(f"=== case {key}: {Smoke.CASES[key][1]}")
                rec = smoke.run_case(key)
                records.append(rec)
                log(f"=== case {key}: {rec.outcome} ({rec.duration_s:.1f}s)")
                report["cases"] = [r.to_json() for r in records]
                write()
            browser.close()

    finished = dt.datetime.now(dt.timezone.utc)
    outcomes = [r.outcome for r in records]
    sent = Counter(t for r in records for pg in r.pages for s in pg["network"]["websockets"]
                   for t, n in (s.get("sent_types") or {}).items() for _ in range(n))
    report["finished_at"] = finished.isoformat(timespec="seconds")
    report["duration_s"] = round((finished - started).total_seconds(), 1)
    report["summary"] = {
        "setup_ok": setup_ok, "passed": outcomes.count("PASS"), "failed": outcomes.count("FAIL"),
        "selected": len(keys),
        "result": "PASS" if setup_ok and outcomes and all(o == "PASS" for o in outcomes)
                  and len(outcomes) == len(keys) else "FAIL",
        "frames_sent_by_type": dict(sent),
        "old_requests_sent": {t: sent.get(t, 0) for t in OLD_REQUESTS},
        "executions_requests": [
            f"{r.key}: {e['method']} {e['path']} -> "
            f"{e['status'] if e['status'] is not None else 'dropped by the page (' + str(e.get('failure')) + ')'}"
            for r in records for pg in r.pages
            for e in pg["network"]["executions_requests"] if e["method"] == "POST"],
        # what the pages wrote to the user's environments (their reads are in each page's network)
        "environments_requests": [
            f"{r.key}: {e['method']} {e['path']} -> {e['status']}"
            for r in records for pg in r.pages
            for e in pg["network"]["environments_requests"] if e["method"] != "GET"],
    }
    report["cases"] = [r.to_json() for r in records]
    write()

    print()
    print("=" * 78)
    hg = report.get("harness_git") or {}
    print(f" sce-e2e browser smoke  ({a.base}, run {run_id}, "
          f"harness {str(hg.get('head') or 'unknown')[:10]}{' +changes' if hg.get('dirty') else ''})")
    print("=" * 78)
    if not setup_ok:
        print(" SETUP FAILED -- no case ran; see setup.error in the report")
    for r in records:
        failed = [c["name"] for c in r.checks if not c["ok"]]
        extra = f"  failed: {'; '.join(failed)[:160]}" if failed else ""
        if r.error and not failed:
            extra = f"  error: {r.error.splitlines()[0][:140]}"
        print(f" {r.outcome:4}  {r.key:3} {r.title[:52]:52} {r.duration_s:6.1f}s  "
              f"{sum(c['ok'] for c in r.checks)}/{len(r.checks)} checks{extra}")
    print("-" * 78)
    print(f" frames the pages sent: {dict(sent)}")
    print(f" POST /api/executions*: {report['summary']['executions_requests']}")
    if report["summary"]["environments_requests"]:
        print(f" writes to /api/environments*: {report['summary']['environments_requests']}")
    print(f" overall: {report['summary']['result']}   report: {report_path}")
    print("=" * 78)
    if not setup_ok:
        return 2
    return 0 if report["summary"]["result"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
