#!/usr/bin/env python3
"""Texera the way bin/local-dev.sh runs it, isolated for the e2e harness.

local-dev puts the infrastructure in Docker (the single-node compose file plus
bin/local-dev/docker-compose.override.yml, which publishes the backend ports), runs every
JVM service on the host from its dist launcher, and serves the frontend with the Angular
dev server, whose proxy (frontend/proxy.config.json) sends /api and /wsapi to those
services on their fixed ports. This controller does the same from a worktree (`--source`),
with what the harness needs on a shared machine:

  * the infrastructure is a renamed copy of local-dev's: compose project `e2e-localdev`,
    containers `e2e-localdev-<original name>`, network `e2e-localdev-net`, volumes
    `e2e-localdev_<volume>`, the original names kept as network aliases. Its host ports
    are shifted (Postgres 15432, LakeFS 18000, Lakekeeper 18181, RustFS 19000), because
    5432 and 8000 are taken here by containers this harness must never touch. LiteLLM and
    Jupyter are left out (not on a run's path);
  * the environment of the host services is local-dev's own: the `export X="${X:-...}"`
    defaults of the source's bin/local-dev/main.sh, with the infrastructure ports
    remapped and STORAGE_S3_ENDPOINT on the host's LAN IP (as local-dev detects it), plus
    UDF_PYTHON_PATH and a JAVA_OPTS heap cap per service. Nothing else from the caller's
    environment reaches them;
  * right after the infrastructure, local-dev's schema step (infra_ensure_db_schema, its
    functions taken from main.sh and run by bash unchanged but for the container name)
    reconciles sql/changelog.xml with this stack's Postgres. When it fails, `bin/local-dev.sh
    up` stops; this stack stops too with --strict-schema, and otherwise goes on and records
    the deviation (MANIFEST.json `local_dev_deviations`, folded into the report);
  * the services, their order, launchers and working directories come from main.sh's
    service catalog (notebook-migration-service and agent-service are left out). They
    run from the source's dist zips (built with `sbt dist` only when a zip is missing; each
    build records what it was built from, and `up` refuses a zip that does not match the
    source), unzipped under .state/localdev/dist, as host processes in their own process
    groups, with pid files under .state/localdev/pids and logs in a reports/ directory;
  * the frontend is `ng serve` from the source's frontend/ with node 24 (the ng half of
    `yarn start`; its y-websocket half is only for shared editing), so every request of
    the driver goes through the dev server's proxy, as a developer's browser's does.

`unit-kill`, `unit-stop`, `unit-start` and `pg-activity` are what the driver's StackControl
(driver/stack_control.py) asks of this stack; each prints one JSON document.

Commands: generate | build | up | down | reset | status | logs | collect-logs | post-run |
unit-kill | unit-stop | unit-start | pg-activity.
`up`, `build`, `down` and `reset` change Docker state: hold the stack lock (README, "One
run at a time"), or use run-localdev.sh, which takes it. Nothing outside this project's
containers, network and volumes, and the processes it started, is ever stopped.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent            # stack/localdev
HARNESS = HERE.parents[1]
sys.path.insert(0, str(HARNESS / "lib"))

import pg_activity  # noqa: E402
from record_env import fast_record_env, record_timing  # noqa: E402

GEN_DIR = HERE / "generated"
MANIFEST = GEN_DIR / "MANIFEST.json"
STATE_DIR = HARNESS / ".state" / "localdev"
DIST_DIR = STATE_DIR / "dist"
PID_DIR = STATE_DIR / "pids"
# what each dist zip was built from (written by this harness's builds; see build_dists)
PROVENANCE = STATE_DIR / "dist-provenance.json"
REPORTS = HARNESS / "reports"

DEFAULT_SOURCE = Path(os.environ.get("SCE_LOCALDEV_SOURCE")
                      or "/Users/jiadongb/Desktop/projects/texera-worktrees/sce-localdev-src")
# A Python 3.11 venv with amber's requirements (built for the step-1 checks); `--python`,
# $SCE_LOCALDEV_PYTHON or .state/localdev/py311 (stack/localdev-stack.sh venv) win over it.
SCRATCH_PY311 = Path("/private/tmp/claude-501/-Users-jiadongb-Desktop-projects-texera/"
                     "110f62ac-4583-4269-8645-82b6251b3c39/scratchpad/sce/step1cd/py311/bin/python")
OWN_PY311 = STATE_DIR / "py311" / "bin" / "python"

PROJECT = "e2e-localdev"
NETWORK = f"{PROJECT}-net"
VOLUME_PREFIX = f"{PROJECT}_"

# local-dev's DOCKER_INFRA_SERVICES minus these (neither is on a workflow run's path)
DROPPED_INFRA = {
    "litellm": "the LLM proxy (agent panel, access-control-service's /api/models)",
    "jupyter": "notebook migration's JupyterLab",
}
# local-dev's JVM services minus these
DROPPED_SERVICES = {
    "notebook-migration-service": "the notebook migration tool (needs Jupyter)",
}
# Host ports of the infrastructure: (container port, host port). local-dev publishes
# 5432, 8000 and 8181 (its override) and 9000 (the base file); 5432 and 8000 are taken on
# this machine by containers the harness must not touch, so all four move by 10000.
INFRA_PORTS = {"postgres": (5432, 15432), "lakefs": (8000, 18000),
               "lakekeeper": (8181, 18181), "rustfs": (9000, 19000)}
# Ports the services bind besides local-dev's SVC_PORT: Dropwizard admin connectors, the
# managing service's application port (SVC_PORT is its admin port, 8082), and the unit's
# Pekko port (AmberRuntime.startActorMaster binds 2552). `up` compares what each service
# really listens on with this list and warns about anything else.
EXTRA_PORTS = {"texera-web": (8081,), "computing-unit-managing-service": (8888,),
               "computing-unit-master": (2552,)}
# The health URL path the harness waits for where local-dev's SVC_HEALTH is empty
# (the managing service on its application port; the unit: the single-node stack's check).
HARNESS_HEALTH = {
    "computing-unit-managing-service": (8888, "/api/healthcheck"),
    "computing-unit-master": (8085, "/api/execution/health"),
}
# sbt project of a service whose SVC_SBT is empty (it rides another's dist), as
# main.sh's _precompute_src_dirs maps it
SHARED_SBT = {"computing-unit-master": "WorkflowExecutionService"}
# -Xmx per service (JAVA_OPTS); `--heap NAME=SIZE` (or all=SIZE) overrides
DEFAULT_HEAPS = {
    "config-service": "512m",
    "access-control-service": "512m",
    "file-service": "512m",
    "workflow-compiling-service": "1g",
    "computing-unit-master": "1g",
    "computing-unit-managing-service": "512m",
    "texera-web": "1g",
}
SBT_HEAP = os.environ.get("SCE_LOCALDEV_SBT_HEAP", "3g")
# local-dev's names of the two services step 3's timers belong to
UNIT_SERVICE = "computing-unit-master"
DASHBOARD_SERVICE = "texera-web"
FRONTEND = "frontend"
FRONTEND_PORT = 4200
FRONTEND_URL = f"http://localhost:{FRONTEND_PORT}"
NG = "./node_modules/@angular/cli/bin/ng"

LOG_ALIASES = {
    "unit": "computing-unit-master",
    "cu": "computing-unit-master",
    "dashboard": "texera-web",
    "web": "texera-web",
    "cu-manager": "computing-unit-managing-service",
    "compiler": "workflow-compiling-service",
    "files": "file-service",
    "config": "config-service",
    "acs": "access-control-service",
    "ng": FRONTEND,
    "pg": "postgres",
}
# caller variables that would configure a Texera service (or its Python workers' S3 client)
# behind the harness's back; the build's sbt gets the caller's environment without them
_TEXERA_ENV = re.compile(r"^(STORAGE_|USER_SYS_|COMPUTING_UNIT_|KUBERNETES_|TEXERA_|WORKFLOW_|"
                         r"FILE_SERVICE_|LITELLM_|LLM_|UDF_|GUI_|AUTH_|WEB_SERVER_|FAULT_TOLERANCE_|"
                         r"OTEL_|AWS_|JAVA_OPTS$|JAVA_TOOL_OPTIONS$|_JAVA_OPTIONS$|JDK_JAVA_OPTIONS$)")
_SECRET_KEY = re.compile(r"TOKEN|SECRET|PASSWORD|PASSWD|KEY", re.I)


# --------------------------------------------------------------------------- utils


def log(msg: str) -> None:
    print(f"[localdev] {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"[localdev] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def warn(m: dict, msg: str) -> None:
    """A caveat of this run: logged, and kept in the manifest (`warnings`), which the driver's
    report embeds and post-run folds into the report's summary."""
    log(f"WARNING: {msg}")
    m.setdefault("warnings", []).append(msg)


def run(cmd: list[str], check: bool = True, capture: bool = False, timeout: float | None = None,
        **kw) -> subprocess.CompletedProcess:
    if capture:
        kw.setdefault("stdout", subprocess.PIPE)
        kw.setdefault("stderr", subprocess.PIPE)
        kw.setdefault("text", True)
    try:
        proc = subprocess.run(cmd, timeout=timeout, **kw)
    except subprocess.TimeoutExpired:
        die(f"command timed out after {timeout}s: {' '.join(cmd)}")
    if check and proc.returncode != 0:
        detail = ""
        if capture:
            detail = f"\n{(proc.stdout or '')[-3000:]}{(proc.stderr or '')[-3000:]}"
        die(f"command failed ({proc.returncode}): {' '.join(cmd)}{detail}")
    return proc


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def stamp() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, default=str) + "\n")
    tmp.replace(path)


def load_manifest(required: bool = True) -> dict:
    if not MANIFEST.exists():
        if required:
            die("stack/localdev/generated/ does not exist yet; run `localdev-stack.sh up` (or `generate`) first")
        return {}
    return json.loads(MANIFEST.read_text())


def masked(env: dict[str, str]) -> dict[str, str]:
    return {k: (f"<set, {len(v)} chars>" if _SECRET_KEY.search(k) else v) for k, v in sorted(env.items())}


def git_info(source: Path) -> dict:
    # GIT_OPTIONAL_LOCKS=0: never refresh (and lock) the index of someone else's worktree
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")

    def g(*args: str) -> str:
        p = subprocess.run(["git", "-C", str(source), *args], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True, env=env)
        return p.stdout.strip() if p.returncode == 0 else ""

    return {"head": g("rev-parse", "HEAD"), "branch": g("rev-parse", "--abbrev-ref", "HEAD"),
            "dirty": bool(g("status", "--porcelain", "--untracked-files=no"))}


