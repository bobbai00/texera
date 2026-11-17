#!/usr/bin/env python3
"""Deploy Texera into OrbStack Kubernetes from a worktree's Helm chart, for the e2e driver.

The source of truth is a Texera worktree's bin/k8s chart. `generate` copies it into
stack/k8s/generated/chart/ (symlinks dereferenced, so the chart's files/*.sql come along),
resolves the subchart dependencies there with `helm dependency update` (the repository's
Chart.lock is out of sync with Chart.yaml, so `helm dependency build` -- what
bin/k8s/install.sh runs -- fails), and writes a values override file that points every
Texera image, the computing-unit image included, at --images.

`up` checks the cluster's CRDs against the chart's, installs the chart as Helm release
`texera` in a dedicated namespace (default `sce-k8s`, units in `sce-k8s-units`), waits until
every workload is ready, forwards the Envoy gateway to 127.0.0.1:<port>, checks each backend
answers through it and that ext-authz refuses unit websockets without valid credentials.
`down` uninstalls the release and deletes both namespaces (and with them any unit pod)
plus the cluster-scoped hook objects the chart leaves behind (not the CRDs). `post-run`
checks a driver run's leftovers and refusal probes and folds the outcome into its report.
`unit-kill`, `unit-stop`, `unit-env` and `pg-activity` are what the driver's StackControl
(driver/stack_control.py) asks of this stack; each prints one JSON document.

Commands: generate | up | down | status | logs | port-forward | collect-logs | follow-units | post-run |
unit-kill | unit-stop | unit-env | pg-activity.
Everything runs against the kube context `orbstack` (SCE_K8S_CONTEXT); nothing outside
the two namespaces and this release's cluster-scoped objects is ever changed.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "lib"))

import pg_activity  # noqa: E402
from record_env import fast_record_env, record_timing  # noqa: E402

GEN_DIR = HERE / "generated"
CHART_DIR = GEN_DIR / "chart"
DEPS_CACHE = GEN_DIR / "deps-cache"
RUN_DIR = GEN_DIR / "run"
VALUES_FILE = GEN_DIR / "values-sce.yaml"
RENDERED = GEN_DIR / "rendered.yaml"
MANIFEST = GEN_DIR / "MANIFEST.json"
PF_PID = RUN_DIR / "port-forward.pid"
PF_LOG = RUN_DIR / "port-forward.log"

DEFAULT_SOURCE = Path("/Users/jiadongb/Desktop/projects/texera-worktrees/self-contained-engine")
CONTEXT = os.environ.get("SCE_K8S_CONTEXT", "orbstack")
DEFAULT_NAMESPACE = os.environ.get("SCE_K8S_NAMESPACE", "sce-k8s")
DEFAULT_PORT = int(os.environ.get("SCE_K8S_PORT", "30080"))
DEFAULT_FORWARD = os.environ.get("SCE_K8S_FORWARD", "relay")
RELAY = HERE / "gateway_relay.py"
# Apple-signed, so macOS lets it reach the cluster's 192.168.x.x addresses (see host_reaches).
RELAY_PYTHON = os.environ.get("SCE_K8S_RELAY_PYTHON", "/usr/bin/python3")
DEFAULT_REGISTRY = "ghcr.io/apache"
DEFAULT_TAG = "latest"

# The chart hard-codes `texera-` names: the dynamic HTTPRoute points at the Backend
# `texera-dynamic-backend` (the Backend itself is `<release>-dynamic-backend`), and the
# lakeFS values carry `texera-postgresql` and `texera-rustfs-svc`. Any other release
# name renders a gateway that cannot route to a unit.
RELEASE = "texera"
GATEWAY_NAME = f"{RELEASE}-gateway"

# Texera images the chart deploys (texera.imageRegistry/<name>:texera.imageTag), the
# computing-unit image included (the managing service launches it as KUBERNETES_IMAGE_NAME).
TEXERA_IMAGES = [
    "texera-dashboard-service",
    "texera-file-service",
    "texera-config-service",
    "texera-access-control-service",
    "texera-workflow-compiling-service",
    "texera-workflow-computing-unit-managing-service",
    "texera-workflow-execution-coordinator",
]

# Workloads `up` does not wait for: always rendered (no condition in the chart), not on a
# workflow run's path, and pulled from Docker Hub with pullPolicy Always.
OPTIONAL_WORKLOADS = {f"{RELEASE}-y-websocket-server", f"{RELEASE}-python-language-server"}
REQUIRED_JOBS = {f"{RELEASE}-lakefs-setup-job", f"{RELEASE}-lakekeeper-init"}
FATAL_WAITING = {"ErrImageNeverPull", "InvalidImageName", "CreateContainerConfigError"}
PULL_WAITING = {"ErrImagePull", "ImagePullBackOff"}
# The chart starts every service at once and none waits for Postgres, so the JVM services
# and lakeFS crash ("Connection to texera-postgresql:5432 refused") until it is up: 3 or 4
# restarts each on a normal `up`. A crash loop therefore counts only once Postgres is Ready.
POSTGRES_STS = f"{RELEASE}-postgresql"
CRASHES_AFTER_DB_READY = 3   # more restarts of a container after Postgres became Ready
CRASHES_FATAL_DB = 6         # Postgres itself

# Requests through the gateway that ext-authz must refuse (Envoy's `ext_authz_denied`):
# (name, credential, cuid). No unit exists yet, so cuid 1 is routable only with a token
# that has access to it; 999999 is a unit nobody has access to. `valid` is a login token.
AUTHZ_PROBES = (
    ("no-token", None, 1),
    ("bogus-token", "sce-e2e-not-a-token", 1),
    ("unit-without-access", "valid", 999999),
)
REFUSED = (401, 403)
EXT_AUTHZ_DENIED = "ext_authz_denied"
#: the chart's HTTPRoute whose rules send a request to a computing unit's pod (Envoy's
#: `route_name` of a request holds the name of the HTTPRoute that matched it)
UNIT_ROUTE = f"{RELEASE}-dynamic-routes"

# Through the gateway: any answer but Envoy's own 502/503/504 proves the route reaches a
# live backend (401/404/405 come from the service).
GATEWAY_PROBES = [
    ("/api/healthcheck", "webserver (dashboard-service)", {200}),
    ("/api/config/gui", "config-service", None),
    ("/api/computing-unit", "computing-unit-managing-service", None),
    ("/api/dataset/list", "file-service", None),
    ("/api/compile", "workflow-compiling-service", None),
]

# Unit pods (labels set by computing-unit-managing-service's KubernetesClient).
UNIT_SELECTOR = "type=computing-unit"
UNIT_CONTAINER = "computing-unit-master"

LOG_ALIASES = {
    "dashboard": f"deploy/{RELEASE}-webserver",
    "webserver": f"deploy/{RELEASE}-webserver",
    "cu-manager": f"deploy/{RELEASE}-workflow-computing-unit-manager",
    "compiler": f"deploy/{RELEASE}-workflow-compiling-service",
    "files": f"deploy/{RELEASE}-file-service",
    "config": f"deploy/{RELEASE}-config-service",
    "access": f"deploy/{RELEASE}-access-control-service",
    "auth": f"deploy/{RELEASE}-access-control-service",
    "envoy-gateway": "deploy/envoy-gateway",
    "lakekeeper": f"deploy/{RELEASE}-lakekeeper",
    "lakefs": f"deploy/{RELEASE}-lakefs",
    "rustfs": f"deploy/{RELEASE}-rustfs",
    "postgres": f"sts/{RELEASE}-postgresql",
    "metrics-server": f"deploy/{RELEASE}-metrics-server",
}


# --------------------------------------------------------------------------- utils


def log(msg: str) -> None:
    print(f"[k8s-stack] {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"[k8s-stack] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def run(cmd: list[str], check: bool = True, capture: bool = False, timeout: float | None = None,
        **kw) -> subprocess.CompletedProcess:
    if capture:
        kw.setdefault("stdout", subprocess.PIPE)
        kw.setdefault("stderr", subprocess.PIPE)
        kw.setdefault("text", True)
    try:
        proc = subprocess.run(cmd, timeout=timeout, **kw)
    except subprocess.TimeoutExpired:
        if check:
            die(f"command timed out after {timeout}s: {' '.join(cmd)}")
        return subprocess.CompletedProcess(cmd, 124, "", f"timed out after {timeout}s")
    if check and proc.returncode != 0:
        detail = ""
        if capture:
            detail = f"\n{(proc.stdout or '')[-4000:]}{(proc.stderr or '')[-4000:]}"
        die(f"command failed ({proc.returncode}): {' '.join(cmd)}{detail}")
    return proc


def kubectl(*args: str, ns: str | None = None, **kw) -> subprocess.CompletedProcess:
    cmd = ["kubectl", "--context", CONTEXT]
    if ns:
        cmd += ["-n", ns]
    return run(cmd + list(args), **kw)


def kjson(*args: str, ns: str | None = None, check: bool = True) -> dict:
    p = kubectl(*args, "-o", "json", ns=ns, check=check, capture=True, timeout=60)
    if p.returncode != 0:
        return {}
    return json.loads(p.stdout or "{}")


def helm(*args: str, ns: str | None = None, **kw) -> subprocess.CompletedProcess:
    cmd = ["helm", "--kube-context", CONTEXT]
    if ns:
        cmd += ["-n", ns]
    return run(cmd + list(args), **kw)


def git_info(source: Path) -> dict:
    # GIT_OPTIONAL_LOCKS=0: never refresh (and lock) the index of a worktree someone else
    # may be committing in.
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")

    def g(*args: str) -> str:
        p = subprocess.run(["git", "-C", str(source), *args], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True, env=env)
        return p.stdout.strip() if p.returncode == 0 else ""

    return {
        "head": g("rev-parse", "HEAD"),
        "branch": g("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(g("status", "--porcelain", "--untracked-files=no", "--", "bin/k8s", "sql")),
    }


def parse_images(spec: str | None) -> tuple[str, str]:
    """`<registry>/<tag>` or `<registry>:<tag>` -> (registry, tag); same rules as sce_stack.py."""
    if not spec:
        return DEFAULT_REGISTRY, DEFAULT_TAG
    last_slash = spec.rfind("/")
    colon = spec.rfind(":")
    if colon > last_slash:
        registry, tag = spec[:colon], spec[colon + 1:]
    elif last_slash > 0:
        registry, tag = spec[:last_slash], spec[last_slash + 1:]
    else:
        die(f"--images must look like <registry>/<tag> (e.g. sce/step1), got '{spec}'")
    if not registry or not tag:
        die(f"--images must look like <registry>/<tag>, got '{spec}'")
    return registry, tag


def is_local_registry(registry: str) -> bool:
    """`sce` (images/build.sh) exists only in the local Docker store: never try to pull it.
    A registry host has a dot or a port (ghcr.io, localhost:5000)."""
    host = registry.split("/")[0]
    return not ("." in host or ":" in host or host == "localhost")


def docker_image_id(image: str) -> str | None:
    p = run(["docker", "image", "inspect", "--format", "{{.Id}}", image], check=False, capture=True)
    return p.stdout.strip() if p.returncode == 0 else None


def unit_namespace(ns: str) -> str:
    return f"{ns}-units"


def http_status(url: str, timeout: float = 5) -> tuple[int | None, str]:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(300).decode(errors="replace")
    except urllib.error.HTTPError as e:
        try:
            body = e.read(300).decode(errors="replace")
        except Exception:  # noqa: BLE001
            body = ""
        return e.code, body
    except (urllib.error.URLError, OSError, ValueError) as e:
        return None, str(e)


def listening(addr: str, port: int) -> bool:
    family = socket.AF_INET6 if ":" in addr else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as c:
            c.settimeout(1)
            return c.connect_ex((addr, port)) == 0
    except OSError:
        return False


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, default=str) + "\n")
    tmp.replace(path)


def load_manifest() -> dict:
    if not MANIFEST.exists():
        return {}
    return json.loads(MANIFEST.read_text())


# ------------------------------------------------------------------------ generate


def _copy_chart(source: Path) -> Path:
    src = source / "bin" / "k8s"
    for f in ("Chart.yaml", "values.yaml", "templates"):
        if not (src / f).exists():
            die(f"source worktree has no Helm chart at {src} (missing {f})")
    if CHART_DIR.exists():
        shutil.rmtree(CHART_DIR)
    # symlinks=False dereferences files/*.sql -> ../../../sql/*.sql (the DDL the
    # postgres init script embeds). charts/ is never copied: it is resolved below.
    shutil.copytree(src, CHART_DIR, symlinks=False,
                    ignore=shutil.ignore_patterns("charts", "*.tgz", ".DS_Store"))
    return src


def _resolve_dependencies() -> dict:
    """charts/*.tgz for the copy's Chart.yaml, from a cache keyed by its dependency list.

    The repository's Chart.lock still lists minio (Chart.yaml moved to rustfs), so
    `helm dependency build` refuses it; `helm dependency update` writes a fresh lock."""
    chart = yaml.safe_load((CHART_DIR / "Chart.yaml").read_text())
    deps = chart.get("dependencies") or []
    key = hashlib.sha256(json.dumps(deps, sort_keys=True).encode()).hexdigest()[:16]
    repo_lock = CHART_DIR / "Chart.lock"
    repo_lock_deps = []
    if repo_lock.exists():
        repo_lock_deps = [d.get("name") for d in (yaml.safe_load(repo_lock.read_text()) or {})
                          .get("dependencies") or []]
        repo_lock.unlink()
    cache = DEPS_CACHE / key
    if (cache / "Chart.lock").exists() and any((cache / "charts").glob("*.tgz")):
        shutil.copytree(cache / "charts", CHART_DIR / "charts")
        shutil.copy2(cache / "Chart.lock", CHART_DIR / "Chart.lock")
        source = f"cache {cache.relative_to(HERE)}"
    else:
        log("helm dependency update (fetching subcharts; cached afterwards)")
        run(["helm", "dependency", "update", str(CHART_DIR)], capture=True, timeout=600)
        if cache.exists():
            shutil.rmtree(cache)
        cache.mkdir(parents=True)
        shutil.copytree(CHART_DIR / "charts", cache / "charts")
        shutil.copy2(CHART_DIR / "Chart.lock", cache / "Chart.lock")
        source = "helm dependency update"
    lock = yaml.safe_load((CHART_DIR / "Chart.lock").read_text())
    return {
        "resolved_by": source,
        "chart_yaml_dependencies": [f"{d['name']}@{d['version']}" for d in deps],
        "repository_chart_lock_dependencies": repo_lock_deps,
        "lock": [f"{d['name']}@{d['version']}" for d in lock.get("dependencies") or []],
        "lock_digest": lock.get("digest"),
    }


def _set_env(env: list[dict], name: str, value: str) -> None:
    for e in env:
        if e.get("name") == name:
            e["value"] = value
            return
    env.append({"name": name, "value": value})


def _rendered_docs() -> list[dict]:
    return [d for d in yaml.safe_load_all(RENDERED.read_text()) if d]


def _containers(doc: dict) -> list[dict]:
    spec = (((doc.get("spec") or {}).get("template") or {}).get("spec")) or {}
    if doc.get("kind") == "Pod":
        spec = doc.get("spec") or {}
    return list(spec.get("initContainers") or []) + list(spec.get("containers") or [])


def workload_with_image(docs: list[dict], image: str) -> dict | None:
    """The rendered Deployment or StatefulSet that runs `image` (found by image, not by
    template path or name, so a renamed or moved template is still found)."""
    for d in docs:
        if d.get("kind") in ("Deployment", "StatefulSet") and any(c.get("image") == image
                                                                  for c in _containers(d)):
            return d
    return None


def env_names(workload: dict, docs: list[dict]) -> set[str]:
    """Every environment variable name the workload's containers get: `env`, and the keys of
    the rendered ConfigMaps and Secrets they take through `envFrom`."""
    sources = {(d.get("kind"), (d.get("metadata") or {}).get("name")): d for d in docs
               if d.get("kind") in ("ConfigMap", "Secret")}
    names: set[str] = set()
    for c in _containers(workload):
        names.update(e.get("name") for e in c.get("env") or [] if e.get("name"))
        for src in c.get("envFrom") or []:
            for kind, key in (("ConfigMap", "configMapRef"), ("Secret", "secretRef")):
                d = sources.get((kind, (src.get(key) or {}).get("name")))
                if d:
                    keys = list(d.get("data") or {}) + list(d.get("stringData") or {})
                    names.update(f"{src.get('prefix', '')}{k}" for k in keys)
    return names


def record_options(fast_record: bool) -> dict:
    """What --fast-record asks for, as MANIFEST.json's `options` records it. Both lists go into
    `texeraEnvVars`, which reaches every Texera service: the webserver (the Dashboard service)
    reads its own, and the managing service forwards the unit's commit interval to the unit
    pods it creates (step 3's sub-part 6 on)."""
    unit_env = fast_record_env("unit") if fast_record else {}
    dashboard_env = fast_record_env("dashboard") if fast_record else {}
    return {"fast_record": fast_record, "unit_env": unit_env, "dashboard_env": dashboard_env,
            "record_timing": record_timing(unit_env, dashboard_env)}


def missing_record_env(docs: list[dict], registry: str, tag: str, options: dict) -> list[str]:
    """The --fast-record variables that the rendered chart does not give the service that
    reads them: the webserver its own, the managing service the unit's (to forward)."""
    missing = []
    for image, wanted in (("texera-dashboard-service", options["dashboard_env"]),
                          ("texera-workflow-computing-unit-managing-service", options["unit_env"])):
        workload = workload_with_image(docs, f"{registry}/{image}:{tag}")
        have = env_names(workload, docs) if workload else set()
        missing += [f"{name} ({image})" for name in wanted if name not in have]
    return missing


def generate(source: Path, registry: str, tag: str, ns: str, port: int, profile: str,
             workarounds: bool, metrics_server: bool = True, fast_record: bool = False) -> dict:
    GEN_DIR.mkdir(parents=True, exist_ok=True)
    chart_src = _copy_chart(source)
    deps = _resolve_dependencies()
    chart_meta = yaml.safe_load((CHART_DIR / "Chart.yaml").read_text())

    base_values = yaml.safe_load((CHART_DIR / "values.yaml").read_text()) or {}
    values_files = []
    profile_values: dict = {}
    if profile == "development":
        f = CHART_DIR / "values-development.yaml"
        if not f.exists():
            die(f"{chart_src} has no values-development.yaml; use --profile default")
        profile_values = yaml.safe_load(f.read_text()) or {}
        values_files.append(f)

    pull_policy = "Never" if is_local_registry(registry) else "IfNotPresent"
    applied: list[dict] = []

    # texeraEnvVars is a list, which Helm replaces wholesale: start from the profile's
    # (or the chart's) list and change entries in place.
    env = [dict(e) for e in (profile_values.get("texeraEnvVars")
                             or base_values.get("texeraEnvVars") or [])]
    _set_env(env, "KUBERNETES_IMAGE_PULL_POLICY", pull_policy)
    # agent-service is not deployed (below), so the workspace must not offer the copilot.
    _set_env(env, "GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED", "false")
    options = record_options(fast_record)
    for name, value in {**options["unit_env"], **options["dashboard_env"]}.items():
        _set_env(env, name, value)

    s3_endpoint = (base_values.get("storage") or {}).get("s3", {}).get("endpoint") \
        or f"http://{RELEASE}-rustfs-svc:9000"

    overrides = {
        "texera": {"imageRegistry": registry, "imageTag": tag},
        "texeraImages": {"pullPolicy": pull_policy},
        # Not on a workflow run's path; the example loader's image is not built locally.
        "exampleDataLoader": {"enabled": False},
        "agentService": {"enabled": False},
        "litellm": {"enabled": False},
        "notebookMigrationService": {"enabled": False},
        "workflowComputingUnitPool": {"namespace": unit_namespace(ns)},
        "metrics-server": {"enabled": bool(metrics_server)},
        "texeraEnvVars": env,
    }
    header = (f"# GENERATED by sce-e2e/stack/k8s/k8s_stack.py -- do not edit.\n"
              f"# layered after: {', '.join(str(v.relative_to(CHART_DIR)) for v in values_files) or 'values.yaml'}\n")

    def render() -> list[dict]:
        VALUES_FILE.write_text(header + yaml.safe_dump(overrides, sort_keys=False, width=1000))
        p = run(["helm", "template", RELEASE, str(CHART_DIR), "-n", ns,
                 *sum((["-f", str(v)] for v in values_files + [VALUES_FILE]), [])], capture=True, timeout=120)
        RENDERED.write_text(p.stdout)
        return _rendered_docs()

    docs = render()
    # Whether the webserver gets an S3 endpoint is read from the rendered Deployment that runs
    # the dashboard image (its env and envFrom), not from a template's text.
    dashboard_image = f"{registry}/texera-dashboard-service:{tag}"
    webserver = workload_with_image(docs, dashboard_image)
    webserver_s3 = webserver is not None and "STORAGE_S3_ENDPOINT" in env_names(webserver, docs)
    if webserver is None:
        log(f"warning: no rendered Deployment runs {dashboard_image}; the S3 workaround is not applied")
    elif workarounds and not webserver_s3:
        # The webserver Deployment sets no STORAGE_S3_*, so the dashboard creates per-user
        # Lakekeeper warehouses (POST /api/warehouse) against storage.conf's default
        # http://localhost:9000 and Lakekeeper rejects them. The chart's other S3 defaults
        # (region us-west-2, texera_rustfs/password) already match storage.conf, so the
        # endpoint is the only value missing. texeraEnvVars is the only values hook that
        # reaches the webserver; it reaches every service, so file-service and the manager
        # get the same endpoint a second time (same value).
        _set_env(env, "STORAGE_S3_ENDPOINT", s3_endpoint)
        applied.append({
            "name": "webserver-s3-endpoint",
            "upstream_bug": True,
            "detail": f"the rendered {webserver['metadata']['name']} Deployment sets no STORAGE_S3_ENDPOINT "
                      "(env or envFrom); POST /api/warehouse fails. Added STORAGE_S3_ENDPOINT="
                      + s3_endpoint + " through texeraEnvVars (Step 2 sub-part 7 fixes it; the step1 "
                      "chart does not have the fix).",
        })
        docs = render()
    values_files.append(VALUES_FILE)
    not_given = missing_record_env(docs, registry, tag, options)
    if not_given:
        die("--fast-record: the rendered chart does not hand these to the service that reads them "
            "(texeraEnvVars no longer reaches it?): " + ", ".join(not_given))

    # Server-side apply (Helm 4's default) rejects a container listing an env name twice.
    duplicates = {}
    images: set[str] = set()
    unit_image = None
    for d in docs:
        if "test" in ((d.get("metadata") or {}).get("annotations") or {}).get("helm.sh/hook", ""):
            continue  # `helm test` pods are never installed
        for c in _containers(d):
            if c.get("image"):
                images.add(str(c["image"]))
            names = [e.get("name") for e in c.get("env") or []]
            dup = sorted({n for n in names if names.count(n) > 1})
            if dup:
                duplicates[f"{d['kind']}/{d['metadata']['name']}/{c['name']}"] = dup
            for e in c.get("env") or []:
                if e.get("name") == "KUBERNETES_IMAGE_NAME":
                    unit_image = e.get("value")
    server_side = not duplicates
    if duplicates:
        applied.append({
            "name": "client-side-apply",
            "upstream_bug": False,
            "detail": "helm install --server-side=false: the rendered chart lists an env name twice in "
                      f"{sorted(duplicates)} and server-side apply rejects duplicate list keys.",
        })
    if unit_image:
        images.add(unit_image)

    texera = {f"{registry}/{name}:{tag}" for name in TEXERA_IMAGES}
    missing_texera = [i for i in sorted(texera) if not docker_image_id(i)]
    if missing_texera:
        die("these images are not in the local Docker store (OrbStack's cluster uses it; "
            "build them with images/build.sh or pull them):\n  " + "\n  ".join(missing_texera))
    wrong_unit = unit_image != f"{registry}/texera-workflow-execution-coordinator:{tag}"
    if wrong_unit:
        die(f"the managing service would launch units from {unit_image!r}, not {registry}/"
            f"texera-workflow-execution-coordinator:{tag}")
    third_party_missing = sorted(i for i in images if i not in texera and not docker_image_id(i))

    manifest = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "mode": "kubernetes",
        "source": str(source),
        "chart_source": str(chart_src),
        "source_git": git_info(source),
        "chart": {"name": chart_meta.get("name"), "version": chart_meta.get("version"),
                  "dependencies": deps},
        "context": CONTEXT,
        "release": RELEASE,
        "namespace": ns,
        "unit_namespace": unit_namespace(ns),
        "values_profile": profile,
        "values_files": [str(v) for v in values_files],
        "options": options,
        "images": {
            "registry": registry,
            "tag": tag,
            "pull_policy": pull_policy,
            "texera": {i: docker_image_id(i) for i in sorted(texera)},
            "unit_image": unit_image,
            "third_party_not_local": third_party_missing,
        },
        "metrics_server_from_chart": bool(metrics_server),
        "apply": "server-side" if server_side else "client-side",
        "webserver": {"workload": (webserver or {}).get("metadata", {}).get("name"),
                      "s3_endpoint_from_chart": webserver_s3},
        "workarounds": applied,
        "harness_choices": [
            f"release name '{RELEASE}': gateway-routes.yaml hard-codes the Backend texera-dynamic-backend",
            "agent-service, litellm, notebook migration and the example loader are disabled",
            f"pullPolicy {pull_policy} for the Texera services and (KUBERNETES_IMAGE_PULL_POLICY) the unit pods",
            f"units in namespace {unit_namespace(ns)} (workflowComputingUnitPool.namespace)",
            "the gateway is forwarded to 127.0.0.1:<port> (OrbStack k8s.expose_services is off): a TCP "
            "relay to the envoy Service's ClusterIP; kubectl port-forward exits whenever Envoy resets "
            "one forwarded connection (websocket closes do), so it is used only when asked for and a "
            "run through it is marked unreliable",
        ],
        "port": port,
        "gateway_url": f"http://127.0.0.1:{port}",
    }
    write_json(MANIFEST, manifest)
    return manifest


# ---------------------------------------------------------------------------- CRDs

BUNDLE_VERSION = "gateway.networking.k8s.io/bundle-version"
GEN_VERSION = "controller-gen.kubebuilder.io/version"


def crd_digest(crd: dict) -> str:
    """What decides a CRD's behavior: each version's name, served and storage flags, and
    schema. The API server keeps them as applied, so a cluster CRD installed from the same
    file has the same digest."""
    versions = [{"name": v.get("name"), "served": v.get("served"), "storage": v.get("storage"),
                 "schema": (v.get("schema") or {}).get("openAPIV3Schema")}
                for v in (crd.get("spec") or {}).get("versions") or []]
    return hashlib.sha256(json.dumps(versions, sort_keys=True).encode()).hexdigest()[:16]


def chart_crds(chart_dir: Path = CHART_DIR) -> list[dict]:
    """The CRDs Helm installs from the resolved chart: crds/ of the chart and of each subchart
    archive (only gateway-helm ships any: the Gateway API bundle and Envoy Gateway's own)."""
    docs: list[dict] = []

    def add(text: str) -> None:
        docs.extend(d for d in yaml.safe_load_all(text) if d and d.get("kind") == "CustomResourceDefinition")

    if (chart_dir / "crds").is_dir():
        for f in sorted((chart_dir / "crds").rglob("*.y*ml")):
            add(f.read_text())
    for tgz in sorted((chart_dir / "charts").glob("*.tgz")):
        with tarfile.open(tgz) as t:
            for m in t.getmembers():
                if m.isfile() and "/crds/" in m.name and m.name.endswith((".yaml", ".yml")):
                    add(t.extractfile(m).read().decode())
    return docs


def compare_crds(chart: list[dict], cluster: list[dict]) -> dict:
    """Each chart CRD against the cluster's: same, absent (Helm installs it), or differs
    (Helm skips a CRD that exists and never upgrades it, so the cluster's stays in force)."""
    have = {c["metadata"]["name"]: c for c in cluster}
    out: dict = {"same": [], "absent": [], "differs": []}
    for d in chart:
        name = d["metadata"]["name"]
        c = have.get(name)
        if c is None:
            out["absent"].append(name)
        elif crd_digest(c) == crd_digest(d):
            out["same"].append(name)
        else:
            ca = c["metadata"].get("annotations") or {}
            da = d["metadata"].get("annotations") or {}
            out["differs"].append({
                "name": name,
                "cluster": ca.get(BUNDLE_VERSION) or ca.get(GEN_VERSION),
                "chart": da.get(BUNDLE_VERSION) or da.get(GEN_VERSION),
                "cluster_created": c["metadata"].get("creationTimestamp"),
            })
    return out


def check_crds(allow_drift: bool) -> dict:
    chart = chart_crds()
    rows = compare_crds(chart, kjson("get", "crd").get("items", []) if chart else [])
    result = {
        "chart_crds": len(chart),
        "same": len(rows["same"]),
        "absent": rows["absent"],
        "differs": rows["differs"],
        "chart_gateway_api_bundle": sorted({(d["metadata"].get("annotations") or {}).get(BUNDLE_VERSION)
                                            for d in chart} - {None}),
        "allow_drift": allow_drift,
    }
    if rows["differs"]:
        msg = ("the cluster's " + "; ".join(f"{r['name']} ({r['cluster']}, created {r['cluster_created']})"
                                            for r in rows["differs"])
               + f" differ from the chart's ({', '.join(sorted({str(r['chart']) for r in rows['differs']}))}), "
               "and Helm neither upgrades nor replaces a CRD that exists")
        if not allow_drift:
            die(msg + ". The release's Envoy Gateway would run against the cluster's versions. Apply the "
                "chart's (the crds/ of the gateway-helm archive under stack/k8s/generated/chart/charts/, "
                "`kubectl apply --server-side`), or pass --allow-crd-drift to deploy anyway (recorded in "
                "MANIFEST.json)")
        log("warning (--allow-crd-drift): " + msg)
    if rows["absent"]:
        log(f"{len(rows['absent'])} of the chart's CRDs are not in the cluster: helm installs them, and "
            "they stay after `down` (Helm never deletes CRDs)")
    return result


# ----------------------------------------------------------------------- preflight


def cluster_reachable() -> None:
    p = kubectl("get", "--raw=/readyz", check=False, capture=True, timeout=20)
    if p.returncode != 0 or "ok" not in (p.stdout or ""):
        die(f"kube context '{CONTEXT}' is not reachable ({(p.stderr or p.stdout or '').strip()[:300]}). "
            "This script never starts or toggles OrbStack's Kubernetes (that restarts Docker).")


def release_exists(ns: str) -> bool:
    p = helm("status", RELEASE, ns=ns, check=False, capture=True, timeout=60)
    return p.returncode == 0


def namespace_exists(ns: str) -> bool:
    return kubectl("get", "namespace", ns, check=False, capture=True, timeout=30).returncode == 0


def foreign_envoy_gateways(ns: str) -> list[str]:
    """Envoy Gateway controllers outside our namespace. The chart bundles its own (the
    gateway-helm dependency has no condition), and two controllers would both reconcile
    the GatewayClass `eg`."""
    out = []
    for d in kjson("get", "deployments", "--all-namespaces").get("items", []):
        if d["metadata"]["namespace"] == ns:
            continue
        for c in d["spec"]["template"]["spec"].get("containers", []):
            if re.search(r"envoyproxy/gateway(:|@)", c.get("image", "")):
                out.append(f"{d['metadata']['namespace']}/{d['metadata']['name']} ({c['image']})")
    return out


def owned_by_us(obj: dict, ns: str) -> bool:
    ann = (obj.get("metadata") or {}).get("annotations") or {}
    return (ann.get("meta.helm.sh/release-name") == RELEASE
            and ann.get("meta.helm.sh/release-namespace") == ns)


def hook_leftovers(ns: str) -> list[tuple[str, str]]:
    """Cluster-scoped Helm hook objects of the envoy-gateway subchart for a release in `ns`:
    hooks are never deleted by `helm uninstall`, and their names carry the namespace."""
    return [
        ("clusterrole", f"{RELEASE}-envoy-gateway-certgen:{ns}"),
        ("clusterrolebinding", f"{RELEASE}-envoy-gateway-certgen:{ns}"),
        ("mutatingwebhookconfiguration", f"envoy-gateway-topology-injector.{ns}"),
    ]


def delete_hook_leftovers(ns: str) -> list[str]:
    deleted = []
    for kind, name in hook_leftovers(ns):
        p = kubectl("delete", kind, name, "--ignore-not-found", "--wait=false", check=False,
                    capture=True, timeout=60)
        if p.returncode == 0 and (p.stdout or "").strip():
            deleted.append(f"{kind}/{name}")
    return deleted


def preflight(ns: str, port: int) -> dict:
    cluster_reachable()
    facts: dict = {"metrics_server": True}
    for n in (ns, unit_namespace(ns)):
        if release_exists(n) or namespace_exists(n):
            die(f"namespace {n} (or release {RELEASE} in it) already exists; run "
                f"`stack/k8s-stack.sh down` first (`up` always starts from a clean namespace)")
    foreign = foreign_envoy_gateways(ns)
    if foreign:
        die("another Envoy Gateway controller is running: " + ", ".join(foreign) + ". The chart "
            "installs its own (the gateway-helm dependency cannot be turned off) and two controllers "
            "would fight over GatewayClass `eg`. Uninstall it first; this script never touches it.")
    gc = kjson("get", "gatewayclass", "eg", check=False)
    if gc and not owned_by_us(gc, ns):
        ann = (gc.get("metadata") or {}).get("annotations") or {}
        die("GatewayClass `eg` exists and belongs to release "
            f"{ann.get('meta.helm.sh/release-namespace', '?')}/{ann.get('meta.helm.sh/release-name', '?')} "
            "(the chart creates it cluster-wide); remove that release first")
    if gc:  # ours, left by an interrupted `down` (its controller's finalizer never cleared)
        kubectl("patch", "gatewayclass", "eg", "--type=merge", "-p", '{"metadata":{"finalizers":null}}',
                check=False, capture=True, timeout=60)
        kubectl("delete", "gatewayclass", "eg", "--ignore-not-found", "--timeout=30s", check=False,
                capture=True, timeout=60)
        log("removed this release's leftover GatewayClass eg")
    api = kjson("get", "apiservice", "v1beta1.metrics.k8s.io", check=False)
    if api and not owned_by_us(api, ns):
        facts["metrics_server"] = False
        log("a metrics API (v1beta1.metrics.k8s.io) is already served; the chart's metrics-server is "
            "turned off and the units use the existing one")
    if listening("127.0.0.1", port) or listening("::1", port):
        die(f"127.0.0.1:{port} is already in use; pick another --port")
    stale = delete_hook_leftovers(ns)
    if stale:
        log(f"removed this release's stale hook objects: {', '.join(stale)}")
    return facts


# --------------------------------------------------------------------- wait ready


def _workload_status(ns: str) -> tuple[list[str], list[str], dict]:
    """(pending, failures, facts) over the release namespace."""
    pending, failures = [], []
    items = kjson("get", "deployments,statefulsets,daemonsets,jobs", ns=ns).get("items", [])
    envoy = [d for d in items if d["kind"] == "Deployment" and
             ((d["metadata"].get("labels") or {}).get("gateway.envoyproxy.io/owning-gateway-name")
              == GATEWAY_NAME)]
    if not envoy:
        pending.append("envoy proxy (not created yet)")
    jobs_seen = set()
    for d in items:
        name, kind, st, spec = d["metadata"]["name"], d["kind"], d.get("status") or {}, d.get("spec") or {}
        if name in OPTIONAL_WORKLOADS:
            continue
        if kind in ("Deployment", "StatefulSet"):
            want = spec.get("replicas", 1)
            if (st.get("readyReplicas") or 0) < want:
                pending.append(f"{kind.lower()}/{name}({st.get('readyReplicas') or 0}/{want})")
        elif kind == "DaemonSet":
            want = st.get("desiredNumberScheduled") or 0
            if want == 0 or (st.get("numberReady") or 0) < want:
                pending.append(f"daemonset/{name}({st.get('numberReady') or 0}/{want})")
        elif kind == "Job":
            jobs_seen.add(name)
            conds = {c["type"]: c for c in st.get("conditions") or [] if c.get("status") == "True"}
            if "Failed" in conds:
                failures.append(f"job/{name} failed: {conds['Failed'].get('message', '')}")
            elif name in REQUIRED_JOBS and not (st.get("succeeded") or 0):
                pending.append(f"job/{name}")
    for j in REQUIRED_JOBS - jobs_seen:
        pending.append(f"job/{j}(absent)")
    pg = next((d for d in items if d["kind"] == "StatefulSet" and d["metadata"]["name"] == POSTGRES_STS), None)
    pg_ready = bool(pg) and ((pg.get("status") or {}).get("readyReplicas") or 0) >= \
        ((pg.get("spec") or {}).get("replicas", 1) or 1)
    return pending, failures, {"envoy_deployments": [d["metadata"]["name"] for d in envoy],
                               "postgres_ready": pg_ready}


def crash_loop_fatal(pod: str, container: str, restarts: int, db: dict) -> bool:
    """Whether a container in CrashLoopBackOff counts as failed. Postgres itself after
    CRASHES_FATAL_DB restarts. Anything else only once Postgres is Ready (db["ready_at"]), and
    then only after CRASHES_AFTER_DB_READY restarts more than it had at that moment
    (db["baseline"], filled by _pod_problems): the chart has no wait-for-Postgres step, so
    crashes before it is up say nothing about the service."""
    if pod.startswith(f"{POSTGRES_STS}-"):
        return restarts >= CRASHES_FATAL_DB
    if db.get("ready_at") is None:
        return False
    base = db.setdefault("baseline", {}).setdefault(f"{pod}/{container}", restarts)
    return restarts - base >= CRASHES_AFTER_DB_READY


def _pod_problems(ns: str, since: float, db: dict) -> tuple[list[str], list[str]]:
    """(fatal, warnings) from container states of pods that `up` waits for."""
    fatal, warn = [], []
    for pod in kjson("get", "pods", ns=ns).get("items", []):
        name = pod["metadata"]["name"]
        if any(name.startswith(o) for o in OPTIONAL_WORKLOADS):
            continue
        statuses = (pod.get("status") or {}).get("initContainerStatuses", []) + \
            (pod.get("status") or {}).get("containerStatuses", [])
        for cs in statuses or []:
            restarts = cs.get("restartCount") or 0
            if db.get("ready_at") is not None:  # every container's count when Postgres became Ready
                db.setdefault("baseline", {}).setdefault(f"{name}/{cs['name']}", restarts)
            waiting = (cs.get("state") or {}).get("waiting") or {}
            reason = waiting.get("reason")
            if reason in FATAL_WAITING:
                fatal.append(f"pod/{name} container {cs['name']}: {reason}: {waiting.get('message', '')[:300]}")
            elif reason in PULL_WAITING:
                if time.time() - since > 240:
                    fatal.append(f"pod/{name} container {cs['name']}: {reason}: {waiting.get('message', '')[:300]}")
                else:
                    warn.append(f"pod/{name}:{reason}")
            elif reason == "CrashLoopBackOff":
                if crash_loop_fatal(name, cs["name"], restarts, db):
                    base = (db.get("baseline") or {}).get(f"{name}/{cs['name']}")
                    fatal.append(f"pod/{name} container {cs['name']}: CrashLoopBackOff ({restarts} restarts"
                                 + (f", {restarts - base} since Postgres became ready" if base is not None
                                    and not name.startswith(f"{POSTGRES_STS}-") else "") + ")")
                else:
                    warn.append(f"pod/{name}:CrashLoopBackOff({restarts})")
    return fatal, warn


def _dump_failure(ns: str, problems: list[str]) -> None:
    for prob in problems:
        m = re.match(r"pod/(\S+) container (\S+):", prob)
        if m:
            print(f"----- last log lines of {m.group(1)} [{m.group(2)}] -----", file=sys.stderr)
            kubectl("logs", m.group(1), "-c", m.group(2), "--tail", "60", ns=ns, check=False, timeout=30)
        m = re.match(r"job/(\S+) failed", prob)
        if m:
            print(f"----- last log lines of job {m.group(1)} -----", file=sys.stderr)
            kubectl("logs", f"job/{m.group(1)}", "--all-containers", "--tail", "60", ns=ns, check=False,
                    timeout=30)


def wait_ready(ns: str, timeout: int) -> dict:
    t0 = time.time()
    deadline = t0 + timeout
    last_report = 0.0
    pending: list[str] = []
    db: dict = {"ready_at": None, "baseline": {}}
    while time.time() < deadline:
        pending, failures, facts = _workload_status(ns)
        if facts.get("postgres_ready") and db["ready_at"] is None:
            db["ready_at"] = time.time()
            log(f"{POSTGRES_STS} ready after {db['ready_at'] - t0:.0f}s; from now a service crashing "
                f"{CRASHES_AFTER_DB_READY} more times fails `up`")
        fatal, warn = _pod_problems(ns, t0, db)
        if failures or fatal:
            _dump_failure(ns, failures + fatal)
            die("deployment failed:\n  " + "\n  ".join(failures + fatal))
        if not pending:
            log(f"all workloads ready after {time.time() - t0:.0f}s")
            facts["postgres_ready_after_s"] = round(db["ready_at"] - t0) if db["ready_at"] else None
            facts["restarts_before_postgres_ready"] = {k: v for k, v in sorted(db["baseline"].items()) if v}
            return facts
        if time.time() - last_report > 20:
            extra = f"; {', '.join(warn)}" if warn else ""
            log(f"waiting ({time.time() - t0:.0f}s) for {len(pending)}: {', '.join(pending)}{extra}")
            last_report = time.time()
        time.sleep(5)
    die(f"timed out after {timeout}s; still pending: {', '.join(pending)}")
    return {}


# ------------------------------------------------------------------ port-forward


def envoy_service_obj(ns: str) -> dict | None:
    sel = (f"gateway.envoyproxy.io/owning-gateway-name={GATEWAY_NAME},"
           f"gateway.envoyproxy.io/owning-gateway-namespace={ns}")
    items = kjson("get", "services", "-l", sel, ns=ns, check=False).get("items", [])
    return items[0] if items else None


def envoy_service(ns: str) -> str | None:
    svc = envoy_service_obj(ns)
    return svc["metadata"]["name"] if svc else None


def relay_target(ns: str) -> tuple[str, int] | None:
    """The envoy Service's ClusterIP and HTTP port, which OrbStack routes from macOS."""
    svc = envoy_service_obj(ns)
    if not svc or not (svc.get("spec") or {}).get("clusterIP"):
        return None
    ports = svc["spec"].get("ports") or []
    port = next((p["port"] for p in ports if p.get("port") == 80), ports[0]["port"] if ports else 80)
    return svc["spec"]["clusterIP"], int(port)


def host_reaches(ip: str, port: int) -> bool:
    """Checked with the relay's own interpreter: macOS's Local Network privacy check refuses
    192.168.x.x to the venv's ad-hoc-signed Python (EHOSTUNREACH) but not to /usr/bin/python3."""
    p = run([RELAY_PYTHON, str(RELAY), "--check", f"{ip}:{port}"], check=False, capture=True, timeout=20)
    return p.returncode == 0


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def pf_running() -> int | None:
    if not PF_PID.exists():
        return None
    try:
        pid = int(PF_PID.read_text().split()[0])
    except (ValueError, IndexError):
        return None
    if not _pid_alive(pid):
        return None
    cmd = run(["ps", "-o", "command=", "-p", str(pid)], check=False, capture=True).stdout
    return pid if ("_pf-supervise" in cmd or RELAY.name in cmd) else None


def pf_mode() -> str | None:
    try:
        return PF_PID.read_text().split()[3]
    except (OSError, IndexError):
        return None


def pf_start(ns: str, port: int, mode: str) -> dict:
    """Expose the gateway on 127.0.0.1:<port>, supervised in a background process.

    relay (default): gateway_relay.py, a TCP relay to the envoy Service's ClusterIP, which
      OrbStack routes from macOS. Each connection is independent. When the ClusterIP is not
      reachable this fails: it never falls back to kubectl on its own.
    kubectl (only when asked for): `kubectl port-forward svc/<envoy>`, restarted whenever it
      exits. It exits ("lost connection to pod") as soon as the pod side resets any one
      forwarded connection, which closing a workflow websocket through Envoy does; requests
      in the second until the restart fail, so a run's failures may be the forwarder's. The
      manifest marks it unreliable, and `post-run` marks the run's report so."""
    if pf_running():
        return {"mode": pf_mode(), "already_running": True, "reliable": pf_mode() == "relay"}
    info: dict = {"mode": mode, "reliable": mode == "relay"}
    if mode == "relay":
        target = relay_target(ns)
        if not target or not host_reaches(*target):
            die(f"the envoy Service's ClusterIP ({target}) is not reachable from this host with "
                f"{RELAY_PYTHON}, so the relay cannot expose the gateway. `--forward kubectl` uses kubectl "
                "port-forward instead, but that drops (and is restarted) whenever a workflow websocket "
                "closes, so later requests can fail for the forwarder's sake; a run through it is marked "
                "unreliable")
        info["target"] = f"{target[0]}:{target[1]}"
    else:
        info["warning"] = ("kubectl port-forward drops whenever Envoy resets a forwarded connection (every "
                           "workflow websocket close) and is restarted 1 s later: failures may be the "
                           "forwarder's, not Texera's")
        log(f"warning: {info['warning']}")
    info["service"] = envoy_service(ns)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    logf = open(PF_LOG, "a")
    if mode == "relay":
        selector = (f"gateway.envoyproxy.io/owning-gateway-name={GATEWAY_NAME},"
                    f"gateway.envoyproxy.io/owning-gateway-namespace={ns}")
        cmd = [RELAY_PYTHON, str(RELAY), "--listen", f"127.0.0.1:{port}", "--target", info["target"],
               "--context", CONTEXT, "--namespace", ns, "--selector", selector]
        info["interpreter"] = RELAY_PYTHON
    else:
        cmd = [sys.executable, str(Path(__file__).resolve()), "--namespace", ns, "_pf-supervise",
               "--port", str(port)]
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT,
                            start_new_session=True)
    PF_PID.write_text(f"{proc.pid} {ns} {port} {mode}\n")
    info["pid"] = proc.pid
    log(f"gateway forward ({mode}{' to ' + info['target'] if info.get('target') else ''}) pid {proc.pid}: "
        f"127.0.0.1:{port} -> svc/{info['service']} (log {PF_LOG})")
    return info


def pf_stop() -> None:
    pid = pf_running()
    if pid:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(50):
            if not _pid_alive(pid):
                break
            time.sleep(0.1)
        log(f"gateway forward {pid} stopped")
    PF_PID.unlink(missing_ok=True)


def _stamp() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def cmd_pf_supervise(a) -> None:
    """Background process behind pf_start in kubectl mode: kubectl port-forward kept alive."""
    ns, port = a.namespace, a.port
    child: list[subprocess.Popen] = []

    def stop(*_):
        for c in child:
            if c.poll() is None:
                c.terminate()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while True:
        svc = envoy_service(ns)
        if not svc:
            print(f"{_stamp()} no envoy service yet", flush=True)
            time.sleep(3)
            continue
        print(f"{_stamp()} port-forward svc/{svc} 127.0.0.1:{port}->80", flush=True)
        p = subprocess.Popen(["kubectl", "--context", CONTEXT, "-n", ns, "port-forward",
                              "--address", "127.0.0.1", f"svc/{svc}", f"{port}:80"])
        child[:] = [p]
        rc = p.wait()
        print(f"{_stamp()} port-forward exited {rc}; restarting", flush=True)
        time.sleep(1)


def wait_gateway(port: int, timeout: int) -> dict:
    base = f"http://127.0.0.1:{port}"
    t0 = time.time()
    deadline = t0 + timeout
    results: dict = {}
    last_report = 0.0
    while time.time() < deadline:
        results = {}
        for path, svc, want in GATEWAY_PROBES:
            code, body = http_status(base + path)
            ok = code is not None and (code in want if want else code not in (502, 503, 504))
            results[path] = {"service": svc, "status": code, "ok": ok,
                             "body": body[:120] if not ok else ""}
        if all(r["ok"] for r in results.values()):
            log(f"gateway {base} reaches every backend after {time.time() - t0:.0f}s: "
                + ", ".join(f"{p} {r['status']}" for p, r in results.items()))
            return results
        if time.time() - last_report > 15:
            bad = [f"{p}={r['status']}" for p, r in results.items() if not r["ok"]]
            log(f"waiting for the gateway: {', '.join(bad)}")
            last_report = time.time()
        time.sleep(2)
    die(f"the gateway at {base} did not reach every backend within {timeout}s: {results}")
    return results


# ------------------------------------------------------------- ext-authz refusals


def ws_upgrade_status(port: int, path: str, timeout: float = 10) -> tuple[int | None, str]:
    """The status of a websocket handshake through the gateway, as the browser sends it."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("GET", path, headers={
            "Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": base64.b64encode(os.urandom(16)).decode()})
        return conn.getresponse().status, ""
    except (OSError, http.client.HTTPException) as e:
        return None, f"{type(e).__name__}: {e}"
    finally:
        conn.close()


def login_token(port: int) -> str | None:
    body = json.dumps({"username": os.environ.get("SCE_USER", "texera"),
                       "password": os.environ.get("SCE_PASSWORD", "texera")}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/auth/login", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return (json.loads(r.read() or b"{}") or {}).get("accessToken")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def parse_access_log(text: str, markers: set[str]) -> dict[str, dict]:
    """Envoy's access-log entries (JSON lines) of the requests whose query carries
    `sce-probe=<marker>`, one of `markers`."""
    found: dict[str, dict] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{") or "sce-probe=" not in line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        query = urllib.parse.urlsplit(str(rec.get("x-envoy-origin-path") or "")).query
        marker = (urllib.parse.parse_qs(query).get("sce-probe") or [None])[0]
        if marker in markers:
            found[marker] = {k: rec.get(k) for k in ("response_code", "response_code_details",
                                                     "response_flags", "route_name", "start_time")}
    return found


def envoy_access_records(ns: str, markers: list[str], wait_s: float = 45) -> dict[str, dict]:
    """The entries of `markers` in the envoy proxy's access log. Envoy writes the log in
    batches, so this polls until every marker is there or `wait_s` passes."""
    want = set(markers)
    found: dict[str, dict] = {}
    deadline = time.time() + wait_s
    while want:
        pods = kjson("get", "pods", "-l", f"gateway.envoyproxy.io/owning-gateway-name={GATEWAY_NAME}",
                     ns=ns, check=False).get("items", [])
        for pod in pods:
            p = kubectl("logs", pod["metadata"]["name"], "-c", "envoy", ns=ns, check=False, capture=True,
                        timeout=60)
            found.update(parse_access_log(p.stdout or "", want))
        if want <= set(found) or time.time() > deadline:
            break
        time.sleep(3)
    return found


def judge_refusal(status: int | None, envoy: dict | None) -> tuple[bool, bool | None, str]:
    """(refused, by ext-authz (None: Envoy's entry not found), verdict) for one probe."""
    if status not in REFUSED:
        return False, None, f"not refused: HTTP {status}"
    if envoy is None:
        return True, None, f"refused ({status}); Envoy's access-log entry not found"
    details = envoy.get("response_code_details")
    if details != EXT_AUTHZ_DENIED:
        return False, False, f"refused ({status}), but not by ext-authz: {details}"
    return True, True, f"refused ({status}) by ext-authz ({EXT_AUTHZ_DENIED})"


def judge_stored_read(status: int | None, envoy: dict | None) -> tuple[bool | None, str]:
    """(answered by the webserver (None: Envoy's entry not found), verdict) for a request
    for stored output that scenario v marked: from step 3's sub-part 16 on no such request
    is routed to a computing unit."""
    if envoy is None:
        return None, f"answered ({status}); Envoy's access-log entry not found"
    route = str(envoy.get("route_name") or "")
    if UNIT_ROUTE in route:
        return False, f"routed to a computing unit ({route}), answered {envoy.get('response_code')}"
    return True, f"answered {envoy.get('response_code')} through {route or 'a route Envoy does not name'}, not a unit's"


def gateway_refusals(ns: str, port: int) -> dict:
    """Websocket handshakes ext-authz must refuse (AUTHZ_PROBES), each judged from its HTTP
    status and Envoy's own access-log entry for it."""
    nonce = f"{int(time.time())}-{os.getpid()}"
    token = None
    probes: list[dict] = []
    for name, credential, cuid in AUTHZ_PROBES:
        params: dict = {"wid": 1, "uid": 1, "cuid": cuid}
        if credential == "valid":
            token = token or login_token(port)
            if not token:
                probes.append({"probe": name, "cuid": cuid, "skipped": "logging in as texera failed"})
                continue
            params["access-token"] = token
        elif credential:
            params["access-token"] = credential
        params["sce-probe"] = f"up-{name}-{nonce}"
        status, err = ws_upgrade_status(port, "/wsapi/workflow-websocket?" + urllib.parse.urlencode(params))
        probes.append({"probe": name, "cuid": cuid, "marker": params["sce-probe"], "status": status,
                       **({"error": err} if err else {})})
    records = envoy_access_records(ns, [p["marker"] for p in probes if "marker" in p])
    for p in probes:
        if "marker" in p:
            p["envoy"] = records.get(p["marker"])
            p["refused"], p["by_ext_authz"], p["verdict"] = judge_refusal(p["status"], p["envoy"])
    ran = [p for p in probes if "marker" in p]
    return {"ok": bool(ran) and all(p["refused"] for p in ran),
            "confirmed_by_envoy": bool(ran) and all(p["by_ext_authz"] for p in ran),
            "probes": probes}


# ------------------------------------------------------------------------ post-run


def evaluate_post_run(*, pods_left: list[str], unit_kept: bool, forward: dict, driver_probes: list[dict],
                      envoy: dict[str, dict], stored_reads: list[dict] | None = None) -> dict:
    """After the driver: its unit's pod must be gone (unless kept), its refusal probes must
    have been refused by ext-authz (Envoy's entries), the requests for stored output that
    scenario v marked (`stored_reads`) must not have been routed to a unit, and a run
    through kubectl port-forward is unreliable."""
    failures: list[str] = []
    warnings: list[str] = []
    if pods_left and not unit_kept:
        failures.append("unit pod(s) still present after the driver terminated its unit: " + ", ".join(pods_left))
    mode = (forward or {}).get("mode")
    if mode == "kubectl":
        warnings.append("the gateway was forwarded by kubectl port-forward, which drops whenever a websocket "
                        "closes: failures may be the forwarder's, not Texera's")
    refusals = []
    for p in driver_probes:
        rec = envoy.get(p.get("marker"))
        refused, by_authz, verdict = judge_refusal(p.get("status"), rec)
        refusals.append({k: p.get(k) for k in ("probe", "cuid", "status", "marker")}
                        | {"envoy": rec, "by_ext_authz": by_authz, "verdict": verdict})
        if not refused:
            failures.append(f"the driver's {p.get('probe')} probe: {verdict}")
        elif by_authz is None:
            warnings.append(f"the driver's {p.get('probe')} probe: {verdict}")
    reads = []
    for r in stored_reads or []:
        rec = envoy.get(r.get("marker"))
        by_webserver, verdict = judge_stored_read(r.get("status"), rec)
        reads.append({k: r.get(k) for k in ("what", "status", "marker")}
                     | {"envoy": rec, "by_the_webserver": by_webserver, "verdict": verdict})
        if by_webserver is False:
            failures.append(f"the driver's request for stored {r.get('what')}: {verdict}")
        elif by_webserver is None:
            warnings.append(f"the driver's request for stored {r.get('what')}: {verdict}")
    return {"unit_pods_left": pods_left, "unit_kept": unit_kept, "gateway_forward": mode,
            "reliable": None if mode is None else mode == "relay", "gateway_refusals": refusals,
            "stored_reads": reads, "failures": failures, "warnings": warnings}


def apply_post_run(report: dict, post: dict) -> None:
    report["post_run"] = post
    summary = report.setdefault("summary", {})
    summary["reliable"] = post["reliable"]
    if post["failures"]:
        summary["post_run_failures"] = post["failures"]
        summary["result"] = "FAIL"


# ----------------------------------------------------------------------- commands


def cmd_generate(a) -> None:
    reg, tag = parse_images(a.images)
    m = generate(a.source, reg, tag, a.namespace, a.port, a.profile, not a.no_workarounds,
                 fast_record=a.fast_record)
    src = m["source_git"]
    log(f"generated {GEN_DIR.relative_to(HERE.parent.parent)} from {m['chart_source']} @ "
        f"{src.get('head', '')[:10]}{' (dirty)' if src.get('dirty') else ''}")
    log(f"images {reg}/texera-*:{tag} (pull {m['images']['pull_policy']}); apply {m['apply']}; "
        f"workarounds: {', '.join(w['name'] for w in m['workarounds']) or 'none'}")


def cmd_up(a) -> None:
    reg, tag = parse_images(a.images)
    ns, port = a.namespace, a.port
    facts = preflight(ns, port)
    m = generate(a.source, reg, tag, ns, port, a.profile, not a.no_workarounds,
                 metrics_server=facts["metrics_server"], fast_record=a.fast_record)
    log(f"chart {m['chart_source']} @ {m['source_git'].get('head', '')[:10]}; images {reg}/texera-*:{tag} "
        f"(pull {m['images']['pull_policy']}); workarounds: "
        f"{', '.join(w['name'] for w in m['workarounds']) or 'none'}"
        + ("; fast record" if a.fast_record else ""))
    m["crds"] = check_crds(a.allow_crd_drift)
    log(f"CRDs: {m['crds']['same']} of the chart's {m['crds']['chart_crds']} are in the cluster as the chart "
        f"has them (Gateway API bundle {', '.join(m['crds']['chart_gateway_api_bundle']) or '-'}), "
        f"{len(m['crds']['absent'])} absent, {len(m['crds']['differs'])} differ")
    write_json(MANIFEST, m)
    t0 = time.time()
    args = ["install", RELEASE, str(CHART_DIR), "--create-namespace", "--timeout", f"{a.helm_timeout}s"]
    for v in m["values_files"]:
        args += ["-f", v]
    if m["apply"] == "client-side":
        args.append("--server-side=false")
    log(f"helm install {RELEASE} into {ns} (units in {unit_namespace(ns)}, apply {m['apply']})")
    p = helm(*args, ns=ns, check=False, capture=True, timeout=a.helm_timeout + 120)
    if p.returncode != 0:
        print((p.stdout or "")[-3000:], (p.stderr or "")[-3000:], file=sys.stderr)
        die("helm install failed (the namespace is left for inspection; `stack/k8s-stack.sh down` "
            "removes it)")
    for line in (p.stderr or "").splitlines():
        if "warning" in line.lower():
            log(f"helm: {line.strip()[:200]}")
    facts.update(wait_ready(ns, a.timeout))
    forward = pf_start(ns, port, a.forward)
    probes = wait_gateway(port, 300)
    refusals = gateway_refusals(ns, port)
    m.update({"deployed_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
              "up_seconds": round(time.time() - t0), "envoy": facts.get("envoy_deployments"),
              "envoy_service": envoy_service(ns), "gateway_forward": forward, "gateway_probes": probes,
              "gateway_refusals": refusals,
              "readiness": {"postgres_ready_after_s": facts.get("postgres_ready_after_s"),
                            "restarts_before_postgres_ready": facts.get("restarts_before_postgres_ready")}})
    write_json(MANIFEST, m)
    verdicts = ", ".join(f"{p['probe']}: {p.get('verdict') or p.get('skipped')}" for p in refusals["probes"])
    if not refusals["ok"]:
        die(f"the gateway does not refuse the unit websocket without valid credentials ({verdicts}); "
            "the deployment is left up for inspection (`stack/k8s-stack.sh down` removes it)")
    log(f"ext-authz refusals: {verdicts}")
    if not refusals["confirmed_by_envoy"]:
        log("warning: not every refusal was found in Envoy's access log, so ext-authz is not confirmed as the "
            "one that refused each")
    log(f"stack is up: http://127.0.0.1:{port} (login texera / texera; units are created on request "
        f"in {unit_namespace(ns)})")


def cmd_down(a) -> None:
    """Remove everything `up` created. Nothing in the two namespaces is kept, so pods are
    removed without their grace periods: Envoy's proxy otherwise drains for minutes and the
    JVM services wait out 30 s each (a waiting uninstall took 8 minutes)."""
    ns = a.namespace
    t0 = time.time()
    pf_stop()
    cluster_reachable()
    namespaces = (unit_namespace(ns), ns)
    if release_exists(ns):
        # While the release's Envoy Gateway controller still runs: it removes the proxy it made
        # for the Gateway, and the finalizer it put on GatewayClass `eg`, which nothing removes
        # once the controller is gone (the class then never finishes deleting).
        kubectl("delete", "gateway", GATEWAY_NAME, "--ignore-not-found", "--timeout=90s", ns=ns,
                check=False, capture=True, timeout=120)
        gc = kjson("get", "gatewayclass", "eg", check=False)
        if gc and owned_by_us(gc, ns):
            kubectl("delete", "gatewayclass", "eg", "--ignore-not-found", "--timeout=30s",
                    check=False, capture=True, timeout=60)
        log(f"helm uninstall {RELEASE} -n {ns}")
        p = helm("uninstall", RELEASE, "--timeout", "120s", ns=ns, check=False, capture=True, timeout=240)
        if p.returncode != 0:
            log(f"helm uninstall: {(p.stderr or p.stdout).strip()[:300]}")
    present = [n for n in namespaces if namespace_exists(n)]
    for n in present:
        kubectl("delete", "pods", "--all", "--grace-period=0", "--force", "--wait=false", ns=n,
                check=False, capture=True, timeout=120)
        kubectl("delete", "namespace", n, "--wait=false", "--ignore-not-found", check=False,
                capture=True, timeout=60)
    if present:
        log(f"deleting namespace(s) {', '.join(present)}")
    deadline = time.time() + 300
    while time.time() < deadline:
        present = [n for n in namespaces if namespace_exists(n)]
        if not present:
            break
        for n in present:  # pods a controller started before the namespace began terminating
            kubectl("delete", "pods", "--all", "--grace-period=0", "--force", "--wait=false", ns=n,
                    check=False, capture=True, timeout=120)
        time.sleep(3)
    left = delete_hook_leftovers(ns)
    # Cluster-scoped objects the release created that uninstall did not remove.
    for kind in ("gatewayclass", "apiservice", "clusterrole", "clusterrolebinding",
                 "mutatingwebhookconfiguration", "validatingwebhookconfiguration"):
        for obj in kjson("get", kind, check=False).get("items", []):
            if owned_by_us(obj, ns):
                name = obj["metadata"]["name"]
                if obj["metadata"].get("finalizers"):
                    # ours and its controller is gone (e.g. GatewayClass eg's Envoy Gateway finalizer)
                    kubectl("patch", kind, name, "--type=merge", "-p", '{"metadata":{"finalizers":null}}',
                            check=False, capture=True, timeout=60)
                kubectl("delete", kind, name, "--ignore-not-found", "--timeout=30s", check=False,
                        capture=True, timeout=60)
                left.append(f"{kind}/{name}")
    if left:
        log(f"removed leftover cluster-scoped objects: {', '.join(left)}")
    pvs = [pv["metadata"]["name"] for pv in kjson("get", "pv", check=False).get("items", [])
           if ((pv.get("spec") or {}).get("claimRef") or {}).get("namespace") in namespaces]
    for pv in pvs:
        kubectl("delete", "pv", pv, "--ignore-not-found", "--wait=false", check=False, capture=True,
                timeout=60)
    still = [n for n in namespaces if namespace_exists(n)]
    if still:
        die(f"namespaces still present after {time.time() - t0:.0f}s: {', '.join(still)}")
    log(f"down in {time.time() - t0:.0f}s: release {RELEASE}, namespaces {ns} and {unit_namespace(ns)} "
        "removed")


def _pods_table(ns: str) -> list[str]:
    rows = []
    for pod in kjson("get", "pods", ns=ns, check=False).get("items", []):
        st = pod.get("status") or {}
        cs = st.get("containerStatuses") or []
        ready = sum(1 for c in cs if c.get("ready"))
        restarts = sum(c.get("restartCount") or 0 for c in cs)
        reason = ""
        for c in cs:
            w = (c.get("state") or {}).get("waiting") or {}
            if w.get("reason"):
                reason = w["reason"]
        image = (pod["spec"]["containers"][0].get("image") or "") if pod["spec"].get("containers") else ""
        rows.append(f"  {pod['metadata']['name']:58} {ready}/{len(cs)} {st.get('phase', ''):10} "
                    f"{reason:18} restarts={restarts:<3} {image}")
    return rows


def cmd_status(a) -> None:
    ns = a.namespace
    m = load_manifest()
    cluster_reachable()
    if a.json:
        out = {"manifest": m, "release": None, "pods": {}}
        p = helm("status", RELEASE, "-o", "json", ns=ns, check=False, capture=True, timeout=60)
        if p.returncode == 0:
            info = json.loads(p.stdout)
            out["release"] = {"status": info.get("info", {}).get("status"), "revision": info.get("version")}
        for n in (ns, unit_namespace(ns)):
            out["pods"][n] = kjson("get", "pods", ns=n, check=False).get("items", [])
        print(json.dumps(out, indent=2, default=str))
        return
    if m:
        src = m.get("source_git", {})
        print(f"chart  : {m.get('chart_source')} @ {src.get('head', '')[:10]}{' dirty' if src.get('dirty') else ''}")
        print(f"images : {m['images']['registry']}/texera-*:{m['images']['tag']} (pull {m['images']['pull_policy']})")
        print(f"apply  : {m.get('apply')}   workarounds: "
              f"{', '.join(w['name'] for w in m.get('workarounds', [])) or 'none'}")
    p = helm("status", RELEASE, ns=ns, check=False, capture=True, timeout=60)
    print(f"release: {RELEASE} in {ns}: "
          + ((re.search(r"STATUS: (\S+)", p.stdout or "") or [None, "?"])[1] if p.returncode == 0 else "absent"))
    for n in (ns, unit_namespace(ns)):
        print(f"pods in {n}:")
        rows = _pods_table(n)
        print("\n".join(rows) if rows else "  (none)")
    pid = pf_running()
    port = m.get("port", a.port)
    print(f"gateway forward: {f'pid {pid} ({pf_mode()})' if pid else 'not running'} -> 127.0.0.1:{port}")
    code, _ = http_status(f"http://127.0.0.1:{port}/api/healthcheck")
    print(f"http://127.0.0.1:{port}/api/healthcheck -> {code or 'not answering'}")


def _unit_pods(ns: str) -> list[dict]:
    pods = kjson("get", "pods", "-l", UNIT_SELECTOR, ns=unit_namespace(ns), check=False).get("items", [])
    return sorted(pods, key=lambda p: p["metadata"].get("creationTimestamp", ""))


def cmd_logs(a) -> None:
    ns = a.namespace
    target, tns, extra = None, ns, []
    if a.service in ("unit", "cu") or a.service.startswith("unit-"):
        pods = _unit_pods(ns)
        if a.service.startswith("unit-"):
            pods = [p for p in pods if p["metadata"]["labels"].get("cuid") == a.service[5:]]
        if not pods:
            die(f"no computing-unit pod in {unit_namespace(ns)}")
        target, tns, extra = f"pod/{pods[-1]['metadata']['name']}", unit_namespace(ns), ["-c", UNIT_CONTAINER]
    elif a.service in ("envoy", "gateway"):
        pods = kjson("get", "pods", "-l", f"gateway.envoyproxy.io/owning-gateway-name={GATEWAY_NAME}",
                     ns=ns, check=False).get("items", [])
        if not pods:
            die("no envoy proxy pod")
        target, extra = f"pod/{pods[0]['metadata']['name']}", ["-c", "envoy"]
    else:
        target = LOG_ALIASES.get(a.service, a.service if "/" in a.service else f"deploy/{a.service}")
    args = ["logs", target, *extra, "--tail", str(a.tail)]
    if a.follow:
        args.append("-f")
    os.execvp("kubectl", ["kubectl", "--context", CONTEXT, "-n", tns, *args])


def cmd_port_forward(a) -> None:
    if a.action == "start":
        pf_start(a.namespace, a.port, a.forward)
        wait_gateway(a.port, 120)
    elif a.action == "stop":
        pf_stop()
    else:
        pid = pf_running()
        print(f"gateway forward: {f'pid {pid} ({pf_mode()})' if pid else 'not running'}")


def cmd_collect_logs(a) -> None:
    """Everything needed to debug a run after `down`: logs of every container in both
    namespaces (previous instances too), descriptions, events, gateway objects, release."""
    out: Path = a.dir
    ns = a.namespace
    out.mkdir(parents=True, exist_ok=True)

    def save(name: str, cmd: list[str], timeout: float = 60) -> None:
        p = run(cmd, check=False, capture=True, timeout=timeout)
        (out / name).write_text((p.stdout or "") + (("\n# stderr:\n" + p.stderr) if p.stderr else ""))

    k = ["kubectl", "--context", CONTEXT]
    save("helm-status.txt", ["helm", "--kube-context", CONTEXT, "-n", ns, "status", RELEASE])
    save("helm-values.yaml", ["helm", "--kube-context", CONTEXT, "-n", ns, "get", "values", RELEASE, "--all"])
    save("gateway.yaml", k + ["-n", ns, "get", "gatewayclass,gateway,httproute,securitypolicy,backend,"
                                          "backendtrafficpolicy", "-o", "yaml"])
    save("nodes.txt", k + ["describe", "nodes"])
    for n in (ns, unit_namespace(ns)):
        save(f"{n}-get-all.txt", k + ["-n", n, "get", "all,pvc,jobs,networkpolicy,resourcequota", "-o", "wide"])
        save(f"{n}-events.txt", k + ["-n", n, "get", "events", "--sort-by=.lastTimestamp"])
        save(f"{n}-describe-pods.txt", k + ["-n", n, "describe", "pods"], timeout=120)
        for pod in kjson("get", "pods", ns=n, check=False).get("items", []):
            pname = pod["metadata"]["name"]
            statuses = (pod.get("status") or {}).get("initContainerStatuses", []) + \
                (pod.get("status") or {}).get("containerStatuses", [])
            for cs in statuses or []:
                d = out / n
                d.mkdir(exist_ok=True)
                save(f"{n}/{pname}.{cs['name']}.log", k + ["-n", n, "logs", pname, "-c", cs["name"]],
                     timeout=120)
                if cs.get("restartCount"):
                    save(f"{n}/{pname}.{cs['name']}.previous.log",
                         k + ["-n", n, "logs", pname, "-c", cs["name"], "--previous"], timeout=120)
    if PF_LOG.exists():
        shutil.copy2(PF_LOG, out / "port-forward.log")
    log(f"collected logs into {out}")


def cmd_post_run(a) -> None:
    """After a driver run: wait for the unit's pod to go, read Envoy's entries of the driver's
    refusal probes and of the requests for stored output that scenario v marked, and fold
    the outcome into the report (`post_run`; a failure turns summary.result to FAIL). Exit 4
    on a failure."""
    ns = a.namespace
    report = json.loads(a.report.read_text()) if a.report.exists() else None
    deadline = time.time() + a.wait
    while True:
        pods = [p["metadata"]["name"] for p in _unit_pods(ns)]
        if not pods or a.unit_kept or time.time() >= deadline:
            break
        time.sleep(2)
    m = load_manifest()
    probes = (((report or {}).get("setup") or {}).get("kubernetes_unit") or {}).get("gateway_refusals") or []
    reads = [r for sc in (report or {}).get("scenarios") or []
             for r in (sc.get("facts") or {}).get("gateway_markers") or []]
    markers = [p["marker"] for p in probes + reads if p.get("marker")]
    envoy = envoy_access_records(ns, markers, wait_s=30) if markers else {}
    post = evaluate_post_run(pods_left=pods, unit_kept=a.unit_kept, forward=m.get("gateway_forward") or {},
                             driver_probes=probes, envoy=envoy, stored_reads=reads)
    post["checked_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    if report is not None:
        apply_post_run(report, post)
        write_json(a.report, report)
    else:
        post["warnings"].append(f"no report at {a.report}")
    if a.out:
        write_json(a.out, post)
    log(f"unit pods after the run: {', '.join(pods) or 'none'}{' (--keep-unit)' if a.unit_kept else ''}; "
        f"driver refusal probes: " + (", ".join(f"{r['probe']} {r['verdict']}" for r in post["gateway_refusals"])
                                       or "none recorded"))
    for r in post["stored_reads"]:
        log(f"stored {r['what']}: {r['verdict']}")
    for w in post["warnings"]:
        log(f"post-run warning: {w}")
    for f in post["failures"]:
        log(f"post-run FAIL: {f}")
    sys.exit(4 if post["failures"] else 0)


def cmd_follow_units(a) -> None:
    """Stream the log of every unit pod into <dir>/<pod>.log until stopped. Units are
    terminated (their pods deleted) by the driver, so this is the only copy of their logs."""
    out: Path = a.dir
    out.mkdir(parents=True, exist_ok=True)
    followers: dict[str, subprocess.Popen] = {}

    def stop(*_):
        for p in followers.values():
            if p.poll() is None:
                p.terminate()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    uns = unit_namespace(a.namespace)
    while True:
        for pod in _unit_pods(a.namespace):
            name = pod["metadata"]["name"]
            uid = pod["metadata"].get("uid", "")[:8]
            key = f"{name}-{uid}"
            started = any((cs.get("state") or {}).get("running") or (cs.get("state") or {}).get("terminated")
                          for cs in (pod.get("status") or {}).get("containerStatuses") or [])
            if key in followers or not started:
                continue
            f = open(out / f"{key}.log", "a")
            cs = ((pod.get("status") or {}).get("containerStatuses") or [{}])[0]
            f.write(f"# {uns}/{name} image={pod['spec']['containers'][0].get('image')} "
                    f"imageID={cs.get('imageID')} node={pod['spec'].get('nodeName')} "
                    f"labels={pod['metadata'].get('labels')}\n")
            f.flush()
            followers[key] = subprocess.Popen(
                ["kubectl", "--context", CONTEXT, "-n", uns, "logs", "-f", name, "-c", UNIT_CONTAINER],
                stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            print(f"[k8s-stack] following {uns}/{name} -> {out / (key + '.log')}", flush=True)
        time.sleep(2)


# ------------------------------------------- what the driver's StackControl asks


def unit_pod(ns: str, cuid: int) -> dict:
    """The pod of computing unit `cuid`: the one the managing service labelled with its id."""
    pods = [p for p in _unit_pods(ns) if (p["metadata"].get("labels") or {}).get("cuid") == str(cuid)]
    if len(pods) != 1:
        die(f"expected one pod of computing unit {cuid} in {unit_namespace(ns)}, found {len(pods)}")
    return pods[0]


def unit_facts(pod: dict) -> dict:
    """What the driver asks about a unit's pod: its address, and the names of the
    environment variables its engine container was given."""
    engine = next((c for c in pod["spec"].get("containers") or [] if c.get("name") == UNIT_CONTAINER), {})
    return {"pod": pod["metadata"]["name"], "address": (pod.get("status") or {}).get("podIP"),
            "env_names": sorted(e["name"] for e in engine.get("env") or [] if e.get("name"))}


def delete_unit_pod(ns: str, cuid: int, force: bool) -> dict:
    """Delete the unit's pod and wait until it is gone: with `force` at once, as when its node
    is lost (the engine is killed); otherwise with the pod's grace period (SIGTERM first)."""
    pod = unit_pod(ns, cuid)["metadata"]["name"]
    args = ["delete", "pod", pod, "--wait=true", "--timeout=180s"]
    if force:
        args += ["--grace-period=0", "--force"]
    t0 = time.time()
    kubectl(*args, ns=unit_namespace(ns), capture=True, timeout=240)
    return {"cuid": cuid, "pod": pod, "how": "kubectl " + " ".join(args[:2] + args[3:]),
            "seconds": round(time.time() - t0, 1)}


def pg_backends(ns: str) -> list[dict]:
    """Postgres's client connections, asked inside its pod. The password is the one the pod
    itself holds, as the chart's init script uses it."""
    script = 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U postgres -d texera_db "$@"'
    p = kubectl("exec", f"{POSTGRES_STS}-0", "--", "sh", "-c", script, "sh", *pg_activity.PSQL_ARGS,
                ns=ns, capture=True, timeout=60)
    return pg_activity.parse(p.stdout)


def cmd_unit_kill(a) -> None:
    print(json.dumps(delete_unit_pod(a.namespace, a.cuid, force=True)))


def cmd_unit_stop(a) -> None:
    print(json.dumps(delete_unit_pod(a.namespace, a.cuid, force=False)))


def cmd_unit_env(a) -> None:
    print(json.dumps({"cuid": a.cuid, **unit_facts(unit_pod(a.namespace, a.cuid))}))


def cmd_pg_activity(a) -> None:
    print(json.dumps(pg_backends(a.namespace)))


def main() -> None:
    ap = argparse.ArgumentParser(
        prog="k8s-stack.sh",
        description="Texera on OrbStack Kubernetes from a worktree's Helm chart (release 'texera').")
    ap.add_argument("--source", type=Path, default=Path(os.environ.get("SCE_SOURCE", DEFAULT_SOURCE)),
                    help="Texera worktree whose bin/k8s chart is deployed (default: %(default)s)")
    ap.add_argument("--namespace", default=DEFAULT_NAMESPACE,
                    help="release namespace; units go to <namespace>-units (default %(default)s)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def gen_args(p):
        p.add_argument("--images", help="<registry>/<tag> of the texera-* images (default "
                                        "ghcr.io/apache/latest), e.g. sce/step1")
        p.add_argument("--port", type=int, default=DEFAULT_PORT,
                       help="local port for the gateway port-forward (default %(default)s)")
        p.add_argument("--profile", choices=["development", "default"], default="development",
                       help="chart values layered under the overrides: values-development.yaml "
                            "(the chart's single-node profile, default) or only values.yaml")
        p.add_argument("--no-workarounds", action="store_true",
                       help="deploy without the harness's workarounds for chart bugs")
        p.add_argument("--fast-record", action="store_true",
                       help="step 3's timers shortened, as Helm values (texeraEnvVars): the unit commits "
                            "every 2 s; the Dashboard closes every 2 s, loses a unit after 12 s, an "
                            "unstarted execution after 15 s, and expires results after 20 s")

    p = sub.add_parser("generate", help="write stack/k8s/generated/ (chart copy, values, render)")
    gen_args(p)
    p = sub.add_parser("up", help="install, wait until ready, port-forward the gateway")
    gen_args(p)
    p.add_argument("--timeout", type=int, default=int(os.environ.get("SCE_K8S_UP_TIMEOUT", "900")),
                   help="seconds to wait for every workload (default %(default)s)")
    p.add_argument("--helm-timeout", type=int, default=900, help="helm install --timeout in seconds")
    p.add_argument("--forward", choices=["relay", "kubectl"], default=DEFAULT_FORWARD,
                   help="how 127.0.0.1:<port> reaches the gateway: a TCP relay to the envoy Service's "
                        "ClusterIP (OrbStack routes it from macOS; `up` fails when it cannot reach it) or "
                        "kubectl port-forward, which drops at every websocket close and marks a run "
                        "unreliable (default %(default)s)")
    p.add_argument("--allow-crd-drift", action="store_true",
                   help="deploy even when the cluster's Gateway API or Envoy Gateway CRDs differ from the "
                        "chart's (Helm never upgrades existing CRDs); recorded in MANIFEST.json")
    sub.add_parser("down", help="uninstall, delete both namespaces and leftover cluster objects "
                                "(not the CRDs: Helm never deletes them)")
    p = sub.add_parser("status", help="release, pods, port-forward, healthcheck")
    p.add_argument("--json", action="store_true")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p = sub.add_parser("logs", help="logs of a service (alias, deploy/<name>, unit, unit-<cuid>, envoy)")
    p.add_argument("service")
    p.add_argument("--tail", type=int, default=200)
    p.add_argument("-f", "--follow", action="store_true")
    p = sub.add_parser("port-forward", help="start | stop | status the gateway port-forward")
    p.add_argument("action", choices=["start", "stop", "status"])
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--forward", choices=["relay", "kubectl"], default=DEFAULT_FORWARD)
    p = sub.add_parser("collect-logs", help="dump logs, events and objects of both namespaces")
    p.add_argument("dir", type=Path)
    p = sub.add_parser("follow-units", help="stream every unit pod's log into a directory")
    p.add_argument("dir", type=Path)
    p = sub.add_parser("post-run", help="after a driver run: the unit's pod is gone, the driver's refusal "
                                        "probes were ext-authz's; folded into the report (exit 4 on a failure)")
    p.add_argument("report", type=Path)
    p.add_argument("--wait", type=float, default=90, help="seconds to wait for unit pods to go")
    p.add_argument("--unit-kept", action="store_true", help="the driver ran with --keep-unit")
    p.add_argument("--out", type=Path, help="also write the outcome to this JSON file")
    for name, what in (("unit-kill", "delete a unit's pod at once (--grace-period=0 --force): the unit is lost"),
                       ("unit-stop", "delete a unit's pod with its grace period: the unit is stopped politely"),
                       ("unit-env", "a unit pod's address and the names of its engine's environment variables")):
        p = sub.add_parser(name, help=what + " (JSON)")
        p.add_argument("cuid", type=int)
    sub.add_parser("pg-activity", help="Postgres's client connections, from pg_stat_activity (JSON)")
    p = sub.add_parser("_pf-supervise", help=argparse.SUPPRESS)
    p.add_argument("--port", type=int, required=True)

    a = ap.parse_args()
    a.source = a.source.expanduser().resolve()
    {
        "generate": cmd_generate,
        "up": cmd_up,
        "down": cmd_down,
        "status": cmd_status,
        "logs": cmd_logs,
        "port-forward": cmd_port_forward,
        "collect-logs": cmd_collect_logs,
        "follow-units": cmd_follow_units,
        "post-run": cmd_post_run,
        "unit-kill": cmd_unit_kill,
        "unit-stop": cmd_unit_stop,
        "unit-env": cmd_unit_env,
        "pg-activity": cmd_pg_activity,
        "_pf-supervise": cmd_pf_supervise,
    }[a.cmd](a)


if __name__ == "__main__":
    main()
