"""Kubernetes computing units for the e2e driver (`--target k8s`).

A Kubernetes deployment has no standing unit: computing-unit-managing-service creates a
pod per unit on request, records its in-cluster URI, and the gateway (Envoy, ext-authz to
access-control-service) routes /wsapi to the pod recorded for the `cuid` of the
request. This module does what the frontend's "create computing unit" dialog and unit
selector do, over the same REST API, through the gateway:

  GET    /api/computing-unit/types    -> {typeOptions}  ("kubernetes" must be offered)
  GET    /api/computing-unit/limits   -> {cpuLimitOptions, memoryLimitOptions, gpuLimitOptions}
  POST   /api/computing-unit/create   {name, unitType:"kubernetes", cpuLimit, memoryLimit,
                                       gpuLimit, jvmMemorySize, shmSize, uri:""}
                                      -> {computingUnit{cuid, uri, ...}, status, ...}
  GET    /api/computing-unit/{cuid}   -> {status: Pending|Running|Failed|Unknown|Terminating,
                                          statusReason}
  DELETE /api/computing-unit/{cuid}/terminate

`setup` creates the unit, waits for Running, then for the unit to answer a websocket
handshake through the gateway (the pod is Running before its JVM listens), and returns it;
the scenarios then select it by cuid exactly like single-node runs select the local unit.
`teardown` terminates it at the end (an atexit hook does so too if the driver dies).
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import time
import urllib.parse
from pathlib import Path
from typing import Any, Callable

import websocket  # websocket-client

from workflow import Workflow

K8S_MANIFEST = Path(__file__).resolve().parent.parent / "stack" / "k8s" / "generated" / "MANIFEST.json"
SINGLE_NODE_BASE = "http://localhost:8080"  # e2e.py's --base default
UNIT_PREFIX = "sce-e2e-k8s"
TERMINAL_UNIT_STATES = {"Failed", "Unknown"}

_state: dict[str, Any] = {"cuid": None, "done": False}


def add_arguments(ap: argparse.ArgumentParser) -> None:
    g = ap.add_argument_group("Kubernetes mode")
    g.add_argument("--target", choices=["single-node", "k8s"],
                   default=os.environ.get("SCE_TARGET", "single-node"),
                   help="k8s: the stack of stack/k8s-stack.sh; --base defaults to its gateway "
                        "port-forward and the unit is a Kubernetes one (default %(default)s)")
    g.add_argument("--unit-kind", choices=["local", "kubernetes"], default=None,
                   help="local: a unit row pointing at --unit-uri (single-node); kubernetes: a pod "
                        "created through computing-unit-managing-service (default: kubernetes with "
                        "--target k8s, else local)")
    g.add_argument("--k8s-unit-cpu", help="cpuLimit (default: the first of /api/computing-unit/limits)")
    g.add_argument("--k8s-unit-memory", help="memoryLimit (default: the first offered)")
    g.add_argument("--k8s-unit-gpu", help="gpuLimit (default: 0 when offered)")
    g.add_argument("--k8s-unit-jvm", default="1G", help="jvmMemorySize (default %(default)s, the frontend's)")
    g.add_argument("--k8s-unit-shm", default="64Mi", help="shmSize (default %(default)s, the frontend's)")
    g.add_argument("--k8s-unit-timeout", type=float, default=600,
                   help="seconds for the unit to reach Running and answer through the gateway")
    g.add_argument("--keep-unit", action="store_true", help="leave the Kubernetes unit running at the end")


def resolve_args(a: argparse.Namespace) -> None:
    if a.unit_kind is None:
        a.unit_kind = "kubernetes" if a.target == "k8s" else "local"
    if a.target == "k8s" and a.base == SINGLE_NODE_BASE and not os.environ.get("SCE_BASE"):
        manifest = json.loads(K8S_MANIFEST.read_text()) if K8S_MANIFEST.exists() else {}
        a.base = manifest.get("gateway_url") or "http://127.0.0.1:30080"


def wanted(a: argparse.Namespace) -> bool:
    return a.unit_kind == "kubernetes"


# ------------------------------------------------------------------ REST calls


def unit_info(api, cuid: int) -> dict:
    return api.get_json(f"/api/computing-unit/{cuid}")


def terminate(api, cuid: int, timeout: float = 60) -> dict:
    t0 = time.monotonic()
    r = api.request("DELETE", f"/api/computing-unit/{cuid}/terminate", expect=None)
    gone = False
    while time.monotonic() - t0 < timeout:
        live = [u for u in api.list_units()
                if int((u.get("computingUnit") or {}).get("cuid", -1)) == cuid]
        if not live:
            gone = True
            break
        time.sleep(2)
    return {"http_status": r.status_code, "body": r.text[:300], "gone_from_list": gone,
            "seconds": round(time.monotonic() - t0, 1)}


def terminate_stale(api, log: Callable[[str], None]) -> list[int]:
    """Units of earlier runs that were kept or died before their teardown."""
    stale = []
    for u in api.list_units():
        cu = u.get("computingUnit") or {}
        if (str(cu.get("type", "")).lower() == "kubernetes" and str(cu.get("name", "")).startswith(UNIT_PREFIX)
                and not cu.get("terminateTime")):
            cuid = int(cu["cuid"])
            log(f"terminating stale unit {cuid} '{cu.get('name')}'")
            terminate(api, cuid)
            stale.append(cuid)
    return stale


def wait_running(api, cuid: int, timeout: float, log: Callable[[str], None]) -> tuple[dict, list]:
    t0 = time.monotonic()
    history: list[dict] = []
    last = None
    info: dict = {}
    while time.monotonic() - t0 < timeout:
        info = unit_info(api, cuid)
        status, reason = info.get("status"), info.get("statusReason")
        if status != last:
            history.append({"t": round(time.monotonic() - t0, 1), "status": status, "reason": reason})
            log(f"  unit {cuid} status {status}" + (f" ({reason})" if reason else ""))
            last = status
        if status == "Running":
            return info, history
        if status in TERMINAL_UNIT_STATES:
            raise RuntimeError(f"unit {cuid} is {status}: {reason}")
        time.sleep(2)
    raise TimeoutError(f"unit {cuid} not Running after {timeout:.0f}s (last status {last}: "
                       f"{info.get('statusReason')})")


def wait_reachable(base: str, token: str, uid: int, cuid: int, wid: int, timeout: float,
                   log: Callable[[str], None]) -> dict:
    """Open the workflow websocket through the gateway until the unit answers its handshake
    with a WorkflowStateEvent: Envoy -> ext-authz (access-control-service) -> the pod."""
    parts = urllib.parse.urlsplit(base)
    scheme = "wss" if parts.scheme == "https" else "ws"
    query = urllib.parse.urlencode({"wid": wid, "uid": uid, "cuid": cuid, "access-token": token})
    url = urllib.parse.urlunsplit((scheme, parts.netloc, parts.path.rstrip("/") + "/wsapi/workflow-websocket",
                                   query, ""))
    t0 = time.monotonic()
    attempts, last_err, last_log = 0, "", 0.0
    errors: dict[str, int] = {}
    while time.monotonic() - t0 < timeout:
        attempts += 1
        try:
            ws = websocket.create_connection(url, timeout=10)
            try:
                until = time.monotonic() + 15
                while time.monotonic() < until:
                    msg = json.loads(ws.recv())
                    if msg.get("type") == "WorkflowStateEvent":
                        return {"attempts": attempts, "seconds": round(time.monotonic() - t0, 1),
                                "first_state": msg.get("state"), "errors_before": errors}
            finally:
                ws.close()
            last_err = "no WorkflowStateEvent within 15 s of the handshake"
        except Exception as e:  # noqa: BLE001 -- 502/503 while the pod starts, 403 if not routable
            last_err = f"{type(e).__name__}: {e}"
        key = last_err.split(":")[0] + (": " + last_err.split(":")[1][:60] if ":" in last_err else "")
        errors[key] = errors.get(key, 0) + 1
        if time.monotonic() - last_log > 15:
            log(f"  waiting for unit {cuid} to answer through the gateway ({attempts} attempts; "
                f"last: {last_err[:200]})")
            last_log = time.monotonic()
        time.sleep(2)
    raise TimeoutError(f"unit {cuid} did not answer a websocket handshake through the gateway within "
                       f"{timeout:.0f}s ({attempts} attempts; last: {last_err[:300]})")


# ----------------------------------------------------------------- lifecycle


def _pick(options: list[str], wanted_value: str | None, prefer: str | None = None) -> str:
    if wanted_value:
        return wanted_value
    if prefer is not None and prefer in options:
        return prefer
    if not options:
        raise RuntimeError("the deployment offers no limit options for Kubernetes units")
    return options[0]


def setup(api, a: argparse.Namespace, *, run_id: str, log: Callable[[str], None], report: dict) -> dict:
    report["target"] = a.target
    rec = report["setup"].setdefault("kubernetes_unit", {})
    types = (api.get_json("/api/computing-unit/types") or {}).get("typeOptions") or []
    rec["types_offered"] = types
    if "kubernetes" not in types:
        raise RuntimeError(f"the deployment does not offer Kubernetes units (types {types})")
    limits = api.get_json("/api/computing-unit/limits") or {}
    rec["limit_options"] = limits
    params = {
        "name": f"{UNIT_PREFIX}-{run_id}",
        "unitType": "kubernetes",
        "cpuLimit": _pick(limits.get("cpuLimitOptions") or [], a.k8s_unit_cpu),
        "memoryLimit": _pick(limits.get("memoryLimitOptions") or [], a.k8s_unit_memory),
        "gpuLimit": _pick(limits.get("gpuLimitOptions") or [], a.k8s_unit_gpu, prefer="0"),
        "jvmMemorySize": a.k8s_unit_jvm,
        "shmSize": a.k8s_unit_shm,
        "uri": "",
    }
    rec["stale_terminated"] = terminate_stale(api, log)
    rec["request"] = params

    t0 = time.monotonic()
    created = api.post_json("/api/computing-unit/create", params)
    cu = created["computingUnit"]
    cuid = int(cu["cuid"])
    _state.update(cuid=cuid, done=False, api=api, keep=a.keep_unit)
    atexit.register(_terminate_at_exit)
    rec.update({"cuid": cuid, "uri": cu.get("uri"), "status_at_create": created.get("status")})
    log(f"created Kubernetes unit {cuid} '{params['name']}' (cpu {params['cpuLimit']}, memory "
        f"{params['memoryLimit']}, gpu {params['gpuLimit']}, JVM {params['jvmMemorySize']}, shm "
        f"{params['shmSize']}) -> {cu.get('uri')}")
    try:
        info, history = wait_running(api, cuid, a.k8s_unit_timeout, log)
        rec["status_history"] = history
        rec["running_after_s"] = round(time.monotonic() - t0, 1)
        rec["resource"] = (info.get("computingUnit") or {}).get("resource")
        log(f"unit {cuid} Running after {rec['running_after_s']}s; checking it answers through the gateway")
        probe_wf = Workflow(f"sce-e2e {run_id} k8s-unit-probe")
        wid = api.create_workflow(probe_wf.name, probe_wf.ui_content())
        left = max(30.0, a.k8s_unit_timeout - (time.monotonic() - t0))
        rec["gateway_probe"] = dict(wait_reachable(a.base, api.token, api.uid, cuid, wid, left, log),
                                    wid=wid)
        rec["ready_after_s"] = round(time.monotonic() - t0, 1)
        log(f"unit {cuid} answers through the gateway ({rec['gateway_probe']['attempts']} attempt(s), "
            f"ready {rec['ready_after_s']}s after create)")
    except Exception:
        if not a.keep_unit:
            rec["termination"] = terminate(api, cuid)
            _state["done"] = True
        raise
    return dict(cu, type="kubernetes")


def teardown(api, a: argparse.Namespace, *, log: Callable[[str], None], report: dict) -> None:
    cuid = _state.get("cuid")
    if cuid is None or _state.get("done"):
        return
    rec = report["setup"].setdefault("kubernetes_unit", {})
    _state["done"] = True
    if a.keep_unit:
        rec["kept"] = True
        log(f"--keep-unit: unit {cuid} left running")
        return
    try:
        rec["termination"] = terminate(api, cuid)
        log(f"terminated Kubernetes unit {cuid} (HTTP {rec['termination']['http_status']}, gone from the "
            f"unit list: {rec['termination']['gone_from_list']})")
    except Exception as e:  # noqa: BLE001
        rec["termination"] = {"error": f"{type(e).__name__}: {e}"}
        log(f"terminating unit {cuid} failed: {e}")


def _terminate_at_exit() -> None:
    if _state.get("cuid") is None or _state.get("done") or _state.get("keep"):
        return
    _state["done"] = True
    try:
        terminate(_state["api"], _state["cuid"], timeout=10)
    except Exception:  # noqa: BLE001 -- best effort on the way out
        pass