def http_get(url: str, timeout: float = 5) -> tuple[int | None, str, str]:
    """(status or None, content type, body head) -- any HTTP status counts as an answer."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read(65536).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", "") if e.headers else "", ""
    except (urllib.error.URLError, OSError, ValueError) as e:
        return None, "", f"{type(e).__name__}: {e}"


def listening(addr: str, port: int) -> bool:
    family = socket.AF_INET6 if ":" in addr else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as c:
            c.settimeout(1)
            return c.connect_ex((addr, port)) == 0
    except OSError:
        return False


def port_open(port: int) -> bool:
    return listening("127.0.0.1", port) or listening("::1", port)


def port_holder(port: int) -> str:
    """Who listens on `port` (lsof), for an error message."""
    p = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fpc"],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    pids, cmds = re.findall(r"^p(\d+)", p.stdout, re.M), re.findall(r"^c(.*)$", p.stdout, re.M)
    return ", ".join(f"{c} (pid {pid})" for pid, c in zip(pids, cmds)) or "an unknown process"


def docker_port_holders(port: int) -> list[tuple[str, str]]:
    """(container, compose project) of running containers publishing `port` on the host."""
    p = run(["docker", "ps", "--format",
             '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Ports}}'], capture=True)
    out = []
    for line in p.stdout.splitlines():
        cols = line.split("\t")
        if len(cols) >= 3 and re.search(rf"(^|[\s,]|\]|\d):{port}->", cols[2]):
            out.append((cols[0], cols[1]))
    return out


def tail(path: Path, n: int = 40) -> str:
    try:
        return "\n".join(path.read_text(errors="replace").splitlines()[-n:])
    except OSError:
        return "(no log)"


# ---------------------------------------------------------------- local-dev's own config


def _bash_array(text: str, name: str) -> list[str] | None:
    m = re.search(rf"^{name}=\(([^)]*)\)", text, re.M)
    if not m:
        return None
    return [w for w in re.sub(r"#[^\n]*", "", m.group(1)).split() if w]


def texera_version(source: Path) -> str:
    m = re.search(r'^\s*ThisBuild\s*/\s*version\s*:=\s*"([^"]+)"', (source / "build.sbt").read_text(), re.M)
    if not m:
        die(f"no `ThisBuild / version` in {source / 'build.sbt'}")
    return m.group(1)


def parse_local_dev(source: Path) -> dict:
    """What the source's bin/local-dev/main.sh does: its env exports (the `${X:-default}`
    defaults), its Docker infrastructure services, and its service catalog in start order."""
    main_sh = source / "bin" / "local-dev" / "main.sh"
    if not main_sh.exists():
        die(f"{main_sh} does not exist: --source must be a Texera worktree with bin/local-dev")
    text = main_sh.read_text()
    exports = {k: v for k, v in re.findall(
        r'^[ \t]*export ([A-Z_][A-Z0-9_]*)="\$\{\1:-(.*)\}"[ \t]*$', text, re.M)}
    for need in ("STORAGE_JDBC_URL", "STORAGE_S3_ENDPOINT", "STORAGE_ICEBERG_CATALOG_TYPE",
                 "STORAGE_ICEBERG_CATALOG_REST_URI", "STORAGE_LAKEFS_ENDPOINT"):
        if need not in exports:
            die(f"{main_sh} has no `export {need}=\"${{{need}:-...}}\"`; its env section changed shape")
    infra = _bash_array(text, "DOCKER_INFRA_SERVICES")
    order = _bash_array(text, "SERVICES")
    if not infra or not order:
        die(f"{main_sh}: no DOCKER_INFRA_SERVICES=(...) or SERVICES=(...) array")
    catalog: dict[str, dict[str, str]] = {}
    for stmt in re.findall(r"^[ \t]*(amap_set[^\n]*)$", text, re.M):
        for part in stmt.split(";"):
            m = re.match(r'\s*amap_set\s+(SVC_[A-Z_]+)\s+(\S+)\s*(.*?)\s*$', part)
            if m:
                key, svc, value = m.groups()
                catalog.setdefault(svc, {})[key] = value.strip().strip('"')
    version = texera_version(source)
    services = []
    for name in order:
        c = catalog.get(name, {})
        if c.get("SVC_TYPE") != "jvm":
            continue
        launcher = c.get("SVC_LAUNCHER", "").replace("${TEXERA_VERSION}", version)
        if not re.fullmatch(r"target/[^/]+/bin/[^/]+", launcher):
            die(f"{main_sh}: unexpected launcher for {name}: {launcher!r}")
        services.append({
            "name": name, "type": "jvm",
            "local_dev_port": int(c.get("SVC_PORT", "0") or 0),
            "sbt": c.get("SVC_SBT") or SHARED_SBT.get(name, ""),
            "zip_glob": c.get("SVC_ZIP_GLOB", ""),
            "dist_dir": launcher.split("/")[1],          # e.g. amber-1.4.0-incubating-SNAPSHOT
            "launcher": "/".join(launcher.split("/")[2:]),  # e.g. bin/computing-unit-master
            "cwd": c.get("SVC_CWD", "."),
            "local_dev_health": c.get("SVC_HEALTH", ""),
        })
    # a service riding another's dist (empty zip glob) takes the zip of the one with its dist dir
    for s in services:
        if not s["zip_glob"]:
            twin = next((t for t in services if t["dist_dir"] == s["dist_dir"] and t["zip_glob"]), None)
            if twin is None:
                die(f"{main_sh}: no zip produces {s['name']}'s {s['dist_dir']}")
            s["zip_glob"] = twin["zip_glob"]
            s["zip_from"] = twin["name"]
        if not s["sbt"]:
            die(f"{main_sh}: no sbt project builds {s['name']}")
    return {"exports": exports, "infra": infra, "order": order, "services": services,
            "version": version, "main_sh": str(main_sh)}


def remap_env(exports: dict[str, str], ports: dict[str, int], s3_endpoint: str) -> dict[str, str]:
    """local-dev's exports, pointed at this stack's shifted infrastructure ports."""
    env = {}
    for key, value in exports.items():
        if key == "STORAGE_S3_ENDPOINT":
            value = s3_endpoint  # local-dev: http://$HOST_LAN_IP:9000
        else:
            for name, (container, _host) in INFRA_PORTS.items():
                value = re.sub(rf"\blocalhost:{container}\b", f"localhost:{ports[name]}", value)
        if "$" in value:
            die(f"cannot resolve local-dev's {key}={value!r}")
        env[key] = value
    return env


# --------------------------------------------------------------------------- toolchain


def detect_lan_ip() -> str:
    """The host LAN IP local-dev uses for the RustFS endpoint (its macOS probe): the
    interface of the default route, else the first of en0..en10 with an address."""
    if os.environ.get("HOST_LAN_IP"):
        return os.environ["HOST_LAN_IP"]
    p = subprocess.run(["route", "get", "default"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    m = re.search(r"interface:\s*(\S+)", p.stdout)
    ifaces = ([m.group(1)] if m else []) + [f"en{i}" for i in range(11)]
    for iface in ifaces:
        q = subprocess.run(["ipconfig", "getifaddr", iface], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True)
        ip = q.stdout.strip()
        if ip and not ip.startswith("127."):
            return ip
    die("could not detect a host LAN IP (local-dev needs one for the RustFS endpoint); export HOST_LAN_IP")
    return ""


def java_home() -> dict:
    """A JDK 17: $JAVA_HOME, else /usr/libexec/java_home -v 17, else SDKMAN's."""
    cands = [os.environ.get("JAVA_HOME", "")]
    p = subprocess.run(["/usr/libexec/java_home", "-v", "17"], stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, text=True)
    cands.append(p.stdout.strip())
    cands += sorted(str(d) for d in (Path.home() / ".sdkman" / "candidates" / "java").glob("17*"))
    for home in cands:
        if not home or not (Path(home) / "bin" / "java").exists():
            continue
        v = subprocess.run([str(Path(home) / "bin" / "java"), "-version"], stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True).stdout
        if re.search(r'version "17[."]', v):
            return {"home": home, "version": " / ".join(v.strip().splitlines()[:2])}
    die("no JDK 17 found ($JAVA_HOME, java_home -v 17, SDKMAN)")
    return {}


def node24() -> dict:
    nvm = Path.home() / ".nvm" / "nvm.sh"
    path = ""
    if nvm.exists():
        p = subprocess.run(["bash", "-c", f'source "{nvm}" >/dev/null 2>&1 && nvm which 24'],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        path = p.stdout.strip().splitlines()[-1] if p.stdout.strip() else ""
    if not path or not Path(path).exists():
        found = sorted((Path.home() / ".nvm" / "versions" / "node").glob("v24.*/bin/node"))
        path = str(found[-1]) if found else ""
    if not path:
        die("node 24 not found under nvm (nvm install 24)")
    v = subprocess.run([path, "--version"], stdout=subprocess.PIPE, text=True).stdout.strip()
    if not v.startswith("v24."):
        die(f"{path} is {v}, not node 24")
    return {"node": path, "version": v}


def resolve_python(arg: str | None) -> Path:
    for cand in (arg, os.environ.get("SCE_LOCALDEV_PYTHON"), str(OWN_PY311), str(SCRATCH_PY311)):
        if cand and Path(cand).exists():
            return Path(cand)
    die("no Python for UDF workers: pass --python, set SCE_LOCALDEV_PYTHON, or build one with "
        "`stack/localdev-stack.sh venv`")
    return Path()


CHECK_PY = r"""
import importlib.metadata as md, json, re, sys
def norm(n): return re.sub(r"[-_.]+", "-", n).lower()
have = {norm(d.metadata["Name"]): d.version for d in md.distributions()}
bad = []
for line in open(sys.argv[1]):
    line = line.split("#")[0].strip()
    if not line or line.startswith("-") or "==" not in line:
        continue
    name, want = line.split(";")[0].split("==")
    got = have.get(norm(name.strip()))
    if got != want.strip():
        bad.append(f"{name.strip()}: want {want.strip()}, have {got}")
try:
    import pyarrow, pandas, loguru  # local-dev's check (_python_deps_ok)
    imports = True
except Exception as e:
    imports = f"{type(e).__name__}: {e}"
print(json.dumps({"version": sys.version.split()[0], "executable": sys.executable,
                  "requirements_mismatches": bad, "local_dev_import_check": imports}))
"""


def check_python(py: Path, source: Path) -> dict:
    req = source / "amber" / "requirements.txt"
    p = run([str(py), "-I", "-c", CHECK_PY, str(req)], capture=True, check=False)
    if p.returncode != 0:
        die(f"{py} cannot run: {p.stderr[-500:]}")
    info = json.loads(p.stdout)
    info["path"] = str(py)
    if info["local_dev_import_check"] is not True:
        die(f"{py} cannot import amber's deps (local-dev's check): {info['local_dev_import_check']}")
    if info["requirements_mismatches"]:
        log(f"WARNING: {py} differs from amber/requirements.txt: {'; '.join(info['requirements_mismatches'])}")
    return info


def betterproto_pin(source: Path) -> str:
    m = re.search(r"^betterproto==(\S+)", (source / "amber" / "requirements.txt").read_text(), re.M)
    if not m:
        die("no betterproto== pin in amber/requirements.txt")
    return f"betterproto[compiler]=={m.group(1)}"


def protoc_plugin_dir(source: Path) -> str:
    """A directory holding protoc-gen-python_betterproto at amber's pin: on PATH, the
    harness's .venv-proto (images/build.sh) when its pin matches, else one built here."""
    on_path = shutil.which("protoc-gen-python_betterproto")
    if on_path:
        return str(Path(on_path).parent)
    want = betterproto_pin(source)
    for venv in (HARNESS / ".venv-proto", STATE_DIR / "venv-proto"):
        pin = venv / ".pin"
        if (venv / "bin" / "protoc-gen-python_betterproto").exists() and pin.exists() \
                and pin.read_text().strip() == want:
            return str(venv / "bin")
    venv = STATE_DIR / "venv-proto"
    if not shutil.which("uv"):
        die("uv is not on PATH (brew install uv); it builds the betterproto plugin venv")
    log(f"building the protoc plugin venv {venv} ({want})")
    if not (venv / "bin" / "python").exists():
        run(["uv", "venv", "--quiet", "--python", "3.12", str(venv)], capture=True)
    run(["uv", "pip", "install", "--quiet", "--python", str(venv / "bin" / "python"), want], capture=True)
    (venv / ".pin").write_text(want + "\n")
    return str(venv / "bin")


# ------------------------------------------------------------------------ generate


def _merge_env(base, extra) -> dict:
    out: dict = {}
    for src in (base, extra):
        if isinstance(src, dict):
            out.update(src)
        elif isinstance(src, list):
            for item in src:
                k, _, v = str(item).partition("=")
                out[k] = v
    return out


def _remap_port(spec, name: str) -> str:
    """local-dev's "HOST:CONTAINER" for an infra service -> 127.0.0.1:<shifted>:CONTAINER."""
    if name not in INFRA_PORTS:
        die(f"service {name} publishes {spec!r}, which this stack does not expect")
    container, host = INFRA_PORTS[name]
    parts = str(spec).split(":")
    if int(parts[-1].split("/")[0]) != container:
        die(f"service {name} publishes container port {parts[-1]}, expected {container}")
    return f"127.0.0.1:{host}:{container}"


#: keys the generator changes on a kept service (everything else is the source's)
_REWRITTEN = {"container_name", "networks", "ports", "volumes", "environment"}


class _Dumper(yaml.SafeDumper):
    """Writes the init scripts as literal blocks where YAML allows it (readability only)."""


_Dumper.add_representer(str, lambda d, s: d.represent_scalar(
    "tag:yaml.org,2002:str", s, style="|" if "\n" in s else None))


def generate(source: Path, lan_ip: str, out_dir: Path | None = None) -> dict:
    gen = out_dir or GEN_DIR
    sn = source / "bin" / "single-node"
    ld = source / "bin" / "local-dev"
    base_f, env_f, over_f = sn / "docker-compose.yml", sn / ".env", ld / "docker-compose.override.yml"
    for f in (base_f, env_f, over_f, source / "sql", source / "frontend" / "proxy.config.json"):
        if not f.exists():
            die(f"source worktree is missing {f}")
    cfg = parse_local_dev(source)
    ports = {name: host for name, (_c, host) in INFRA_PORTS.items()}
    s3_endpoint = f"http://{lan_ip}:{ports['rustfs']}"

    base = yaml.safe_load(base_f.read_text())
    over = yaml.safe_load(over_f.read_text()) or {}
    services, ov = base["services"], over.get("services") or {}
    unknown = [s for s in cfg["infra"] if s not in services]
    if unknown:
        die(f"local-dev's DOCKER_INFRA_SERVICES names services the compose file lacks: {unknown}")
    kept = [s for s in cfg["infra"] if s not in DROPPED_INFRA]

    if gen.exists():
        shutil.rmtree(gen)
    gen.mkdir(parents=True)
    used_volumes: set[str] = set()
    containers: dict[str, str] = {}
    merged_src: dict[str, dict] = {}
    new: dict[str, dict] = {}
    for name in kept:
        svc = copy.deepcopy(services[name])
        o = ov.get(name) or {}
        extra_keys = set(o) - {"ports", "environment"}
        if extra_keys:
            die(f"local-dev's override sets {sorted(extra_keys)} on {name}; the generator handles ports and environment only")
        # compose's override semantics: ports concatenate, environment merges by key
        if "ports" in o:
            svc["ports"] = list(svc.get("ports") or []) + list(o["ports"])
        if "environment" in o:
            svc["environment"] = _merge_env(svc.get("environment"), o["environment"])
        merged_src[name] = copy.deepcopy(svc)

        original_cn = svc.get("container_name", name)
        svc["container_name"] = f"{PROJECT}-{original_cn}"
        containers[name] = svc["container_name"]
        svc["networks"] = {"default": {"aliases": sorted({name, original_cn})}}
        dep = svc.get("depends_on") or {}
        missing_dep = [d for d in dep if d not in kept]
        if missing_dep:
            die(f"{name} depends on {missing_dep}, which this stack drops")
        if "ports" in svc:
            svc["ports"] = [p if "${RUSTFS_PORT" in str(p) else _remap_port(p, name) for p in svc["ports"]]
        if isinstance(svc.get("environment"), dict) and "STORAGE_S3_ENDPOINT" in svc["environment"]:
            # local-dev exports STORAGE_S3_ENDPOINT (the LAN IP) before `compose up`
            svc["environment"]["STORAGE_S3_ENDPOINT"] = s3_endpoint
        vols = []
        for v in svc.get("volumes", []):
            parts = str(v).split(":")
            if parts[0].startswith((".", "/")):
                src = (sn / parts[0]).resolve()
                if src != (source / "sql").resolve():
                    die(f"{name} bind-mounts {src}; only the sql/ init directory is expected")
                dst = gen / "sql"
                dst.mkdir(exist_ok=True)
                for f in sorted(src.iterdir()):  # Postgres runs only the top-level scripts
                    if f.is_file() and f.suffix in (".sql", ".sh"):
                        shutil.copy2(f, dst / f.name)
                vols.append(":".join(["./sql", parts[1], "ro"]))
            else:
                used_volumes.add(parts[0])
                vols.append(str(v))
        if vols:
            svc["volumes"] = vols
        new[name] = svc

    compose = {"name": PROJECT, "services": new, "networks": {"default": {"name": NETWORK}},
               "volumes": {k: {"name": f"{VOLUME_PREFIX}{k}"} for k in sorted(used_volumes)}}
    header = ("# GENERATED by sce-e2e/stack/localdev/localdev_stack.py -- do not edit.\n"
              f"# source: {base_f} + {over_f} (local-dev's infrastructure)\n")
    (gen / "docker-compose.yml").write_text(header + yaml.dump(compose, Dumper=_Dumper, sort_keys=False,
                                                                width=1000, allow_unicode=True))
    env_text = env_f.read_text()
    overrides = {"RUSTFS_PORT": str(ports["rustfs"]), "COMPOSE_PROFILES": ""}
    lines, seen = [], set()
    for line in env_text.splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line)
        if m and m.group(1) in overrides:
            lines.append(f"{m.group(1)}={overrides[m.group(1)]}")
            seen.add(m.group(1))
        else:
            lines.append(line)
    lines += [f"{k}={v}" for k, v in overrides.items() if k not in seen]
    (gen / ".env").write_text("\n".join(lines) + "\n")

    # round trip: every kept service is local-dev's except the keys rewritten on purpose
    written = yaml.safe_load((gen / "docker-compose.yml").read_text())["services"]
    problems = []
    for name, svc in written.items():
        src = merged_src[name]
        for key in set(src) | set(svc):
            if key not in _REWRITTEN and src.get(key) != svc.get(key):
                problems.append(f"{name}.{key}")
        want = _merge_env(src.get("environment"), None)
        if "STORAGE_S3_ENDPOINT" in want:
            want["STORAGE_S3_ENDPOINT"] = s3_endpoint
        if want != _merge_env(svc.get("environment"), None):
            problems.append(f"{name}.environment")
        if svc.get("container_name") != f"{PROJECT}-{src.get('container_name', name)}":
            problems.append(f"{name}.container_name")
    if problems:
        die("generated compose failed its round-trip check: " + ", ".join(problems))

    service_env = remap_env(cfg["exports"], ports, s3_endpoint)
    jvm = [s for s in cfg["services"] if s["name"] not in DROPPED_SERVICES]
    for s in jvm:
        if s["name"] not in DEFAULT_HEAPS:
            die(f"local-dev runs a JVM service this harness does not know: {s['name']}")
    manifest = {
        "mode": "localdev",
        "generated_at": now_iso(),
        "source": str(source),
        "source_git": git_info(source),
        "texera_version": cfg["version"],
        "local_dev": {"main_sh": cfg["main_sh"], "infra_services": cfg["infra"], "service_order": cfg["order"]},
        "project": PROJECT,
        "network": NETWORK,
        "volumes": [f"{VOLUME_PREFIX}{k}" for k in sorted(used_volumes)],
        "containers": containers,
        "infra_services": kept,
        "dropped": {**{k: v for k, v in DROPPED_INFRA.items()}, **DROPPED_SERVICES,
                    "agent-service": "the agent panel (Bun)",
                    "y-websocket": "`yarn start`'s second process, shared editing only (/rtc)"},
        "lan_ip": lan_ip,
        "s3_endpoint": s3_endpoint,
        "ports": {**ports, **{s["name"]: s["local_dev_port"] for s in jvm}, FRONTEND: FRONTEND_PORT},
        "frontend_url": FRONTEND_URL,
        "service_env": service_env,  # rewritten below with secrets masked
        "services": jvm,
    }
    manifest["service_env"] = masked(service_env)
    write_json(gen / "MANIFEST.json", manifest)
    (gen / "service.env.json").write_text(json.dumps(service_env, indent=2) + "\n")
    os.chmod(gen / "service.env.json", 0o600)
    return manifest


