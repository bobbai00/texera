"""Local-dev mode for the e2e driver (`--target localdev`).

bin/local-dev.sh serves the frontend with the Angular dev server on http://localhost:4200,
whose proxy (frontend/proxy.config.json) sends /api to each JVM service on its fixed port
and /wsapi to the computing unit on 8085. A developer's browser therefore talks only to
:4200, and so does the driver here: `--base` defaults to the dev server, so every REST call
and every workflow websocket goes through that proxy.

local-dev starts no unit row of its own. A developer gets one from the workspace's unit
selector: the create dialog offers the types of GET /api/computing-unit/types (only `local`
here: Kubernetes units are off), and "Connect to a Local Computing Unit" sends

  POST /api/computing-unit/create  {name, unitType: "local", cpuLimit: "NaN", memoryLimit: "NaN",
                                    gpuLimit: "NaN", jvmMemorySize: "NaN", shmSize: "NaN",
                                    uri: <page origin>/wsapi}

(computing-unit-create-modal: buildLocalComputingUnitUri(window.location)). The workflow
socket then opens at <page origin>/wsapi/workflow-websocket?...&cuid=<that unit>, which the
proxy forwards to the unit; the unit takes the user from the token in the query and the
cuid only as a key. `setup` does the same over the same API: it checks the dev server
serves the app, that `local` is offered, creates (or reuses) the unit with the dialog's
body and default URI, and opens a workflow socket through the proxy until the unit
answers. The scenarios then select that unit by cuid, as in single-node.

What reads or execs into the single-node stack's containers is refused up front (the
evidence, the gates and g0), and DOCKER_HOST points at a socket that does not exist, as in
Kubernetes mode, so nothing the driver runs here can reach another stack's containers.
What a scenario runs where the unit runs (the environment scenarios, the unit's own /run
endpoint) runs on this host (`exec_prefix`): the unit is a host process here. A step-3
scenario that takes the unit down does it through `LocalDevControl` (stack_control.py's
seam): stack/localdev-stack.sh signals the unit's JVM and starts it again as `up` did.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.parse
from pathlib import Path
from typing import Callable

import requests

import k8s_unit
from lake import DEFAULT_CATALOG_URI, DEFAULT_WAREHOUSE, Catalog, Lake, host_fetch
from stack_control import StackControl, run_stack_script
from workflow import Workflow

TARGET = "localdev"
STACK = Path(__file__).resolve().parent.parent / "stack" / "localdev-stack.sh"
MANIFEST = Path(__file__).resolve().parent.parent / "stack" / "localdev" / "generated" / "MANIFEST.json"
DEV_SERVER = "http://localhost:4200"
SINGLE_NODE_BASE = k8s_unit.SINGLE_NODE_BASE  # e2e.py's --base default
SINGLE_NODE_UNIT_URI = "http://workflow-runtime-coordinator-service:8085"  # e2e.py's --unit-uri default

#: scenarios that need the single-node unit container
UNIT_CONTAINER_SCENARIOS = {k: v for k, v in k8s_unit.SINGLE_NODE_SCENARIOS.items() if k == "g0"}


def wanted(a: argparse.Namespace) -> bool:
    return getattr(a, "target", None) == TARGET


def local_unit_uri(base: str) -> str:
    """The frontend's buildLocalComputingUnitUri(window.location) for a page served at `base`:
    `${protocol}//${hostname}${port ? ":" + port : ""}/wsapi`."""
    parts = urllib.parse.urlsplit(base)
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme}://{parts.hostname}{port}/wsapi"


def resolve_args(a: argparse.Namespace, portable_gates: frozenset = frozenset()) -> None:
    if not wanted(a):
        return
    if getattr(a, "unit_kind", None) == "kubernetes":
        raise SystemExit("--target localdev runs on local-dev's local computing unit; drop --unit-kind kubernetes")
    if a.base == SINGLE_NODE_BASE and not os.environ.get("SCE_BASE"):
        manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
        a.base = manifest.get("frontend_url") or DEV_SERVER
    if a.unit_uri == SINGLE_NODE_UNIT_URI and not os.environ.get("SCE_UNIT_URI"):
        a.unit_uri = local_unit_uri(a.base)
    used = k8s_unit.single_node_options_used(a, portable_gates)
    if used:
        raise SystemExit("local-dev mode does not support " + "; ".join(f"{f} ({w})" for f, w in used)
                         + ". Use the single-node stack (run-baseline.sh) for them.")
    if hasattr(a, "stack_manifest") and a.stack_manifest is None:
        a.stack_manifest = MANIFEST
    k8s_unit.guard_docker()


def lake() -> Lake:
    """The lake's catalog, asked from this host: the stack publishes Lakekeeper on a local
    port, and the services' own environment (in the manifest) names it."""
    env = json.loads(MANIFEST.read_text()).get("service_env") or {}
    uri = env.get("STORAGE_ICEBERG_CATALOG_REST_URI", DEFAULT_CATALOG_URI).rstrip("/")
    return Lake(Catalog(host_fetch(uri)), env.get("STORAGE_ICEBERG_CATALOG_REST_WAREHOUSE_NAME",
                                                  DEFAULT_WAREHOUSE), env)


