#!/usr/bin/env python3
"""Browser smoke: the real workflow editor, in headless Chromium, against a running stack.

The API scenarios (e2e.py) speak the protocol themselves. This drives the page the
user sees: it opens a workflow in the editor, presses Run, Pause, Resume and Stop,
changes a paused operator in the property editor, and reads the result table. What
the page sent is recorded beside what it showed: every request to /api/executions*
with its status, and every frame the page sent on the workflow websocket.

Setup is the driver's (texera_api.py, workflow.py): log in, the CSV dataset, the
warehouse, the local computing unit, one workflow per case stored in UI format.
The page is signed in by putting the token where the frontend keeps it
(localStorage `access_token`, AuthService.TOKEN_KEY), and the unit is the one the
frontend remembers for the workflow (localStorage `computing-unit-of-workflow-<wid>`,
ComputingUnitSelectionComponent).

Cases
  B1  Run to completion: CSV scan -> Filter -> Aggregate; the rows in the result table.
  B2  A compile error from the create (a Projection of a missing column): the page shows
      the operator's error, nothing is sent on the websocket, Run works again; then the
      operator is fixed in the property editor and the run completes.
  B3  Pause, resume, stop with the buttons on a slow Python UDF.
  B4  Change a paused operator: the UDF's code, in the code editor; resume; the rows.
  B5  Run again on the same page after a completed run: a second create and start, and
      the result table shows the second run's rows.
  B6  (extra) Stop pressed while the execution is still being created: the run is given
      up in the browser, nothing goes to the unit, and Run works again.

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
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from e2e import DATA_DIR, DATA_FILES, REPORTS, STACK_GENERATED, harness_git  # noqa: E402
from texera_api import TexeraApi  # noqa: E402
from transport import make_transport  # noqa: E402
from workflow import Workflow, aggregate, csv_scan, filter_op, projection, python_udf  # noqa: E402

from playwright.sync_api import Error as PlaywrightError  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

STATUS_COMPLETED, STATUS_FAILED, STATUS_KILLED = 3, 4, 5
OLD_REQUESTS = ("WorkflowExecuteRequest", "ModifyLogicRequest")
WS_PATH = "/wsapi/workflow-websocket"
MISSING_COLUMN = "sce_no_such_column"

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
        detail = detail if isinstance(detail, str) else json.dumps(detail, default=str)
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
    """The network evidence of one page: requests to /api/executions* with their
    status, and the frames of every websocket the page opened. Handlers only store;
    bodies are read later, from the main flow."""

    def __init__(self, page, token: str):
        self.token = token
        self._responses: list[tuple[float, Any]] = []
        self._failed: list[tuple[float, Any]] = []
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
    def _is_executions(url: str) -> bool:
        return urllib.parse.urlsplit(url).path.startswith("/api/executions")

    def _on_response(self, resp) -> None:
        if self._is_executions(resp.url):
            self._responses.append((self._now(), resp))
        if resp.status >= 400:
            path = urllib.parse.urlsplit(resp.url).path
            self.http_errors[f"{resp.request.method} {path} -> {resp.status}"] += 1

    def _on_failed(self, req) -> None:
        if self._is_executions(req.url):
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

    def executions_requests(self) -> list[dict]:
        """Every request to /api/executions*: method, path, status and a short view of
        the bodies (read now; a body the browser no longer holds is noted)."""
        out = []
        for t, resp in self._responses:
            req = resp.request
            entry: dict[str, Any] = {"t": t, "method": req.method,
                                     "path": urllib.parse.urlsplit(resp.url).path, "status": resp.status}
            if req.method == "POST":
                try:
                    entry["request"] = self._brief_request(json.loads(req.post_data or "null"))
                except (ValueError, PlaywrightError) as e:
                    entry["request"] = f"<unreadable: {e}>"
                try:
                    entry["response"] = self._brief_response(resp.json())
                except Exception as e:  # noqa: BLE001 -- no body, or not JSON
                    try:
                        entry["response"] = self.redact(resp.text()[:600])
                    except Exception:  # noqa: BLE001
                        entry["response"] = f"<unreadable: {type(e).__name__}>"
            out.append(entry)
        for t, req in self._failed:
            out.append({"t": t, "method": req.method, "path": urllib.parse.urlsplit(req.url).path,
                        "status": None, "failure": req.failure})
        return sorted(out, key=lambda e: e["t"])

    @staticmethod
    def _brief_request(body: Any) -> Any:
        if not isinstance(body, dict):
            return body
        if "logicalPlan" in body:
            plan = body.get("logicalPlan") or {}
            return {**{k: v for k, v in body.items() if k not in ("logicalPlan", "workflowSettings")},
                    "logicalPlan": {"operators": [o.get("operatorID") for o in plan.get("operators") or []],
                                    "links": len(plan.get("links") or []),
                                    "opsToViewResult": plan.get("opsToViewResult")},
                    "keys": sorted(body)}
        if "operator" in body:
            op = body["operator"] or {}
            brief = {k: v for k, v in op.items() if k != "code"}
            if "code" in op:
                brief["code_tail"] = str(op["code"])[-60:]
                brief["code_sha256"] = hashlib.sha256(str(op["code"]).encode()).hexdigest()[:16]
            return {"operator": brief}
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
                # every frame the page sent, whole; heartbeats as a count
                entry["sent"] = [{"t": rel(t), **m} for t, m in sent if m.get("type") != "HeartBeatRequest"]
                entry["received_types"] = dict(Counter(m.get("type", "?") for _, m in received))
                entry["states"] = [{"t": rel(t), "state": m.get("state")} for t, m in received
                                   if m.get("type") == "WorkflowStateEvent"]
                entry["received_kept"] = [
                    {"t": rel(t), **self._kept(m)} for t, m in received
                    if m.get("type") in ("WorkflowErrorEvent", "ModifyLogicResponse", "ModifyLogicCompletedEvent")]
            sockets.append(entry)
        return {"executions_requests": [{**e, "t": rel(e["t"])} for e in self.executions_requests()],
                "websockets": sockets,
                "sockets_without_frames": dict(others),
                "http_answers_400_and_up": dict(self.http_errors)}


# ------------------------------------------------------------------------ the page

INIT_SCRIPT = r"""
(() => {
  if (window.__sce) return;
  const s = (window.__sce = { run: [], toasts: [] });
  const tick = () => {
    try {
      const b = document.querySelector('#run-button');
      if (b) {
        const text = (b.innerText || '').trim();
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
                 rec: CaseRecord, label: str = "", hold_compile: bool = False):
        self.base, self.wid, self.cuid, self.out, self.key, self.rec = base, wid, cuid, out, key, rec
        self.label = label or f"wid {wid}"
        self.t0 = time.time()
        self.context = browser.new_context(viewport={"width": 1680, "height": 1050})
        storage = {"access_token": token, f"computing-unit-of-workflow-{wid}": str(cuid),
                   "result-panel-height": "430"}
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
        url = f"{self.base}/user/workflow/{self.wid}"
        self.page.goto(url, wait_until="domcontentloaded")
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

    def run_timeline(self) -> list[dict]:
        log_ = self.page.evaluate("() => (window.__sce ? window.__sce.run : [])")
        return [{"t": round(e["t"] / 1000 - self.t0, 3), "text": e["text"], "disabled": e["disabled"],
                 "killDisabled": e["killDisabled"]} for e in log_]

    def toasts(self) -> list[dict]:
        log_ = self.page.evaluate("() => (window.__sce ? window.__sce.toasts : [])")
        return [{"t": round(e["t"] / 1000 - self.t0, 3), "text": e["text"]} for e in log_]

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

    def select_operator(self, op_id: str) -> None:
        """Click the operator on the canvas, so the property editor and the result
        panel show it."""
        # By coordinates: the operator's own boundary rect lies over its body, so an
        # element click on the body waits forever for "nothing else to receive the click".
        box = self.page.locator(f'[model-id="{op_id}"] rect.body').first.bounding_box()
        if not box:
            raise UiTimeout(f"operator {op_id} is not on the canvas")
        self.page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        self.page.wait_for_timeout(300)

    # ---- the result panel

    def open_result_panel(self) -> None:
        content = self.page.locator("#result-container #content")
        if content.count() == 0 or not content.first.is_visible():
            self.page.locator("#result-buttons .anticon-border").first.click()
            content.first.wait_for(state="visible", timeout=10000)

    def result_tabs(self) -> list[str]:
        return [t.strip() for t in self.page.locator("#result-container .ant-tabs-tab").all_inner_texts()]

    def open_result_tab(self, name: str, timeout: float = 20) -> None:
        self.open_result_panel()
        tab = self.page.locator("#result-container .ant-tabs-tab", has_text=re.compile(rf"^\s*{re.escape(name)}\s*$"))
        deadline = time.monotonic() + timeout
        while tab.count() == 0 and time.monotonic() < deadline:
            self.page.wait_for_timeout(200)
        if tab.count() == 0:
            raise UiTimeout(f"the result panel has no '{name}' tab; tabs {self.result_tabs()}; "
                            f"title {self.result_title()!r}")
        tab.first.click()
        self.page.wait_for_timeout(300)

    def result_title(self) -> str:
        loc = self.page.locator("#result-container #title")
        return loc.first.inner_text().strip() if loc.count() else ""

    def read_table(self) -> dict:
        """The result table as shown: header texts, the rows of the current page, and
        the pagination's page numbers."""
        return self.page.evaluate("""() => {
            const root = document.querySelector('#result-container');
            const tables = root ? Array.from(root.querySelectorAll('.result-table')) : [];
            const table = tables.find(t => t.offsetParent !== null) || null;
            if (!table) return {shown: false, columns: [], rows: [], pages: [], current: null};
            const txt = e => (e.textContent || '').trim();
            const columns = Array.from(table.querySelectorAll('thead tr:first-child th')).map(txt);
            const rows = Array.from(table.querySelectorAll('tbody tr.table-row-hover'))
                .map(tr => Array.from(tr.querySelectorAll('td')).map(td => {
                    const c = td.querySelector('.cell-content');
                    return txt(c || td);
                }));
            const pages = Array.from(table.querySelectorAll('.ant-pagination li.ant-pagination-item')).map(txt);
            const cur = table.querySelector('.ant-pagination li.ant-pagination-item-active');
            return {shown: true, columns, rows, pages, current: cur ? txt(cur) : null};
        }""")

    def wait_table(self, predicate: Callable[[dict], bool], timeout: float, what: str) -> dict:
        deadline = time.monotonic() + timeout
        table: dict = {}
        while time.monotonic() < deadline:
            table = self.read_table()
            if table.get("shown") and predicate(table):
                return table
            self.page.wait_for_timeout(200)
        raise UiTimeout(f"the result table did not show {what} within {timeout:.0f}s; it shows "
                        f"{json.dumps(table)[:800]}; tabs {self.result_tabs()}")

    def table_dicts(self, table: dict) -> list[dict]:
        return [dict(zip(table["columns"], row)) for row in table["rows"]]

    def _pager(self, css: str):
        """The visible pagination control `css` of the result table, or None."""
        loc = self.page.locator(f"#result-container .result-table .ant-pagination {css}")
        return next((loc.nth(i) for i in range(loc.count()) if loc.nth(i).is_visible()), None)

    def _turn_page(self, control, table: dict, what: str) -> dict:
        """Click a pagination control and wait for another page's rows: the page number
        turns at once, its rows come over the websocket a moment later."""
        before = (table["current"], table["rows"])
        control.click()
        return self.wait_table(lambda t: t["current"] != before[0] and t["rows"] != before[1]
                               and len(t["rows"]) > 0, 15, what)

    def read_all_pages(self, table: dict, max_pages: int = 80) -> list[dict]:
        """The rows of every page of the result table, first page to last. (A table that
        was on page 2 before a new run is still on page 2 after it.)"""
        if table["current"] not in (None, "1"):
            first = self._pager("li.ant-pagination-item")
            if first is not None:
                table = self._turn_page(first, table, "the first page")
        rows = self.table_dicts(table)
        for _ in range(max_pages):
            nxt = self._pager("li.ant-pagination-next")
            if nxt is None or "ant-pagination-disabled" in (nxt.get_attribute("class") or ""):
                break
            table = self._turn_page(nxt, table, "the next page")
            rows.extend(self.table_dicts(table))
        return rows

    def goto_last_page(self) -> str | None:
        items = self.page.locator("#result-container .result-table .ant-pagination li.ant-pagination-item")
        visible = [items.nth(i) for i in range(items.count()) if items.nth(i).is_visible()]
        if not visible:
            return None
        last = visible[-1]
        number = last.inner_text().strip()
        before = self.read_table()["rows"]
        last.click()
        # the page number turns at once; its rows come over the websocket a moment later
        self.wait_table(lambda t: t["current"] == number and t["rows"] != before and len(t["rows"]) > 0, 15,
                        f"the rows of page {number}")
        return number

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
            timeline, toasts, url = self.run_timeline(), self.toasts(), self.page.url
        except PlaywrightError as e:
            timeline, toasts, url = [], [], f"<page gone: {e}>"
        return {"label": self.label, "wid": self.wid, "url": url,
                "network": self.net.to_json(self.t0),
                "run_button_timeline": timeline, "toasts": toasts,
                "console": [{"first_at": round(e["t"] - self.t0, 3), "type": kind, "count": e["count"], "text": text}
                            for (kind, text), e in sorted(self.console.items(), key=lambda kv: kv[1]["t"])],
                "page_errors": sum(e["count"] for (kind, _), e in self.console.items() if kind == "pageerror"),
                "compile_requests_held": self.compile_seen or None}

    def close(self) -> None:
        self.rec.pages.append(self.evidence())
        try:
            self.context.close()
        except PlaywrightError:
            pass


# ---------------------------------------------------------------------- the cases


class Smoke:
    def __init__(self, a, api: TexeraApi, browser, *, cuid: int, whid: int | None, paths: dict[str, str],
                 run_id: str, out: Path, transport):
        self.a, self.api, self.browser = a, api, browser
        self.cuid, self.whid, self.paths, self.run_id, self.out = cuid, whid, paths, run_id, out
        self.transport = transport
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

    def editor(self, rec: CaseRecord, wid: int, *, label: str = "", hold_compile: bool = False) -> Editor:
        ed = Editor(self.browser, base=self.a.base, token=self.api.token, cuid=self.cuid, wid=wid,
                    out=self.out, key=rec.key, rec=rec, label=label, hold_compile=hold_compile)
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
        log(f"    {what}: POST /api/executions -> {resp.status} {json.dumps(body, default=str)[:300]}")
        if isinstance(body, dict) and isinstance(body.get("eid"), int):
            rec.eids.append(body["eid"])
        return resp, body, t_click

    def check_start(self, ed: Editor, rec: CaseRecord, body: dict, since: float, what: str = "",
                    resp: Any = None) -> bool:
        """After a 201: the page sent WorkflowStartRequest with the create's eid and planUri."""
        want = {"type": "WorkflowStartRequest", "executionId": body.get("eid"), "planUri": body.get("planUri")}
        try:
            ed.wait_until(lambda: any(m.get("type") == "WorkflowStartRequest" for _, m in ed.net.sent(since)),
                          20, "the page to send WorkflowStartRequest")
        except UiTimeout:
            pass
        starts = [(t, m) for t, m in ed.net.sent(since) if m.get("type") == "WorkflowStartRequest"]
        answered = ed.net.answered_at(resp) if resp is not None else None
        after = bool(starts) and answered is not None and starts[0][0] > answered
        return rec.check(f"{what}the page sent WorkflowStartRequest{{executionId, planUri}} of the create's answer, "
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

    def no_old_requests(self, rec: CaseRecord, ed: Editor) -> None:
        types = ed.net.sent_types()
        old = [t for t in types if t in OLD_REQUESTS]
        rec.check("the page never sent WorkflowExecuteRequest or ModifyLogicRequest", not old,
                  {"sent_types": dict(Counter(types))})
        uncaught = [text for (kind, text) in ed.console if kind == "pageerror"]
        rec.check("no uncaught error in the page", not uncaught, uncaught[:3])

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
        if not rec.check("Run: POST /api/executions answers 201 with {eid, planUri}",
                         resp.status == 201 and isinstance(body, dict) and isinstance(body.get("eid"), int)
                         and bool(body.get("planUri")), {"status": resp.status, "body": body}):
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
                   columns: list[str], what: str = "") -> None:
        """Open the operator's result table and compare what it shows with `expected`."""
        try:
            ed.select_operator(op)
            ed.open_result_tab("Result")
            table = ed.wait_table(lambda t: len(t["rows"]) >= min(len(expected), 1) and t["columns"] == columns,
                                  30, f"columns {columns} with rows")
        except (UiTimeout, PlaywrightError) as e:
            rec.check(f"{what}the result table of the last operator is shown", False, str(e))
            return
        rec.check(f"{what}the result table of the last operator is shown, with its columns",
                  table["columns"] == columns, {"columns": table["columns"], "title": ed.result_title()})
        try:
            shown = sorted(ed.read_all_pages(table), key=lambda r: r.get(key, ""))
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

        # the page shows the operator's error
        try:
            ed.select_operator(prj)
            ed.open_result_tab("Static Error")
            ed.wait_until(lambda: MISSING_COLUMN in self._error_frame_text(ed), 15,
                          "the error frame to name the column")
        except (UiTimeout, PlaywrightError) as e:
            rec.check("the result panel shows the Projection's error", False, str(e))
        else:
            text = self._error_frame_text(ed)
            rec.check("the result panel shows the Projection's error (Static Error tab, naming the column)",
                      MISSING_COLUMN in text, {"title": ed.result_title(), "text": text[:500]})
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
                self.check_rows(ed, rec, prj, expected, key="name", columns=["name"], what="after the fix ")
            self.persisted(rec, wid, body3.get("eid"), STATUS_COMPLETED, what="after the fix ")
        rec.check("exactly one WorkflowStartRequest went out on this page (the fixed run's)",
                  ed.net.sent_types().count("WorkflowStartRequest") == 1,
                  {"sent_types": dict(Counter(ed.net.sent_types()))})
        ed.screenshot("fixed-completed")
        self.no_old_requests(rec, ed)

    @staticmethod
    def _error_frame_text(ed: Editor) -> str:
        return ed.page.evaluate("""() => {
            const root = document.querySelector('#result-container');
            const f = root && root.querySelector('texera-error-frame');
            return f ? (f.textContent || '').replace(/\\s+/g, ' ').trim() : '';
        }""")

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

    # ---- B4

    def b4(self, rec: CaseRecord) -> None:
        total = len(self.data["numbers.csv"])
        wf = self.workflow("B4 change-paused-operator")
        scan = wf.add("numbers", "CSVFileScan", csv_scan(self.paths["numbers.csv"]), n_in=0)
        udf = wf.add("tagger", "PythonUDFV2", python_udf(UDF_TAG, out_columns=[("tag", "string")]))
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
        eid = body.get("eid")
        self.check_start(ed, rec, body, t_click, resp=resp)
        ed.wait_run_button("Pause", timeout=self.a.timeout, enabled=True)
        ed.page.wait_for_timeout(2500)
        t_pause = time.time()
        ed.click_run_button("Pause")
        ed.wait_run_button("Resume", timeout=120, enabled=True)
        rec.check("the run is Paused (run button Resume)", True, ed.operator_states([scan, udf]))

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
            with ed.page.expect_response(
                    lambda r: r.request.method == "POST"
                    and urllib.parse.urlsplit(r.url).path == f"/api/executions/{eid}/updates",
                    timeout=60000) as info:
                confirm.first.click()
            update_resp = info.value
        except (UiTimeout, PlaywrightError) as e:
            rec.check("the UDF's code is changed in the code editor and confirmed (Unlock for Logic Change, "
                      "Edit code content, Confirm Change)", False, f"{e} -- editor text: {self._editor_text(ed)[-200:]!r}")
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
        sent_op = (json.loads(update_resp.request.post_data or "{}") or {}).get("operator") or {}
        rec.check("Confirm Change: POST /api/executions/{eid}/updates answers 200 with {updateId, operatorId}",
                  update_resp.status == 200 and isinstance(update_body, dict)
                  and bool(update_body.get("updateId")) and update_body.get("operatorId") == udf,
                  {"status": update_resp.status, "body": update_body})
        rec.check("the update carries the operator as the editor holds it: the UDF with VERSION = 2",
                  sent_op.get("operatorID") == udf and str(sent_op.get("code", "")).rstrip().endswith("VERSION = 2"),
                  {"operatorID": sent_op.get("operatorID"), "operatorType": sent_op.get("operatorType"),
                   "code_tail": str(sent_op.get("code", ""))[-40:]})
        want = {"type": "OperatorUpdateRequest", "executionId": eid,
                "updateId": update_body.get("updateId") if isinstance(update_body, dict) else None}
        try:
            ed.wait_until(lambda: any(m.get("type") == "OperatorUpdateRequest" for _, m in ed.net.sent(t_edit)),
                          20, "the page to send OperatorUpdateRequest")
            ed.wait_until(lambda: bool(ed.net.events("ModifyLogicResponse", t_edit)), 30,
                          "the unit's ModifyLogicResponse")
        except UiTimeout:
            pass
        updates = [m for _, m in ed.net.sent(t_edit) if m.get("type") == "OperatorUpdateRequest"]
        rec.check("the page sent OperatorUpdateRequest{executionId, updateId} of the update's answer",
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

        # the rows, as the page shows them: the first page is v1, the last page v2
        try:
            ed.select_operator(udf)
            ed.open_result_tab("Result")
            first = ed.wait_table(lambda t: len(t["rows"]) > 0 and "tag" in t["columns"], 30, "rows with a tag column")
            first_rows = ed.table_dicts(first)
            ed.screenshot("result-first-page")
            last_no = ed.goto_last_page()
            last = ed.read_table()
            last_rows = ed.table_dicts(last)
            ed.screenshot("result-last-page")
        except (UiTimeout, PlaywrightError) as e:
            rec.check("the result table of the UDF shows v1 on its first page and v2 on its last", False, str(e))
        else:
            rec.check("the result table of the UDF shows v1 rows on its first page and v2 rows on its last",
                      bool(first_rows) and all(r.get("tag") == "v1" for r in first_rows)
                      and bool(last_rows) and all(r.get("tag") == "v2" for r in last_rows),
                      {"first_page": first_rows[:3], "last_page_number": last_no, "last_page": last_rows[-3:],
                       "pages": first.get("pages")})

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
                ed.select_operator(udf)
                ed.open_result_tab("Result")
                table = ed.wait_table(
                    lambda t: len(t["rows"]) > 0 and "stamp" in t["columns"]
                    and not ({r.get("stamp") for r in ed.table_dicts(t)} & set(stamps)),
                    30, "rows with this run's stamp")
            except (UiTimeout, PlaywrightError) as e:
                rec.check(f"{what}the result table shows this run's rows", False, str(e))
                ed.screenshot(f"run{n}-no-result")
                return
            try:
                rows = ed.read_all_pages(table)
            except (UiTimeout, PlaywrightError) as e:
                rec.check(f"{what}every page of the result table can be read", False, str(e))
                return
            seen = {r.get("stamp") for r in rows}
            names = sorted(r.get("name") for r in rows)
            rec.check(f"{what}the result table shows this run's rows (one stamp on all {len(people)} people)",
                      len(seen) == 1 and names == sorted(p["name"] for p in people),
                      {"stamps": sorted(seen), "names": names, "earlier_stamps": stamps})
            stamps.extend(sorted(seen))
            ed.screenshot(f"run{n}-completed")
            self.persisted(rec, wid, body.get("eid"), STATUS_COMPLETED, what=what)
        rec.check("the second run is another execution with another plan",
                  bodies[0].get("eid") != bodies[1].get("eid") and bodies[0].get("planUri") != bodies[1].get("planUri"),
                  {"first": bodies[0], "second": bodies[1]})
        rec.check("the second run's rows replaced the first's in the result table (a later stamp)",
                  len(stamps) == 2 and stamps[0].isdigit() and stamps[1].isdigit() and int(stamps[1]) > int(stamps[0]),
                  {"stamps": stamps})
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

    # ---- running a case

    CASES: dict[str, tuple[str, str]] = {
        "B1": ("b1", "Run to completion; the result table of the last operator"),
        "B2": ("b2", "A compile error from the create; Run usable again; fixed in the UI"),
        "B3": ("b3", "Pause, resume and stop with the buttons (slow Python UDF)"),
        "B4": ("b4", "Change a paused operator in the UI (the UDF's code), resume"),
        "B5": ("b5", "Run again on the same page after a completed run"),
        "B6": ("b6", "Extra: Stop while the execution is being created; nothing reaches the unit"),
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
            smoke = Smoke(a, api, browser, cuid=cuid, whid=whid, paths=ds["paths"], run_id=run_id, out=out,
                          transport=transport)
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
    print(f" overall: {report['summary']['result']}   report: {report_path}")
    print("=" * 78)
    if not setup_ok:
        return 2
    return 0 if report["summary"]["result"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