# ------------------------------------------------------------------- compose glue


def compose_cmd(*args: str) -> list[str]:
    return ["docker", "compose", "-p", PROJECT, "-f", str(GEN_DIR / "docker-compose.yml"),
            "--env-file", str(GEN_DIR / ".env"), *args]


def compose_env() -> dict[str, str]:
    """The caller's environment minus everything the generated .env defines and compose's
    own selectors: compose lets the shell override the env file during interpolation."""
    env = dict(os.environ)
    gen_env = GEN_DIR / ".env"
    keys = re.findall(r"^([A-Za-z_][A-Za-z0-9_]*)=", gen_env.read_text(), re.M) if gen_env.exists() else []
    for key in [*keys, "STORAGE_S3_ENDPOINT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES",
                "COMPOSE_ENV_FILES"]:
        env.pop(key, None)
    return env


def compose(*args: str, **kw) -> subprocess.CompletedProcess:
    if not (GEN_DIR / "docker-compose.yml").exists():
        return run(["docker", "compose", "-p", PROJECT, *args], **kw)
    return run(compose_cmd(*args), env=compose_env(), **kw)


def compose_ps() -> list[dict]:
    p = run(["docker", "compose", "-p", PROJECT, "ps", "-a", "--format", "json"], capture=True, check=False)
    text = (p.stdout or "").strip()
    if p.returncode != 0 or not text:
        return []
    if text.startswith("["):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def wait_infra(services: list[str], timeout: int, only: list[str] | None = None) -> float:
    """Every long-lived service healthy (or running), every one-shot job exited 0."""
    spec = yaml.safe_load((GEN_DIR / "docker-compose.yml").read_text())["services"]
    names = only or services
    t0 = time.time()
    last = 0.0
    pending: list[str] = []
    while time.time() - t0 < timeout:
        rows = {r.get("Service"): r for r in compose_ps()}
        pending, failed = [], []
        for name in names:
            r, s = rows.get(name), spec[name]
            if r is None:
                pending.append(f"{name}(absent)")
                continue
            state, health = (r.get("State") or "").lower(), (r.get("Health") or "").lower()
            if str(s.get("restart", "")).lower() == "no":
                if state == "exited":
                    if int(r.get("ExitCode", 1)) != 0:
                        failed.append(f"{name} exited {r.get('ExitCode')}")
                else:
                    pending.append(f"{name}({state})")
            elif state in ("exited", "dead"):
                failed.append(f"{name} {state} (exit {r.get('ExitCode')})")
            elif "healthcheck" in s and health != "healthy":
                pending.append(f"{name}({state}/{health or 'starting'})")
            elif state != "running":
                pending.append(f"{name}({state})")
        if failed:
            for f in failed:
                svc = f.split()[0]
                print(f"----- last log lines of {svc} -----", file=sys.stderr)
                compose("logs", "--no-color", "--tail", "60", svc, check=False)
            die("infrastructure failed: " + "; ".join(failed))
        if not pending:
            return round(time.time() - t0, 1)
        if time.time() - last > 15:
            log(f"waiting for {len(pending)} infra service(s): {', '.join(pending)}")
            last = time.time()
        time.sleep(3)
    die(f"infrastructure not ready after {timeout}s: {', '.join(pending)}")
    return 0.0


# ------------------------------------------------------------ local-dev's schema step

#: bin/local-dev/main.sh's schema step. `bin/local-dev.sh up` runs infra_ensure_db_schema right
#: after infra_up, before any build: Postgres has run sql/ itself on a fresh volume, and the
#: step replays every changeSet of sql/changelog.xml that public.databasechangelog does not
#: list, accepting a failed one only when every error says "already exists". The functions are
#: taken from the source's main.sh and run by bash unchanged, but for the container's name.
SCHEMA_FUNCTIONS = ("infra_ensure_db_schema", "infra_apply_sql_updates", "parse_changelog_changesets",
                    "_sql_errors_all_already_exist")
SCHEMA_PG_LINE = 'local pg="texera-postgres"'
#: local-dev's output helpers, printing tab-separated lines the harness reads back (local-dev
#: prints the same messages with colors and symbols)
SCHEMA_TUI = "\n".join(f"{n}() {{ printf '%s\\t%s\\n' {n} \"$*\"; }}"
                       for n in ("tui_ok", "tui_err", "tui_warn", "tui_step", "tui_skip", "tui_info"))


def bash_function(text: str, name: str, where: str) -> str:
    """Bash function `name` as `text` defines it: from `name() {` at the start of a line to
    the first line that is only `}`."""
    m = re.search(rf"^{re.escape(name)}\(\)\s*\{{[ \t]*\n.*?^\}}[ \t]*$", text, re.M | re.S)
    if not m:
        die(f"{where} has no function {name}(): local-dev's schema step changed shape, and the "
            "harness needs updating (localdev_stack.py, SCHEMA_FUNCTIONS)")
    return m.group(0)


def bash_path() -> str:
    """The bash main.sh's `#!/usr/bin/env bash` finds on this PATH."""
    return shutil.which("bash") or "/bin/bash"


def schema_step_spec(source: Path) -> dict:
    """What local-dev's `up` runs for the schema: the functions, and whether their failure
    ends `up` (cmd_up calls the step as a plain statement, main.sh runs under `set -e`, and
    `up` is dispatched as a plain call)."""
    main_sh = source / "bin" / "local-dev" / "main.sh"
    text = main_sh.read_text()
    funcs = {n: bash_function(text, n, str(main_sh)) for n in SCHEMA_FUNCTIONS}
    found = sum(f.count(SCHEMA_PG_LINE) for f in funcs.values())
    if found != 2:
        die(f"{main_sh}: expected `{SCHEMA_PG_LINE}` in infra_ensure_db_schema and infra_apply_sql_updates, "
            f"found it {found} time(s): local-dev's schema step changed shape")
    up = bash_function(text, "cmd_up", str(main_sh))
    calls = [c.strip() for c in re.findall(r"^[ \t]*infra_ensure_db_schema\b([^\n]*)$", up, re.M)]
    if not calls:
        die(f"{main_sh}: cmd_up no longer runs infra_ensure_db_schema: local-dev's schema step changed shape")
    plain_call = all(c == "" or c.startswith("#") for c in calls)
    set_e = bool(re.search(r"^set -[a-z]*e[a-z]*\b", text, re.M))
    plain_dispatch = bool(re.search(r'^\s*up\)\s*shift;\s*cmd_up "\$@"\s*;;', text, re.M))
    return {"main_sh": str(main_sh), "functions": funcs,
            "stops_up_on_failure": plain_call and set_e and plain_dispatch,
            "why": {"cmd_up_calls": calls, "set_e": set_e, "plain_dispatch": plain_dispatch}}