def exec_prefix() -> Callable[[bool], list[str]]:
    """What runs a command where local-dev's unit runs: on this host, with the engine's
    Python first on PATH, so `python3` is the interpreter the unit starts its workers with,
    and with the unit's own setting of the environments root when the stack gave it one."""
    manifest = json.loads(MANIFEST.read_text())
    env = [f"PATH={Path(manifest['python']['executable']).parent}:/usr/bin:/bin"]
    root = (manifest.get("service_env") or {}).get("UDF_PYTHON_ENVIRONMENTS_ROOT")
    if root:
        env.append(f"UDF_PYTHON_ENVIRONMENTS_ROOT={root}")
    return lambda interactive: ["env", *env]


class LocalDevControl(StackControl):
    """local-dev: the unit is a JVM on this host, its Python workers in its process group.
    Every JVM of the stack reaches Postgres from 127.0.0.1, so the unit has no address of
    its own there; its connections are known by their application name."""

    def __init__(self, wait_reachable: Callable[[], dict]):
        #: waits until the unit answers a workflow socket through the dev server's proxy
        self._wait_reachable = wait_reachable

    def kill_unit(self) -> dict:
        return run_stack_script(STACK, "unit-kill")

    def stop_unit(self) -> dict:
        return run_stack_script(STACK, "unit-stop")

    def start_unit(self) -> dict:
        started = run_stack_script(STACK, "unit-start")
        return {**started, "answers_after": self._wait_reachable()}

    def pg_activity(self) -> list[dict]:
        return run_stack_script(STACK, "pg-activity")

    def unit_env_names(self) -> list[str]:
        """The names the stack recorded when it last started the unit's JVM."""
        return list(json.loads(MANIFEST.read_text()).get("unit_env_names") or [])


def control(api, a: argparse.Namespace, *, cuid: int, report: dict, log: Callable[[str], None]) -> LocalDevControl:
    """The stack's control for a run whose `setup` made unit `cuid` and probed its socket."""
    wid = report["setup"]["localdev"]["websocket_probe"]["wid"]
    return LocalDevControl(lambda: k8s_unit.wait_reachable(a.base, api.token, api.uid, cuid, wid,
                                                           max(30.0, a.timeout), log))


def check_selection(a: argparse.Namespace, keys: list[str], transport: str) -> None:
    """Refuse, before any setup, the scenarios that need the single-node unit container."""
    if not wanted(a):
        return
    bad = {k: why for k, why in UNIT_CONTAINER_SCENARIOS.items() if k in keys}
    if bad:
        raise SystemExit("local-dev mode cannot run " + "; ".join(f"{k} ({w})" for k, w in bad.items())
                         + ": the unit is a host process here. Run them on the single-node stack (run-baseline.sh).")


def dev_server_page(base: str, timeout: float = 30) -> dict:
    """What a browser gets at the base URL: the Angular dev server's index page."""
    r = requests.get(base.rstrip("/") + "/", timeout=timeout)
    title = re.search(r"<title>([^<]*)</title>", r.text)
    return {"status": r.status_code, "content_type": r.headers.get("Content-Type", ""),
            "title": title.group(1) if title else None, "serves_app": "<texera-root" in r.text}


def setup(api, a: argparse.Namespace, *, run_id: str, log: Callable[[str], None], report: dict) -> dict:
    report["target"] = TARGET
    rec = report["setup"].setdefault("localdev", {})
    rec["base"] = a.base
    rec["dev_server"] = page = dev_server_page(a.base)
    if page["status"] != 200 or not page["serves_app"]:
        raise RuntimeError(f"{a.base}/ is not the Texera app ({page}); is the dev server up?")

    types = (api.get_json("/api/computing-unit/types") or {}).get("typeOptions") or []
    rec["unit_types_offered"] = types
    if "local" not in types:
        raise RuntimeError(f"the deployment does not offer local computing units (types {types})")
    # the create dialog preselects kubernetes when offered, else the first type
    rec["create_dialog_default_type"] = "kubernetes" if "kubernetes" in types else types[0]

    before = {int((u.get("computingUnit") or {}).get("cuid", -1)) for u in api.list_units()}
    request = {"name": a.unit_name, "unitType": "local", "cpuLimit": "NaN", "memoryLimit": "NaN",
               "gpuLimit": "NaN", "jvmMemorySize": "NaN", "shmSize": "NaN", "uri": a.unit_uri}
    cu = api.ensure_local_unit(a.unit_name, a.unit_uri)  # sends `request` when no such unit exists
    cuid = int(cu["cuid"])
    rec["unit_request"] = request
    rec["unit"] = {"cuid": cuid, "name": cu.get("name"), "uri": cu.get("uri"), "type": cu.get("type"),
                   "created": cuid not in before}
    log(f"local computing unit {cuid} '{cu.get('name')}' -> {cu.get('uri')} "
        f"({'created' if cuid not in before else 'reused'}; types offered {types})")

    t0 = time.monotonic()
    probe_wf = Workflow(f"sce-e2e {run_id} localdev-unit-probe")
    wid = api.create_workflow(probe_wf.name, probe_wf.ui_content())
    rec["websocket_probe"] = dict(k8s_unit.wait_reachable(a.base, api.token, api.uid, cuid, wid,
                                                          max(30.0, a.timeout), log), wid=wid)
    log(f"the unit answers a workflow socket through the dev server's /wsapi proxy "
        f"({rec['websocket_probe']['attempts']} attempt(s), {time.monotonic() - t0:.1f}s)")
    return dict(cu, type="local")