def changelog_changesets(spec: dict, source: Path) -> list[dict]:
    """sql/changelog.xml's changeSets as local-dev reads them (its parse_changelog_changesets)."""
    changelog = source / "sql" / "changelog.xml"
    if not changelog.exists():
        return []
    p = subprocess.run([bash_path(), "-c", spec["functions"]["parse_changelog_changesets"]
                        + '\nparse_changelog_changesets "$1"', "localdev-schema", str(changelog)],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        die(f"local-dev's parse_changelog_changesets failed on {changelog}: {p.stderr[-300:]}")
    return [dict(zip(("id", "author", "path"), ln.split("\t"))) for ln in p.stdout.splitlines()
            if ln.count("\t") == 2]


def schema_script(spec: dict, source: Path, container: str, work: Path) -> str:
    body = "\n\n".join(spec["functions"][n] for n in SCHEMA_FUNCTIONS)
    body = body.replace(SCHEMA_PG_LINE, f"local pg={shlex.quote(container)}")
    return ("# GENERATED by sce-e2e/stack/localdev/localdev_stack.py: the schema step of `bin/local-dev.sh up`,\n"
            f"# its functions copied unchanged from {spec['main_sh']},\n"
            f"# except for local-dev's container name texera-postgres, which is {container} here.\n"
            "set -euo pipefail  # as main.sh\n"
            f"REPO_ROOT={shlex.quote(str(source))}\n"
            f"LOG_DIR={shlex.quote(str(work))}  # psql's stderr per changeSet (local-dev's: $STATE_DIR/logs)\n"
            f"{SCHEMA_TUI}\n\n{body}\n\ninfra_ensure_db_schema\n")


def parse_schema_output(stdout: str) -> tuple[list[dict], list[str], str | None, list[str]]:
    """(changeSets it tried, the ones it found already in the schema, the path that failed,
    local-dev's warnings) from the step's messages."""
    attempted, already, failed_path, warnings = [], [], None, []
    for line in stdout.splitlines():
        kind, _, msg = line.partition("\t")
        a_ = re.search(r"applying (\S+) \(changeSet ([^)]+)\)", msg)
        if kind == "tui_step" and a_:
            attempted.append({"id": a_.group(2), "path": a_.group(1)})
        k_ = re.search(r"\(recording changeSet ([^)]+)\)", msg)
        if kind == "tui_skip" and k_:
            already.append(k_.group(1))
        f_ = re.search(r"postgres: (\S+) failed", msg)
        if kind == "tui_err" and f_:
            failed_path = f_.group(1)
        if kind == "tui_warn":
            warnings.append(msg)
    return attempted, already, failed_path, warnings


def run_schema_step(m: dict, source: Path, logs: Path) -> dict:
    """Run local-dev's schema step against this stack's Postgres: `up` runs it right after
    the infrastructure, `build` before jOOQ's codegen (local-dev runs it before any build).
    Returns the outcome; schema_verdict() decides what it means."""
    spec = schema_step_spec(source)
    container = m["containers"]["postgres"]
    work = logs / "local-dev-schema"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    script = work / "schema-step.sh"
    script.write_text(schema_script(spec, source, container, work))
    bash = bash_path()
    log(f"schema: local-dev's step (infra_ensure_db_schema, from {spec['main_sh']}) on {container}")
    t0 = time.time()
    p = subprocess.run([bash, str(script)], cwd=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       text=True, timeout=900)
    secs = round(time.time() - t0, 1)
    (work / "schema-step.log").write_text(p.stdout + (f"--- stderr ---\n{p.stderr}" if p.stderr else ""))
    if p.returncode in (126, 127) or "command not found" in p.stderr:
        die(f"local-dev's schema step could not run here (exit {p.returncode}): {p.stderr[-400:]}\n"
            f"  main.sh's functions may now need helpers the harness does not provide; see {script}")
    attempted, already, failed_path, warnings = parse_schema_output(p.stdout)
    failed = None
    if failed_path:
        fid = next((c["id"] for c in reversed(attempted) if c["path"] == failed_path), None)
        err_f = work / f"psql-changeset-{fid}.err"
        err = err_f.read_text(errors="replace") if fid and err_f.exists() else p.stderr
        failed = {"id": fid, "path": failed_path, "error": err.strip()[-2000:]}
    q = run(["docker", "exec", container, "psql", "-U", "texera", "-d", "texera_db", "-tAc",
             "SELECT id FROM public.databasechangelog ORDER BY orderexecuted"], capture=True, check=False)
    recorded = (q.stdout or "").split() if q.returncode == 0 else []
    changesets = changelog_changesets(spec, source)
    version = subprocess.run([bash, "-c", "echo $BASH_VERSION"], stdout=subprocess.PIPE, text=True).stdout.strip()
    return {
        "at": now_iso(), "seconds": secs, "exit_code": p.returncode, "ok": p.returncode == 0,
        "main_sh": spec["main_sh"], "bash": f"{bash} {version}", "script": str(script),
        "log": str(work / "schema-step.log"),
        "local_dev_stops_up_on_failure": spec["stops_up_on_failure"], "why_it_stops": spec["why"],
        "changesets": len(changesets),
        "applied": [c["id"] for c in attempted if c["id"] not in already and c["path"] != failed_path],
        "already_in_schema": already,
        "failed": failed,
        "recorded": recorded,
        "not_recorded": [c["id"] for c in changesets if c["id"] not in recorded],
        "local_dev_warnings": warnings,
        "messages": [f"{line.partition(chr(9))[0][4:]}: {line.partition(chr(9))[2]}"
                     for line in p.stdout.splitlines() if "\t" in line][-80:],
        "stderr_tail": p.stderr[-1500:],
    }


def schema_verdict(m: dict, s: dict, strict: bool) -> None:
    """What local-dev's `up` does with the schema step's outcome, and what this stack does:
    with --strict-schema it stops where local-dev stops; otherwise it goes on and records
    the deviation (MANIFEST.json `local_dev_deviations`, folded into the report by post-run)."""
    for w in s.get("local_dev_warnings", []):
        warn(m, f"local-dev's schema step warned: {w}")
    if s["ok"]:
        log(f"schema: local-dev's step passed in {s['seconds']}s ({len(s['applied'])} changeSet(s) applied, "
            f"{len(s['already_in_schema'])} already in the schema; {len(s['recorded'])} of {s['changesets']} "
            "recorded)")
        return
    f = s.get("failed") or {}
    text = f.get("error") or s.get("stderr_tail") or ""
    errors = [ln.strip() for ln in text.splitlines() if "ERROR:" in ln]
    err = errors[0] if errors else text.strip()[-300:]
    where = f"changeSet {f['id']} ({f['path']})" if f else f"exit {s['exit_code']}"
    msg = f"local-dev's schema step failed at {where}: {err}"
    if not s["local_dev_stops_up_on_failure"]:
        warn(m, msg + " (local-dev's `up` carries on when this step fails, and so does this stack)")
        return
    if strict:
        die(f"{msg}\n  `bin/local-dev.sh up` stops here too (main.sh runs under `set -e`): no build, no service.\n"
            f"  --strict-schema stops this stack the same way. Script and log: {s['script']}, {s['log']}")
    log(f"WARNING: {msg}")
    log("WARNING: `bin/local-dev.sh up` stops here (main.sh runs under `set -e`), before the build and any "
        "service. This stack goes on (--strict-schema would stop it as local-dev does) and records the "
        "deviation in MANIFEST.json (local_dev_deviations).")
    m.setdefault("local_dev_deviations", []).append({
        "step": "schema (infra_ensure_db_schema, right after infra_up)",
        "local_dev": f"`up` exits after `postgres: {f.get('path')} failed`: no build, no service",
        "harness": ("went on to the build and the services; from the failed changeSet on, none is applied or "
                    "recorded, as local-dev leaves them"),
        "failed_changeset": f.get("id"), "path": f.get("path"), "error": err,
        "not_recorded": s["not_recorded"],
    })


# ---------------------------------------------------------------------- preflight


def all_ports(m: dict) -> dict[str, int]:
    out = {f"{k} (infra)": v for k, v in m["ports"].items() if k in INFRA_PORTS}
    for s in m["services"]:
        out[s["name"]] = s["local_dev_port"]
        for i, extra in enumerate(EXTRA_PORTS.get(s["name"], ())):
            out[f"{s['name']} #{i + 2}"] = extra
    out[FRONTEND] = FRONTEND_PORT
    return out


def check_ports_free(m: dict, only: dict[str, int] | None = None) -> None:
    problems = []
    for label, port in (only or all_ports(m)).items():
        holders = docker_port_holders(port)
        if holders:
            problems.append(f"{port} ({label}) is published by container(s) {', '.join(h[0] for h in holders)}")
        elif port_open(port):
            problems.append(f"{port} ({label}) is in use by {port_holder(port)}")
    if problems:
        die("ports this stack needs are taken (it never stops anything it did not start):\n  "
            + "\n  ".join(problems))


def check_not_running() -> None:
    live = [r["name"] for r in pid_records() if record_alive(r)]
    rows = [r for r in compose_ps() if (r.get("State") or "").lower() == "running"]
    if live or rows:
        die(f"the local-dev stack is already running ({', '.join(live + [r.get('Name', '?') for r in rows])}); "
            "run `localdev-stack.sh down` first")


# ------------------------------------------------------------------------- builds


def newest(source: Path, pattern: str) -> Path | None:
    found = sorted(source.glob(pattern), key=lambda p: p.stat().st_mtime)
    if len(found) > 1:
        log(f"WARNING: several dists match {pattern}; using the newest, {found[-1].name}")
    return found[-1] if found else None


def build_env(m: dict, plugin_dir: str) -> dict[str, str]:
    """sbt's environment: the caller's without Texera configuration, JDK 17 first, the
    betterproto plugin last on PATH (so amber's compile regenerates the Python protobufs),
    and STORAGE_JDBC_* at this stack's Postgres, where jOOQ's codegen reads the schema
    (local-dev builds against its own Postgres the same way)."""
    env = {k: v for k, v in os.environ.items() if not _TEXERA_ENV.match(k)}
    svc_env = json.loads((GEN_DIR / "service.env.json").read_text())
    jh = m["java"]["home"]
    env.update(JAVA_HOME=jh, PATH=f"{jh}/bin:{os.environ.get('PATH', '')}:{plugin_dir}")
    for k in ("STORAGE_JDBC_URL", "STORAGE_JDBC_USERNAME", "STORAGE_JDBC_PASSWORD"):
        env[k] = svc_env[k]
    return env


#: where common/dao's jOOQ codegen writes (gitignored); it reads the schema from Postgres
JOOQ_DIR = "common/dao/src/main/scala/org/apache/texera/dao/jooq/generated"


def jooq_sources(source: Path) -> int:
    d = source / JOOQ_DIR
    return len(list(d.rglob("*.java"))) if d.exists() else 0


def run_sbt(source: Path, m: dict, tasks: list[str], out: Path, timeout: int) -> dict:
    """local-dev's sbt invocation (`-no-colors -J-Xmx4g -J-XX:+UseG1GC`, the heap capped at
    $SCE_LOCALDEV_SBT_HEAP, default 3g), in the source worktree."""
    sbt = shutil.which("sbt")
    if not sbt:
        die("sbt is not on PATH")
    plugin_dir = protoc_plugin_dir(source)
    cmd = [sbt, "-batch", "-no-colors", f"-J-Xmx{SBT_HEAP}", "-J-XX:+UseG1GC", *tasks]
    log(f"sbt {' '.join(cmd[1:])}  (in {source}; log {out})")
    t0 = time.time()
    with out.open("ab") as f:
        p = subprocess.Popen(cmd, cwd=source, env=build_env(m, plugin_dir), stdin=subprocess.DEVNULL,
                             stdout=f, stderr=subprocess.STDOUT, start_new_session=True)
        last = time.time()
        while p.poll() is None:
            if time.time() - t0 > timeout:
                os.killpg(p.pid, signal.SIGTERM)
                p.wait(30)
                die(f"sbt did not finish within {timeout}s; see {out}")
            if time.time() - last > 60:
                log(f"  sbt running {int(time.time() - t0)}s: {tail(out, 1)[:160]}")
                last = time.time()
            time.sleep(5)
    if p.returncode != 0:
        die(f"sbt failed (exit {p.returncode}); last lines:\n{tail(out, 40)}")
    secs = round(time.time() - t0, 1)
    log(f"sbt done in {int(secs)}s")
    return {"command": cmd[1:], "seconds": secs, "log": str(out)}


# --- what a dist was built from. local-dev rebuilds a service when a content hash of its
# sources changed since its last build (and, finding a jar without a hash, assumes the jar
# matches). The harness builds only a missing dist, so it records what each zip it builds
# came from, and `up` refuses a zip that does not match the source as it is now.


def _git(source: Path, *args: str) -> subprocess.CompletedProcess:
    # GIT_OPTIONAL_LOCKS=0: never refresh (and lock) the index of the source worktree
    return subprocess.run(["git", "-C", str(source), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, env=dict(os.environ, GIT_OPTIONAL_LOCKS="0"))


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def is_build_input(rel: str) -> bool:
    """A file `sbt dist` reads: under a JVM project's src/main, or the sbt build definition.
    Not amber's Python tree (the unit runs it from the worktree, not from the dist) and not
    the frontend (ng serve compiles it from source)."""
    if rel.startswith(("frontend/", "amber/src/main/python/")):
        return False
    return "/src/main/" in f"/{rel}" or rel.endswith(".sbt") or rel.startswith("project/")


def build_inputs(source: Path) -> list[str]:
    """The build inputs git knows, tracked or untracked; ignored files (jOOQ's generated
    sources, amber's Python protobufs) are left out."""
    p = _git(source, "ls-files", "-co", "--exclude-standard", "-z")
    if p.returncode != 0:
        die(f"git ls-files failed in {source}: {p.stderr.strip()[:300]}")
    return [r for r in p.stdout.split("\0") if r and is_build_input(r)]


def source_state(source: Path) -> dict:
    """HEAD, and the build inputs with uncommitted changes (tracked or untracked)."""
    head = _git(source, "rev-parse", "HEAD").stdout.strip()
    entries = _git(source, "status", "--porcelain", "-z", "--untracked-files=all").stdout.split("\0")
    changed, i = [], 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        changed.append(entry[3:])
        if "R" in entry[:2] or "C" in entry[:2]:  # -z: a rename or copy names its origin next
            if i < len(entries) and entries[i]:
                changed.append(entries[i])
            i += 1
    inputs = sorted({c for c in changed if is_build_input(c)})
    return {"head": head, "dirty": bool(inputs), "dirty_inputs": inputs[:50]}


def _load_provenance() -> dict:
    try:
        return json.loads(PROVENANCE.read_text())
    except (OSError, ValueError):
        return {}


def zip_record(zip_path: Path) -> dict | None:
    """This harness's build record of `zip_path`, if the file is still the one it built."""
    rec = _load_provenance().get(str(zip_path))
    st = zip_path.stat()
    if rec and rec.get("size") == st.st_size and rec.get("mtime_ns") == st.st_mtime_ns:
        return rec
    return None


def record_provenance(source: Path, zips: list[Path], before: dict, t_start: float) -> dict:
    """After `sbt dist`: what each zip it wrote was built from. HEAD and the uncommitted build
    inputs are read before sbt starts; HEAD moving or a build input modified while sbt ran
    leaves the commit unknown."""
    after = source_state(source)
    during = sorted(r for r in build_inputs(source) if _mtime(source / r) > t_start)
    steady = before["head"] == after["head"] and not during
    data, out = _load_provenance(), {}
    for z in sorted(set(zips)):
        st = z.stat()
        if st.st_mtime < t_start - 1:  # not written by this build: its record (if any) stays
            continue
        rec = {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "source": str(source),
               "head": before["head"] if steady else None, "dirty": before["dirty"],
               "dirty_inputs": before["dirty_inputs"][:20], "built_at": now_iso()}
        if not steady:
            rec["note"] = (f"the source changed while sbt ran (HEAD {before['head'][:10]} -> "
                           f"{after['head'][:10]}; {len(during)} build input(s) modified, e.g. "
                           f"{(during or ['-'])[0]})")
        data[str(z)] = out[str(z)] = rec
    write_json(PROVENANCE, data)
    return out


def dist_provenance(source: Path, zips: list[Path], state: dict) -> tuple[dict, list[str], list[str]]:
    """Per zip: what it was built from, why it is stale for the source as it is now (its record
    names another commit whose build inputs differ, or a build input was modified after the
    zip was written, the check local-dev runs first), and caveats."""
    mtimes = {r: _mtime(source / r) for r in build_inputs(source)}
    info: dict = {}
    stale: list[str] = []
    caveats: list[str] = []
    unrecorded: list[str] = []
    for z in sorted(set(zips)):
        st = z.stat()
        rec = zip_record(z)
        reasons = []
        if rec and not rec.get("head"):
            reasons.append(rec.get("note") or "the source changed while it was built")
        elif rec and rec["head"] != state["head"]:
            d = _git(source, "diff", "--name-only", rec["head"], state["head"], "--")
            if d.returncode != 0:
                reasons.append(f"built from {rec['head'][:10]}, a commit this worktree does not have")
            else:
                changed = [r for r in d.stdout.splitlines() if is_build_input(r)]
                if changed:
                    reasons.append(f"built from {rec['head'][:10]}; {len(changed)} build input(s) differ at "
                                   f"HEAD {state['head'][:10]} (e.g. {changed[0]})")
        newer = sorted(r for r, t in mtimes.items() if t > st.st_mtime)
        if newer:
            reasons.append(f"{len(newer)} build input(s) modified after it was built (e.g. {newer[0]})")
        if rec and rec.get("dirty"):
            caveats.append(f"{z.name} was built with uncommitted changes to {len(rec['dirty_inputs'])} build "
                           f"input(s) (e.g. {rec['dirty_inputs'][0]})")
        if not rec and not reasons:
            unrecorded.append(z.name)
        info[str(z)] = {
            "recorded": bool(rec), "built_from": (rec or {}).get("head"), "built_dirty": (rec or {}).get("dirty"),
            "built_at": (rec or {}).get("built_at")
            or dt.datetime.fromtimestamp(st.st_mtime, dt.timezone.utc).isoformat(timespec="seconds"),
            "inputs_modified_after": len(newer), "stale": reasons}
        stale += [f"{z.name}: {r}" for r in reasons]
    if unrecorded:
        caveats.append(f"no build record for {', '.join(unrecorded)} (built outside this harness, or before it "
                       "recorded builds), so the commit they hold is not recorded; no build input was modified "
                       "after they were written (`build --force` rebuilds them with a record)")
    if state.get("dirty"):
        caveats.append(f"the source has uncommitted changes to {len(state['dirty_inputs'])} build input(s) "
                       f"(e.g. {state['dirty_inputs'][0]})")
    return info, stale, caveats


def build_dists(source: Path, m: dict, logs: Path, force: bool, timeout: int) -> dict:
    zips = {s["name"]: newest(source, s["zip_glob"]) for s in m["services"]}
    missing = sorted(n for n, z in zips.items() if z is None)
    if not missing and not force:
        return {"ran": False, "zips": {n: str(z) for n, z in zips.items()}}
    if not jooq_sources(source) and not port_open(m["ports"]["postgres"]):
        die("jOOQ's codegen needs this stack's Postgres (no generated sources yet): run `up`, or "
            "`build` (it starts Postgres for the codegen; hold the stack lock)")
    log(f"building the dists ({', '.join(missing) or 'forced'})")
    projects = sorted({s["sbt"] for s in m["services"]})
    before = source_state(source)
    t0 = time.time()
    info = run_sbt(source, m, [f"{p}/dist" for p in projects], logs / "sbt-dist.log", timeout)
    zips = {s["name"]: newest(source, s["zip_glob"]) for s in m["services"]}
    still = sorted(n for n, z in zips.items() if z is None)
    if still:
        die(f"sbt dist finished but these dists are still missing: {still}")
    recorded = record_provenance(source, [z for z in zips.values() if z], before, t0)
    log(f"recorded what {len(recorded)} dist zip(s) were built from: {before['head'][:10]}"
        f"{' with uncommitted changes' if before['dirty'] else ''} ({PROVENANCE})")
    return {"ran": True, **info, "projects": projects, "missing_before": missing,
            "jooq_sources": jooq_sources(source), "zips": {n: str(z) for n, z in zips.items()},
            "provenance": recorded}


def ensure_protos(source: Path, logs: Path) -> dict:
    """amber's generated Python protobufs (gitignored; sbt writes them while compiling amber
    when the betterproto plugin is on PATH, otherwise bin/python-proto-gen.sh does)."""
    out = source / "amber" / "src" / "main" / "python" / "proto"
    files = list(out.rglob("*.py")) if out.exists() else []
    if files:
        return {"generated_now": False, "files": len(files)}
    plugin_dir = protoc_plugin_dir(source)
    if not shutil.which("protoc"):
        die("protoc is not on PATH (brew install protobuf)")
    log_f = logs / "python-proto-gen.log"
    log(f"generating amber's Python protobufs with bin/python-proto-gen.sh (log: {log_f})")
    env = dict(os.environ, PATH=f"{os.environ.get('PATH', '')}:{plugin_dir}")
    with log_f.open("wb") as f:
        p = subprocess.run(["bash", str(source / "bin" / "python-proto-gen.sh")], cwd=source, env=env,
                           stdout=f, stderr=subprocess.STDOUT)
    files = list(out.rglob("*.py")) if out.exists() else []
    if p.returncode != 0 or not files:
        die(f"bin/python-proto-gen.sh failed (exit {p.returncode}):\n{tail(log_f)}")
    return {"generated_now": True, "files": len(files), "plugin": plugin_dir}


def ensure_node_modules(source: Path, node: str, logs: Path) -> dict:
    fe = source / "frontend"
    state = fe / "node_modules" / ".yarn-state.yml"
    if state.exists() and state.stat().st_mtime >= (fe / "yarn.lock").stat().st_mtime:
        return {"installed_now": False}
    yarn = sorted((fe / ".yarn" / "releases").glob("yarn-*.cjs"))
    if not yarn:
        die(f"no {fe}/.yarn/releases/yarn-*.cjs")
    log_f = logs / "yarn-install.log"
    log(f"frontend: yarn install --immutable (node 24; log: {log_f})")
    t0 = time.time()
    env = dict(os.environ, PATH=f"{Path(node).parent}:{os.environ.get('PATH', '')}")
    with log_f.open("wb") as f:
        p = subprocess.run([node, str(yarn[-1]), "install", "--immutable"], cwd=fe, env=env,
                           stdout=f, stderr=subprocess.STDOUT)
    if p.returncode != 0:
        die(f"yarn install --immutable failed:\n{tail(log_f)}")
    return {"installed_now": True, "seconds": round(time.time() - t0, 1)}


def unzip_dist(zip_path: Path) -> Path:
    """The zip's top directory under .state/localdev/dist, re-extracted when the zip changes."""
    st = zip_path.stat()
    mark = f"{zip_path}:{st.st_size}:{st.st_mtime_ns}"
    dest = DIST_DIR / zip_path.stem
    stamp_f = dest / ".sce-zip"
    if stamp_f.exists() and stamp_f.read_text() == mark:
        return dest
    if dest.exists():
        shutil.rmtree(dest)
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(dir=DIST_DIR, prefix=".unzip-"))
    try:
        run(["unzip", "-q", str(zip_path), "-d", str(tmp)], capture=True)
        tops = list(tmp.iterdir())
        top = tops[0] if len(tops) == 1 and tops[0].is_dir() else tmp
        top.rename(dest)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not (dest / "bin").is_dir() or not (dest / "lib").is_dir():
        die(f"{zip_path} has no bin/ and lib/")
    stamp_f.write_text(mark)
    return dest


# ---------------------------------------------------------------------- processes


def ps_lstart(pid: int) -> str:
    p = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, text=True)
    return p.stdout.strip()


def pid_records() -> list[dict]:
    if not PID_DIR.exists():
        return []
    out = []
    for f in sorted(PID_DIR.glob("*.json")):
        try:
            out.append(json.loads(f.read_text()))
        except (OSError, ValueError):
            pass
    return out


def record_alive(rec: dict) -> bool:
    """The process of a pid file still runs (and is the one we started, not a reused pid)."""
    pid = int(rec.get("pid", 0))
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return False
    return ps_lstart(pid) == rec.get("lstart")


def group_members(pgid: int) -> list[int]:
    """The live members of a process group (a zombie, dead but not yet reaped, is not one)."""
    p = subprocess.run(["ps", "-axo", "pid=,pgid=,stat="], stdout=subprocess.PIPE, text=True)
    rows = (ln.split() for ln in p.stdout.splitlines() if ln.strip())
    return [int(r[0]) for r in rows if len(r) >= 3 and int(r[1]) == pgid and not r[2].startswith("Z")]


def pid_running(pid: int) -> bool:
    """`pid` exists and is not a zombie."""
    p = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, text=True)
    return bool(p.stdout.strip()) and not p.stdout.strip().startswith("Z")


def start_process(name: str, cmd: list[str], cwd: Path, env: dict, log_path: Path) -> subprocess.Popen:
    PID_DIR.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as f:
        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=f,
                             stderr=subprocess.STDOUT, start_new_session=True)
    # started_ns orders the stop (newest first): the JVMs start within the same second
    rec = {"name": name, "pid": p.pid, "pgid": os.getpgid(p.pid), "lstart": ps_lstart(p.pid),
           "started_at": now_iso(), "started_ns": time.time_ns(), "cmd": cmd, "cwd": str(cwd),
           "log": str(log_path), "java_opts": env.get("JAVA_OPTS")}
    write_json(PID_DIR / f"{name}.json", rec)
    return p


def pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop_group(rec: dict, grace: float = 20) -> str:
    """SIGTERM the process group of a pid file (then SIGKILL after `grace`), only when it is
    ours: its leader is the process we started, or the leader is gone and members remain
    (a pid is never reused while its process group exists, so those are ours too)."""
    pgid = int(rec.get("pgid") or rec["pid"])
    if pgid <= 1:
        return "not running"
    if not record_alive(rec):
        if pid_exists(pgid):
            return "not running (its pid now belongs to another process; left alone)"
        if not group_members(pgid):
            return "not running"
        # the leader is gone but its group (e.g. Python workers) is not: still ours
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):  # EPERM: only zombies left in the group
        return "not running"
    deadline = time.time() + grace
    while time.time() < deadline and group_members(pgid):
        time.sleep(0.5)
    if group_members(pgid):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        time.sleep(1)
        return "killed (SIGKILL after SIGTERM)"
    return "stopped"


def process_cwd(pid: int) -> str:
    out = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True).stdout
    m = re.search(r"^n(.*)$", out, re.M)
    return m.group(1) if m else ""


def listener_pids(port: int) -> list[int]:
    p = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, text=True)
    return sorted({int(x) for x in p.stdout.split() if x.isdigit()})


#: the Angular CLI renames its process (bin/ng.js: `process.title = 'ng ' + args`; ps shows
#: `ng serve (gui)` here), so the dev server's command line no longer names the CLI
_NG_TITLE = re.compile(r"^ng(\s|$)")


def _maybe_stack_process(cmd: str) -> bool:
    return (str(DIST_DIR) in cmd or bool(_NG_TITLE.match(cmd)) or "@angular/cli/bin/ng" in cmd
            or "esbuild" in cmd or "texera_run_python_worker" in cmd)


def stack_process_kind(cmd: str, cwd: str, source: str | None) -> str | None:
    """Which process of this stack `cmd` (ps's command column) running in `cwd` is, or None.
    The JVMs run a dist under .state/localdev/dist; the dev server (under the CLI's title) and
    its esbuild run in the source's frontend/; the unit's Python workers run
    texera_run_python_worker in the source's amber/."""
    if str(DIST_DIR) in cmd:
        return "service"
    if not source:
        return None
    if cwd == f"{source}/{FRONTEND}" and (_NG_TITLE.match(cmd) or "@angular/cli/bin/ng" in cmd or "esbuild" in cmd):
        return FRONTEND
    if cwd == f"{source}/amber" and "texera_run_python_worker" in cmd:
        return "python worker"
    return None


def orphan_processes(source: str | None) -> list[tuple[int, int, str]]:
    """Processes of an earlier `up` whose pid files are gone (stack_process_kind), and
    whoever listens on the dev server's port from the source's frontend/. The source
    worktree is the harness's own, so a dev server there is this stack's."""
    p = subprocess.run(["ps", "-axo", "pid=,pgid=,command="], stdout=subprocess.PIPE, text=True)
    rows: dict[int, tuple[int, str]] = {}
    for line in p.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            rows[int(parts[0])] = (int(parts[1]), parts[2])
    out = []
    for pid, (pgid, cmd) in rows.items():
        if pid == os.getpid() or not _maybe_stack_process(cmd):
            continue
        cwd = "" if str(DIST_DIR) in cmd else process_cwd(pid)
        if stack_process_kind(cmd, cwd, source):
            out.append((pid, pgid, cmd))
    if source:
        found = {o[0] for o in out}
        for pid in listener_pids(FRONTEND_PORT):
            if pid in rows and pid not in found and process_cwd(pid) == f"{source}/{FRONTEND}":
                out.append((pid, rows[pid][0], rows[pid][1]))
    return out


def stop_pid(pid: int, grace: float = 20) -> str:
    """SIGTERM one process (then SIGKILL after `grace`)."""
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return "not running"
    deadline = time.time() + grace
    while time.time() < deadline and pid_running(pid):
        time.sleep(0.5)
    if pid_running(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        return "killed (SIGKILL after SIGTERM)"
    return "stopped"


def stop_orphans(source: str | None) -> list[str]:
    """Stop what orphan_processes finds: its whole process group when the group is this
    stack's (the process leads it, the leader is gone, or the leader is a leftover too);
    otherwise only the process."""
    orphans = orphan_processes(source)
    ours = {pid for pid, _g, _c in orphans}
    done = []
    for pid, pgid, cmd in orphans:
        if not pid_running(pid):
            continue
        if pgid == pid or pgid in ours or not pid_exists(pgid):
            outcome = stop_group({"pid": pid, "pgid": pgid, "lstart": ps_lstart(pid)})
        else:
            outcome = stop_pid(pid) + f" (alone: its process group {pgid} is not this stack's)"
        done.append(f"leftover pid {pid} ({cmd[:80]}): {outcome}")
    return done


# --------------------------------------------------------------------------- up


def service_env(m: dict, py: Path) -> dict[str, str]:
    """What local-dev hands its JVMs, and nothing from the caller's environment but the
    basics of a login shell."""
    env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL")
           if k in os.environ}
    env.setdefault("LANG", "en_US.UTF-8")  # a developer's terminal; JDK 17 reads the charset from it
    jh = m["java"]["home"]
    env.update(json.loads((GEN_DIR / "service.env.json").read_text()))
    env.update(JAVA_HOME=jh, PATH=f"{jh}/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOST_LAN_IP=m["lan_ip"],
               UDF_PYTHON_PATH=str(py), TERM="dumb")
    return env


def record_options(fast_record: bool) -> dict:
    """What --fast-record asks for, as MANIFEST.json's `options` records it: exports for the
    unit's JVM and for the Dashboard's, set before each starts."""
    unit_env = fast_record_env("unit") if fast_record else {}
    dashboard_env = fast_record_env("dashboard") if fast_record else {}
    return {"fast_record": fast_record, "unit_env": unit_env, "dashboard_env": dashboard_env,
            "record_timing": record_timing(unit_env, dashboard_env)}


def launch_env(m: dict, svc: dict, base: dict[str, str]) -> dict[str, str]:
    """The environment one JVM service starts with: local-dev's (`base`), its heap, and the
    exports the stack options add for the unit and for the Dashboard."""
    options = m.get("options") or {}
    extra = {UNIT_SERVICE: options.get("unit_env"), DASHBOARD_SERVICE: options.get("dashboard_env")}
    return dict(base, JAVA_OPTS=svc["java_opts"], **(extra.get(svc["name"]) or {}))


def ready(svc: dict) -> tuple[bool, str]:
    port = svc["local_dev_port"]
    if not port_open(port):
        return False, f"nothing on {port} yet"
    checks = []
    if svc.get("local_dev_health"):
        checks.append((port, svc["local_dev_health"]))
    if svc["name"] in HARNESS_HEALTH:
        checks.append(HARNESS_HEALTH[svc["name"]])
    for p, path in checks:
        status, _, body = http_get(f"http://127.0.0.1:{p}{path}")
        if status != 200:
            return False, f"GET :{p}{path} -> {status or body[:80]}"
    return True, "ok"


def parse_heaps(items: list[str]) -> dict[str, str]:
    heaps = dict(DEFAULT_HEAPS)
    for item in items or []:
        name, sep, size = item.partition("=")
        if not sep or not re.fullmatch(r"\d+[mMgG]", size):
            die(f"--heap takes NAME=SIZE (e.g. texera-web=2g or all=1g), got {item!r}")
        if name == "all":
            heaps = {k: size for k in heaps}
        elif name in heaps:
            heaps[name] = size
        else:
            die(f"--heap: unknown service {name!r}; known: {', '.join(heaps)}")
    return heaps


def frontend_heap(source: Path, override: str | None) -> str:
    if override:
        return override
    start = json.loads((source / FRONTEND / "package.json").read_text()).get("scripts", {}).get("start", "")
    m = re.search(r"--max-old-space-size=(\d+)", start)
    return m.group(1) if m else "8192"


def cmd_generate(a) -> dict:
    lan = a.lan_ip or detect_lan_ip()
    m = generate(a.source, lan)
    log(f"generated {GEN_DIR} from {m['source']} @ {m['source_git'].get('head', '')[:10]} "
        f"({'dirty' if m['source_git'].get('dirty') else 'clean'}); S3 endpoint {m['s3_endpoint']}")
    log(f"infra: {', '.join(m['infra_services'])}; services: {', '.join(s['name'] for s in m['services'])}")
    return m


def infra_up(m: dict, timeout: int, only: list[str] | None = None) -> float:
    args = ["up", "-d", "--remove-orphans"]
    if only:
        args = ["up", "-d", *only]
    log(f"docker compose {' '.join(args)} (project {PROJECT})")
    compose(*args)
    return wait_infra(m["infra_services"], timeout, only)


def wait_postgres_initialized(m: dict, timeout: int = 120) -> None:
    """Postgres past its first-start init (sql/ run): only the final server listens on TCP;
    the entrypoint's temporary one, which the pg_isready healthcheck may already pass, listens
    on the Unix socket alone."""
    container = m["containers"]["postgres"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        p = run(["docker", "exec", container, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "texera",
                 "-d", "texera_db", "-q"], check=False, capture=True)
        if p.returncode == 0:
            return
        time.sleep(1)
    die(f"Postgres ({container}) does not accept TCP connections after {timeout}s")


def schema_step(m: dict, source: Path, logs: Path, strict: bool) -> dict:
    """local-dev's schema step and its verdict, recorded in the manifest before the verdict
    can stop anything."""
    wait_postgres_initialized(m)
    s = run_schema_step(m, source, logs)
    m["schema"] = s
    write_json(MANIFEST, m)
    schema_verdict(m, s, strict)
    write_json(MANIFEST, m)
    return s


def lakekeeper_warehouses(port: int) -> list[dict]:
    status, _, body = http_get(f"http://127.0.0.1:{port}/management/v1/warehouse", timeout=10)
    if status != 200:
        return []
    try:
        return [{"name": w.get("name"), "endpoint": (w.get("storage-profile") or {}).get("endpoint"),
                 "bucket": (w.get("storage-profile") or {}).get("bucket")}
                for w in json.loads(body).get("warehouses", [])]
    except ValueError:
        return []


def cmd_build(a) -> None:
    """The dists, in two phases. 1. jOOQ's codegen reads the schema from Postgres, so when
    its generated sources are missing (or --force), this stack's Postgres is started alone
    (Docker: hold the stack lock), `sbt DAO/compile` runs against it, and the Postgres is
    removed again. 2. `sbt <services>/dist` (no Docker: with Postgres gone the codegen fails
    fast and keeps the generated sources, as common/dao/build.sbt intends). `--codegen-only`
    stops after 1, so the long phase 2 can run without the lock."""
    check_not_running()  # a running stack's `up` builds what it misses itself
    m = cmd_generate(a)
    m["java"] = java_home()
    write_json(MANIFEST, m)
    logs = Path(a.logs or REPORTS / f"localdev-build-{stamp()}-logs").resolve()
    logs.mkdir(parents=True, exist_ok=True)
    out: dict = {"logs": str(logs)}
    if a.force or not jooq_sources(a.source):
        check_ports_free(m, only={"postgres (infra)": m["ports"]["postgres"]})
        infra_up(m, a.timeout, only=["postgres"])
        try:
            # local-dev reconciles the schema before any build (ensure_postgres_for_build)
            out["schema"] = schema_step(m, a.source, logs, a.strict_schema)
            out["local_dev_deviations"] = m.get("local_dev_deviations", [])
            out["codegen"] = run_sbt(a.source, m, ["DAO/compile"], logs / "sbt-codegen.log", a.build_timeout)
        finally:
            log("removing the Postgres started for the codegen")
            compose("down", "--remove-orphans", check=False)
        if not jooq_sources(a.source):
            die(f"`sbt DAO/compile` generated no jOOQ sources under {JOOQ_DIR}; see {logs / 'sbt-codegen.log'}")
        log(f"jOOQ: {jooq_sources(a.source)} generated sources")
    else:
        log(f"jOOQ: {jooq_sources(a.source)} generated sources already there (--force regenerates)")
    if a.codegen_only:
        write_json(logs / "build.json", out)
        return
    out["dist"] = build_dists(a.source, m, logs, a.force, a.build_timeout)
    out["protos"] = ensure_protos(a.source, logs)
    write_json(logs / "build.json", out)
    log(f"build: dists {'built' if out['dist']['ran'] else 'all present (--force rebuilds)'}; "
        f"Python protobufs: {out['protos']}")


def cmd_up(a) -> None:
    t_start = time.time()
    if not a.source.exists():
        die(f"--source {a.source} does not exist")
    check_not_running()
    m = cmd_generate(a)
    m["java"] = java_home()
    m["node"] = node24()
    py = resolve_python(a.python)
    m["python"] = check_python(py, a.source)
    if m["python"]["requirements_mismatches"]:
        m.setdefault("warnings", []).append(
            f"the UDF Python differs from amber/requirements.txt: {'; '.join(m['python']['requirements_mismatches'])}")
    heaps = parse_heaps(a.heap)
    m["heaps"] = heaps
    m["options"] = record_options(a.fast_record)
    m["frontend_heap_mb"] = frontend_heap(a.source, a.frontend_heap)
    check_ports_free(m)  # before anything is written or started
    # dists that do not match the source are refused before anything starts (missing ones are
    # built below and checked again)
    m["source_state"] = state = source_state(a.source)
    present = [z for z in (newest(a.source, s["zip_glob"]) for s in m["services"]) if z]
    _info, stale, _caveats = dist_provenance(a.source, present, state)
    if stale and not a.allow_stale_dists:
        die("dist zips that do not match the source (`stack/localdev-stack.sh build --force` rebuilds them; "
            "--allow-stale-dists runs them anyway):\n  " + "\n  ".join(stale))
    logs = Path(a.logs or REPORTS / f"localdev-{stamp()}-logs").resolve()
    logs.mkdir(parents=True, exist_ok=True)
    m["logs_dir"] = str(logs)
    write_json(MANIFEST, m)
    timings: dict[str, float] = {}

    # 1. infrastructure (local-dev's `infra_up`)
    timings["infra_s"] = infra_up(m, a.timeout)
    warehouses = lakekeeper_warehouses(m["ports"]["lakekeeper"])
    m["lakekeeper_warehouses"] = warehouses
    default_wh = next((w for w in warehouses if w["name"] == "texera"), None)
    if not default_wh or str(default_wh["endpoint"] or "").rstrip("/") != m["s3_endpoint"]:
        die(f"Lakekeeper's default warehouse does not use {m['s3_endpoint']}: {warehouses}")
    s3_status, _, s3_body = http_get(f"{m['s3_endpoint']}/health")
    if s3_status != 200:
        die(f"RustFS does not answer at the LAN endpoint {m['s3_endpoint']}/health: {s3_status or s3_body}")

    # 2. the schema (local-dev's `infra_ensure_db_schema`, right after `infra_up`)
    t0 = time.time()
    schema_step(m, a.source, logs, a.strict_schema)
    timings["schema_s"] = round(time.time() - t0, 1)

    # 3. builds, only what is missing (local-dev rebuilds what changed: see dist_provenance)
    t0 = time.time()
    m["build"] = build_dists(a.source, m, logs, False, a.build_timeout)
    m["protos"] = ensure_protos(a.source, logs)
    m["node_modules"] = ensure_node_modules(a.source, m["node"]["node"], logs)
    timings["build_s"] = round(time.time() - t0, 1)
    zips = {s["name"]: newest(a.source, s["zip_glob"]) for s in m["services"]}
    provenance, stale, caveats = dist_provenance(a.source, list(zips.values()), state)
    if stale:
        if not a.allow_stale_dists:
            die("dist zips that do not match the source:\n  " + "\n  ".join(stale))
        for line in stale:
            warn(m, f"a stale dist runs on purpose (--allow-stale-dists): {line}")
    for line in caveats:
        warn(m, line)
    m["dist_provenance"] = provenance

    # 4. the JVM services, in local-dev's order, from the unzipped dists
    env = service_env(m, py)
    procs: dict[str, subprocess.Popen] = {}
    t0 = time.time()
    for svc in m["services"]:
        zip_path = zips[svc["name"]]
        dist = unzip_dist(zip_path)
        launcher = dist / svc["launcher"]
        if not os.access(launcher, os.X_OK):
            die(f"{svc['name']}: no launcher {launcher}")
        svc.update(zip=str(zip_path), zip_provenance=provenance[str(zip_path)],
                   dist=str(dist), launcher_path=str(launcher),
                   java_opts=f"-Xmx{heaps[svc['name']]} -XX:+ExitOnOutOfMemoryError")
        senv = launch_env(m, svc, env)
        if svc["name"] == UNIT_SERVICE:
            m["unit_env_names"] = sorted(senv)
        procs[svc["name"]] = start_process(svc["name"], [str(launcher)], a.source / svc["cwd"], senv,
                                           logs / f"{svc['name']}.log")
        log(f"started {svc['name']} (pid {procs[svc['name']].pid}, cwd {svc['cwd']}, {svc['java_opts']})")
    write_json(MANIFEST, m)
    pending = {s["name"]: s for s in m["services"]}
    ready_at: dict[str, float] = {}
    last_report = 0.0
    while pending:
        for name, svc in list(pending.items()):
            if procs[name].poll() is not None:
                die(f"{name} exited with {procs[name].returncode} while starting; last log lines:\n"
                    f"{tail(logs / f'{name}.log')}")
            ok, why = ready(svc)
            svc["last_check"] = why
            if ok:
                ready_at[name] = round(time.time() - t0, 1)
                del pending[name]
                log(f"{name} ready after {ready_at[name]}s")
        if not pending:
            break
        if time.time() - t0 > a.timeout:
            die("services not ready after {}s: {}".format(
                a.timeout, "; ".join(f"{n}: {s['last_check']}" for n, s in pending.items())))
        if time.time() - last_report > 20:
            log("waiting for " + ", ".join(f"{n} ({s['last_check']})" for n, s in pending.items()))
            last_report = time.time()
        time.sleep(2)
    timings["services_s"] = round(time.time() - t0, 1)
    m["ready_after_s"] = ready_at

    # 5. the Angular dev server (`yarn start`'s ng serve, proxy.config.json)
    node = m["node"]["node"]
    fenv = dict(env, PATH=f"{Path(node).parent}:{env['PATH']}", NG_CLI_ANALYTICS="false")
    fenv.pop("JAVA_OPTS", None)
    t0 = time.time()
    cmd = [node, f"--max-old-space-size={m['frontend_heap_mb']}", NG, "serve"]
    fp = start_process(FRONTEND, cmd, a.source / FRONTEND, fenv, logs / f"{FRONTEND}.log")
    log(f"started the Angular dev server (pid {fp.pid}): {' '.join(cmd[1:])}")
    checks: dict = {}
    while True:
        if fp.poll() is not None:
            die(f"ng serve exited with {fp.returncode}; last log lines:\n{tail(logs / f'{FRONTEND}.log')}")
        status, ctype, body = http_get(f"{FRONTEND_URL}/", timeout=10)
        if status == 200 and "<texera-root" in body:
            checks["index"] = {"status": status, "content_type": ctype,
                               "title": (re.search(r"<title>([^<]*)</title>", body) or [None, None])[1]}
            break
        if time.time() - t0 > a.frontend_timeout:
            die(f"the dev server did not serve the app within {a.frontend_timeout}s; last log lines:\n"
                f"{tail(logs / f'{FRONTEND}.log')}")
        time.sleep(3)
    timings["frontend_s"] = round(time.time() - t0, 1)
    # what a browser loads first: the dashboard's health and config-service's anonymous config
    for label, path in (("dashboard /api/healthcheck", "/api/healthcheck"),
                        ("config-service /api/config/pre-login", "/api/config/pre-login")):
        status, _, body = http_get(f"{FRONTEND_URL}{path}", timeout=15)
        checks[label] = status
        if status != 200:
            die(f"through the dev server's proxy, GET {path} -> {status or body[:200]}")
    m["frontend_checks"] = checks
    m["listening"] = check_listeners(m)
    timings["total_s"] = round(time.time() - t_start, 1)
    m["up"] = {"at": now_iso(), "timings": timings,
               "pids": {r["name"]: r["pid"] for r in pid_records()}}
    write_json(MANIFEST, m)
    shutil.copy2(MANIFEST, logs / "MANIFEST.json")
    log(f"local-dev stack is up in {timings['total_s']}s: {FRONTEND_URL} (dev server, proxy.config.json); "
        f"logs {logs}")
    for d in m.get("local_dev_deviations", []):
        log(f"DEVIATION from bin/local-dev.sh: {d['step']}: {d['error']} ({d['harness']})")


def expected_ports(m: dict) -> dict[str, set[int]]:
    out = {s["name"]: {s["local_dev_port"], *EXTRA_PORTS.get(s["name"], ())} for s in m["services"]}
    out[FRONTEND] = {FRONTEND_PORT}
    return out


def listening_ports(pgid: int) -> list[int]:
    """The TCP ports a process group listens on."""
    members = group_members(pgid)
    if not members:
        return []
    p = subprocess.run(["lsof", "-nP", "-a", "-p", ",".join(map(str, members)), "-iTCP", "-sTCP:LISTEN", "-Fn"],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    return sorted({int(x) for x in re.findall(r"^n.*:(\d+)$", p.stdout, re.M)})


def check_listeners(m: dict) -> dict[str, list[int]]:
    """What each process of the stack listens on, against the ports the pre-flight check
    reserves for it: anything else would be a port `up` cannot see taken beforehand."""
    expected = expected_ports(m)
    seen = {}
    for rec in pid_records():
        ports = listening_ports(int(rec.get("pgid") or rec["pid"]))
        seen[rec["name"]] = ports
        want = expected.get(rec["name"], set())
        extra, absent = sorted(set(ports) - want), sorted(want - set(ports))
        if extra:
            warn(m, f"{rec['name']} also listens on {extra}, which the pre-flight port check does not cover")
        if absent:
            warn(m, f"{rec['name']} does not listen on {absent}, which the pre-flight port check reserves for it")
    return seen


# ------------------------------------------------------------------------- down


def collect_infra_logs(dest: Path) -> list[str]:
    rows = compose_ps()
    if not rows:
        return []
    out_dir = dest / "infra"
    out_dir.mkdir(parents=True, exist_ok=True)
    names = []
    for r in rows:
        svc = r.get("Service")
        if not svc:
            continue
        p = run(["docker", "logs", "--timestamps", r.get("Name", "")], capture=True, check=False)
        (out_dir / f"{svc}.log").write_text((p.stdout or "") + (p.stderr or ""))
        names.append(svc)
    return names


def stop_order(recs: list[dict]) -> list[dict]:
    """Newest first: the dev server, then the services in reverse start order (started_ns;
    pid files of an older harness have only started_at, to the second)."""
    return sorted(recs, key=lambda r: (r.get("started_ns") or 0, r.get("started_at", "")), reverse=True)


def stop_processes(source: str | None) -> list[str]:
    done = []
    for rec in stop_order(pid_records()):
        outcome = stop_group(rec)
        done.append(f"{rec['name']}: {outcome}")
        (PID_DIR / f"{rec['name']}.json").unlink(missing_ok=True)
    return done + stop_orphans(source)


def cmd_down(a, volumes: bool = False) -> None:
    m = load_manifest(required=False)
    source = m.get("source") or str(a.source)
    logs = Path(m["logs_dir"]) if m.get("logs_dir") else None
    if logs and logs.exists() and not getattr(a, "no_collect", False):
        collected = collect_infra_logs(logs)
        if collected:
            log(f"infra logs saved to {logs / 'infra'}")
    for line in stop_processes(source):
        log(line)
    args = ["down", "--remove-orphans"] + (["--volumes"] if volumes else [])
    compose(*args, check=False)
    if volumes:
        p = run(["docker", "volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={PROJECT}"],
                capture=True, check=False)
        for v in (p.stdout or "").split():
            if v.startswith(VOLUME_PREFIX):
                run(["docker", "volume", "rm", v], check=False, capture=True)
    # what must be gone now
    problems = []
    if [r for r in compose_ps()]:
        problems.append("containers of the project remain")
    if run(["docker", "network", "inspect", NETWORK], check=False, capture=True).returncode == 0:
        problems.append(f"network {NETWORK} remains")
    left = orphan_processes(source)
    if left:
        problems.append("processes of the stack remain: "
                        + "; ".join(f"pid {pid} ({cmd[:80]})" for pid, _g, cmd in left))
    if problems:
        die("down left things behind: " + "; ".join(problems))
    if m and m.get("services"):
        busy = [f"{port} ({label}: {port_holder(port)})" for label, port in all_ports(m).items()
                if port_open(port)]
        if busy:  # not ours (ours are gone): someone else took a port after `up`
            log("WARNING: ports of this stack still answer, held by other processes: " + ", ".join(busy))
    log("local-dev stack is down" + (" (volumes removed)" if volumes else " (volumes kept)"))


# ------------------------------------------------------------------ status / logs


def service_states(m: dict) -> list[dict]:
    recs = {r["name"]: r for r in pid_records()}
    rows = []
    for svc in m.get("services", []) + [{"name": FRONTEND, "local_dev_port": FRONTEND_PORT}]:
        rec = recs.get(svc["name"], {})
        alive = bool(rec) and record_alive(rec)
        if svc["name"] == FRONTEND:
            status, _, body = http_get(f"{FRONTEND_URL}/", timeout=10) if alive else (None, "", "")
            health = "ok" if status == 200 and "<texera-root" in body else (status or "-")
        else:
            health = ready(svc)[1] if alive else "-"
        rows.append({"name": svc["name"], "pid": rec.get("pid"), "alive": alive,
                     "port": svc["local_dev_port"], "health": health, "log": rec.get("log")})
    return rows


def cmd_status(a) -> None:
    m = load_manifest(required=False)
    if not m:
        log("not generated yet")
        return
    rows = service_states(m)
    infra = compose_ps()
    if a.json:
        print(json.dumps({"manifest": m, "services": rows, "infra": infra}, indent=2, default=str))
        return
    src = m.get("source_git", {})
    print(f"source : {m['source']} @ {src.get('head', '')[:10]} ({src.get('branch')})"
          f"{' dirty' if src.get('dirty') else ''}")
    print(f"infra  : project {PROJECT}, network {NETWORK}; S3 endpoint {m['s3_endpoint']}")
    print(f"logs   : {m.get('logs_dir', '-')}")
    s = m.get("schema")
    if s:
        f = s.get("failed") or {}
        print(f"schema : local-dev's step {'passed' if s['ok'] else 'FAILED at changeSet ' + str(f.get('id'))}"
              f" ({len(s['recorded'])} of {s['changesets']} changeSets recorded)")
    for d in m.get("local_dev_deviations", []):
        print(f"DEVIATION from bin/local-dev.sh: {d['step']}: {d['error']}")
    for w in m.get("warnings", []):
        print(f"warning: {w}")
    print(f"{'INFRA SERVICE':22} {'CONTAINER':40} {'STATE':10} HEALTH")
    for r in sorted(infra, key=lambda r: r.get("Service", "")):
        print(f"{r.get('Service', ''):22} {r.get('Name', ''):40} {r.get('State', ''):10} {r.get('Health') or '-'}")
    if not infra:
        print("(no containers)")
    print(f"\n{'SERVICE':34} {'PID':>7} {'PORT':>6}  HEALTH")
    for r in rows:
        print(f"{r['name']:34} {str(r['pid'] or '-'):>7} {r['port']:>6}  "
              f"{'ok' if r['health'] == 'ok' else r['health'] if r['alive'] else 'not running'}")


def cmd_logs(a) -> None:
    m = load_manifest()
    name = LOG_ALIASES.get(a.service, a.service)
    rec = next((r for r in pid_records() if r["name"] == name), None)
    log_path = Path(rec["log"]) if rec else (Path(m["logs_dir"]) / f"{name}.log" if m.get("logs_dir") else None)
    if log_path and log_path.exists():
        cmd = ["tail", "-n", str(a.tail)] + (["-F"] if a.follow else []) + [str(log_path)]
        os.execvp("tail", cmd)
    if name in m.get("infra_services", []):
        args = ["logs", "--no-color", "--tail", str(a.tail)] + (["-f"] if a.follow else []) + [name]
        os.execvpe("docker", compose_cmd(*args), compose_env())
    die(f"unknown service {a.service!r}; services: "
        f"{', '.join([s['name'] for s in m.get('services', [])] + [FRONTEND] + m.get('infra_services', []))}"
        f" (aliases: {', '.join(sorted(LOG_ALIASES))})")


def cmd_collect_logs(a) -> None:
    dest = Path(a.dir)
    dest.mkdir(parents=True, exist_ok=True)
    names = collect_infra_logs(dest)
    log(f"infra logs of {', '.join(names) or 'nothing'} saved to {dest / 'infra'}")


def cmd_post_run(a) -> None:
    """After a driver run: every service still alive and healthy. Folded into the report."""
    m = load_manifest()
    rows = service_states(m)
    dead = [r["name"] for r in rows if not r["alive"]]
    unhealthy = [f"{r['name']}: {r['health']}" for r in rows if r["alive"] and r["health"] != "ok"]
    unit = next((r for r in pid_records() if r["name"] == "computing-unit-master"), None)
    workers = []
    if unit and record_alive(unit):
        p = subprocess.run(["ps", "-axo", "pid=,pgid=,command="], stdout=subprocess.PIPE, text=True)
        workers = [ln.strip()[:160] for ln in p.stdout.splitlines()
                   if ln.split() and int(ln.split()[1]) == unit["pgid"] and "texera_run_python_worker" in ln]
    deviations = m.get("local_dev_deviations") or []
    warnings = m.get("warnings") or []
    post = {"at": now_iso(), "ok": not dead and not unhealthy, "dead": dead, "unhealthy": unhealthy,
            "services": rows, "python_workers_left": workers,
            "local_dev_deviations": deviations, "warnings": warnings}
    report_path = Path(a.report)
    if report_path.exists():
        report = json.loads(report_path.read_text())
        report["post_run"] = post
        summ = report.setdefault("summary", {})
        if not post["ok"]:
            summ["result"] = "FAIL"
            summ["post_run_failures"] = dead + unhealthy
        # what this run did differently from bin/local-dev.sh, next to the result (which they
        # do not change: the scenarios ran on the stack as described)
        summ["local_dev_deviations"] = [f"{d['step']}: {d['error']}" for d in deviations]
        summ["warnings"] = warnings
        write_json(report_path, report)
    if a.out:
        write_json(Path(a.out), post)
    log(f"post-run: {'ok' if post['ok'] else 'FAIL'} (dead: {dead or '-'}; unhealthy: {unhealthy or '-'}; "
        f"Python workers left: {len(workers)})")
    for d in deviations:
        log(f"DEVIATION from bin/local-dev.sh: {d['step']}: {d['error']}; local-dev: {d['local_dev']}; "
            f"this stack: {d['harness']}")
    for w in warnings:
        log(f"warning: {w}")
    if not post["ok"]:
        sys.exit(4)


# ------------------------------------------- what the driver's StackControl asks

#: `unit-stop` gives the unit's JVM this long to stop by itself, as `docker stop -t 20` does
UNIT_STOP_GRACE_S = 20


def unit_record() -> dict:
    """The pid file of the unit's JVM; its process group holds its Python workers."""
    rec = next((r for r in pid_records() if r["name"] == UNIT_SERVICE), None)
    if rec is None:
        die(f"no pid file of {UNIT_SERVICE}: is the stack up?")
    return rec


def wait_gone(alive, timeout: float) -> float | None:
    """Seconds until `alive()` is false, or None when it still is after `timeout`."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if not alive():
            return round(time.time() - t0, 1)
        time.sleep(0.2)
    return None


def cmd_unit_kill(a) -> None:
    """kill -9 the unit's JVM and its Python workers, as when its machine is lost."""
    rec = unit_record()
    if not record_alive(rec):
        die(f"{UNIT_SERVICE} (pid {rec['pid']}) is not running")
    pgid = int(rec["pgid"])
    killed = len(group_members(pgid))
    os.killpg(pgid, signal.SIGKILL)
    gone = wait_gone(lambda: bool(group_members(pgid)), 10)
    if gone is None:
        die(f"processes of group {pgid} are still there 10 s after SIGKILL")
    print(json.dumps({"how": "kill -9", "pid": rec["pid"], "processes": killed, "seconds": gone}))


def cmd_unit_stop(a) -> None:
    """SIGTERM to the unit's JVM alone, as `docker stop` and a pod's deletion signal a
    container's main process, so the JVM stops its own workers. What is left of its process
    group after the grace period is killed."""
    rec = unit_record()
    if not record_alive(rec):
        die(f"{UNIT_SERVICE} (pid {rec['pid']}) is not running")
    pid, pgid = int(rec["pid"]), int(rec["pgid"])
    os.kill(pid, signal.SIGTERM)
    exited = wait_gone(lambda: pid_running(pid), UNIT_STOP_GRACE_S)
    left = group_members(pgid)
    if left:
        os.killpg(pgid, signal.SIGKILL)
        wait_gone(lambda: bool(group_members(pgid)), 10)
    print(json.dumps({"how": "SIGTERM", "pid": pid, "exited_after_s": exited,
                      "killed_after_the_grace_period": len(left)}))


def cmd_unit_start(a) -> None:
    """Start the unit's JVM again as `up` started it (same launcher, working directory,
    environment and log), and wait until it answers."""
    m = load_manifest()
    svc = next(s for s in m["services"] if s["name"] == UNIT_SERVICE)
    if record_alive(unit_record()):
        die(f"{UNIT_SERVICE} is already running")
    env = launch_env(m, svc, service_env(m, Path(m["python"]["executable"])))
    t0 = time.time()
    proc = start_process(UNIT_SERVICE, [svc["launcher_path"]], Path(m["source"]) / svc["cwd"], env,
                         Path(m["logs_dir"]) / f"{UNIT_SERVICE}.log")
    while not ready(svc)[0]:
        if proc.poll() is not None:
            die(f"{UNIT_SERVICE} exited with {proc.returncode} while starting; last log lines:\n"
                f"{tail(Path(m['logs_dir']) / f'{UNIT_SERVICE}.log')}")
        if time.time() - t0 > a.timeout:
            die(f"{UNIT_SERVICE} is not ready after {a.timeout}s: {ready(svc)[1]}")
        time.sleep(1)
    m["unit_env_names"] = sorted(env)
    m.setdefault("up", {}).setdefault("pids", {})[UNIT_SERVICE] = proc.pid
    write_json(MANIFEST, m)
    print(json.dumps({"pid": proc.pid, "ready_after_s": round(time.time() - t0, 1)}))


def cmd_pg_activity(a) -> None:
    """Postgres's client connections. Every JVM of this stack reaches Postgres through the
    same published port, so they are told apart by application name, not by address."""
    container = load_manifest()["containers"]["postgres"]
    p = run(["docker", "exec", container, "psql", "-U", "texera", "-d", "texera_db", *pg_activity.PSQL_ARGS],
            capture=True, timeout=60)
    print(json.dumps(pg_activity.parse(p.stdout)))


def cmd_venv(a) -> None:
    """A Python 3.11 venv with amber's requirements at .state/localdev/py311 (uv)."""
    if not shutil.which("uv"):
        die("uv is not on PATH (brew install uv)")
    venv = OWN_PY311.parent.parent
    reqs = [a.source / "amber" / "requirements.txt"]
    if a.with_operator_requirements:
        reqs.append(a.source / "amber" / "operator-requirements.txt")
    if not OWN_PY311.exists():
        run(["uv", "venv", "--quiet", "--python", "3.11", str(venv)])
    cmd = ["uv", "pip", "install", "--quiet", "--python", str(OWN_PY311)]
    for r in reqs:
        cmd += ["-r", str(r)]
    run(cmd)
    info = check_python(OWN_PY311, a.source)
    log(f"{OWN_PY311}: Python {info['version']}; mismatches: {info['requirements_mismatches'] or 'none'}")


def main() -> None:
    ap = argparse.ArgumentParser(prog="localdev-stack.sh",
                                 description="Texera as bin/local-dev.sh runs it, isolated (project e2e-localdev).")
    ap.add_argument("--source", type=Path, default=DEFAULT_SOURCE,
                    help="Texera worktree to build and run (default %(default)s or $SCE_LOCALDEV_SOURCE)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def gen_args(p):
        p.add_argument("--lan-ip", help="host LAN IP for the RustFS endpoint (default: local-dev's detection, "
                                        "or $HOST_LAN_IP)")

    def schema_args(p):
        p.add_argument("--strict-schema", action="store_true",
                       default=os.environ.get("SCE_LOCALDEV_STRICT_SCHEMA", "") not in ("", "0"),
                       help="stop where `bin/local-dev.sh up` stops when local-dev's schema step fails "
                            "(default: go on and record the deviation; $SCE_LOCALDEV_STRICT_SCHEMA=1)")

    p = sub.add_parser("generate", help="write stack/localdev/generated/ from the source worktree")
    gen_args(p)
    p = sub.add_parser("build", help="sbt dist in the source worktree when a dist zip is missing "
                                     "(starts this stack's Postgres alone for jOOQ's codegen when needed)")
    gen_args(p)
    schema_args(p)
    p.add_argument("--force", action="store_true", help="regenerate jOOQ (Postgres: hold the lock) and rebuild "
                                                        "even when every zip exists")
    p.add_argument("--codegen-only", action="store_true",
                   help="only the jOOQ codegen (the Docker part); run `build` again without the lock for the dists")
    p.add_argument("--logs", help="directory for sbt-dist.log (default reports/localdev-build-<time>-logs)")
    p.add_argument("--timeout", type=int, default=300, help="seconds to wait for Postgres")
    p.add_argument("--build-timeout", type=int, default=3000, help="seconds sbt may take")
    p = sub.add_parser("up", help="infra, local-dev's schema step, missing builds, the JVM services and ng "
                                  "serve; wait until ready")
    gen_args(p)
    schema_args(p)
    p.add_argument("--allow-stale-dists", action="store_true",
                   help="run dist zips that do not match the source (recorded as warnings) instead of refusing")
    p.add_argument("--fast-record", action="store_true",
                   help="step 3's timers shortened, as exports before the unit's and the Dashboard's JVM "
                        "start: the unit commits every 2 s; the Dashboard closes every 2 s, loses a unit "
                        "after 12 s, an unstarted execution after 15 s, and expires results after 20 s")
    p.add_argument("--python", help="interpreter for Python UDF workers (UDF_PYTHON_PATH); default "
                                    "$SCE_LOCALDEV_PYTHON, .state/localdev/py311, or the step-1 py311 venv")
    p.add_argument("--heap", action="append", default=[], metavar="NAME=SIZE",
                   help="-Xmx of a service (repeatable; all=SIZE for every one). Defaults: "
                        + ", ".join(f"{k} {v}" for k, v in DEFAULT_HEAPS.items()))
    p.add_argument("--frontend-heap", help="node --max-old-space-size in MB (default: `yarn start`'s)")
    p.add_argument("--logs", help="directory for the service logs (default reports/localdev-<time>-logs)")
    p.add_argument("--timeout", type=int, default=int(os.environ.get("SCE_LOCALDEV_UP_TIMEOUT", "600")),
                   help="seconds for the infrastructure, and again for the JVM services")
    p.add_argument("--frontend-timeout", type=int, default=600, help="seconds for ng serve's first compile")
    p.add_argument("--build-timeout", type=int, default=3000, help="seconds sbt may take when a dist is missing")
    p = sub.add_parser("down", help="stop the processes, remove the containers and the network; keep volumes")
    p.add_argument("--no-collect", action="store_true", help="do not save the infra logs first")
    p = sub.add_parser("reset", help="down, then remove this project's volumes")
    p.add_argument("--no-collect", action="store_true", help="do not save the infra logs first")
    p = sub.add_parser("status", help="containers, processes, health")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("logs", help="a service's log (JVM, frontend or infra)")
    p.add_argument("service")
    p.add_argument("--tail", type=int, default=200)
    p.add_argument("-f", "--follow", action="store_true")
    p = sub.add_parser("collect-logs", help="save the infra containers' logs under <dir>/infra")
    p.add_argument("dir")
    p = sub.add_parser("post-run", help="after a driver run: every service alive and healthy")
    p.add_argument("report")
    p.add_argument("--out")
    p = sub.add_parser("venv", help="build .state/localdev/py311 (Python 3.11, amber's requirements) with uv")
    p.add_argument("--with-operator-requirements", action="store_true")
    sub.add_parser("unit-kill", help="kill -9 the unit's JVM and its Python workers (JSON)")
    sub.add_parser("unit-stop", help="SIGTERM the unit's JVM and wait for it to stop (JSON)")
    p = sub.add_parser("unit-start", help="start the unit's JVM again as `up` did, and wait until it answers (JSON)")
    p.add_argument("--timeout", type=int, default=240, help="seconds the unit may take to answer")
    sub.add_parser("pg-activity", help="Postgres's client connections, from pg_stat_activity (JSON)")

    a = ap.parse_args()
    a.source = a.source.expanduser().resolve()
    if a.cmd == "reset":
        cmd_down(a, volumes=True)
        return
    {"generate": cmd_generate, "build": cmd_build, "up": cmd_up, "down": cmd_down, "status": cmd_status,
     "logs": cmd_logs, "collect-logs": cmd_collect_logs, "post-run": cmd_post_run, "venv": cmd_venv,
     "unit-kill": cmd_unit_kill, "unit-stop": cmd_unit_stop, "unit-start": cmd_unit_start,
     "pg-activity": cmd_pg_activity}[a.cmd](a)


if __name__ == "__main__":
    main()
