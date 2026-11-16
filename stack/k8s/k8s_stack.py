#!/usr/bin/env python3
"""Deploy Texera into OrbStack Kubernetes from a worktree's Helm chart, for the e2e driver.

The source of truth is a Texera worktree's bin/k8s chart. `generate` copies it into
stack/k8s/generated/chart/ (symlinks dereferenced, so the chart's files/*.sql come along),
resolves the subchart dependencies there with `helm dependency update` (the repository's
Chart.lock is out of sync with Chart.yaml, so `helm dependency build` -- what
bin/k8s/install.sh runs -- fails), and writes a values override file that points every
Texera image, the computing-unit image included, at --images.

`up` installs the chart as Helm release `texera` in a dedicated namespace (default
`sce-k8s`, units in `sce-k8s-units`), waits until every workload is ready, port-forwards
the Envoy gateway to 127.0.0.1:<port>, and checks each backend answers through it.
`down` uninstalls the release and deletes both namespaces (and with them any unit pod)
plus the cluster-scoped hook objects the chart leaves behind.

Commands: generate | up | down | status | logs | port-forward | collect-logs | follow-units.
Everything runs against the kube context `orbstack` (SCE_K8S_CONTEXT); nothing outside
the two namespaces and this release's cluster-scoped objects is ever changed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
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


def generate(source: Path, registry: str, tag: str, ns: str, port: int, profile: str,
             workarounds: bool, metrics_server: bool = True) -> dict:
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

    s3_endpoint = (base_values.get("storage") or {}).get("s3", {}).get("endpoint") \
        or f"http://{RELEASE}-rustfs-svc:9000"
    webserver_tpl = CHART_DIR / "templates" / "base" / "webserver" / "webserver-deployment.yaml"
    webserver_has_s3 = webserver_tpl.exists() and "STORAGE_S3_ENDPOINT" in webserver_tpl.read_text()
    if workarounds and not webserver_has_s3:
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
            "detail": "bin/k8s webserver-deployment.yaml sets no STORAGE_S3_*; POST /api/warehouse "
                      "fails. Added STORAGE_S3_ENDPOINT=" + s3_endpoint + " through texeraEnvVars "
                      "(Step 2 sub-part 7 fixes it; the step1 chart does not have the fix).",
        })

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
    VALUES_FILE.write_text(header + yaml.safe_dump(overrides, sort_keys=False, width=1000))
    values_files.append(VALUES_FILE)

    p = run(["helm", "template", RELEASE, str(CHART_DIR), "-n", ns,
             *sum((["-f", str(v)] for v in values_files), [])], capture=True, timeout=120)
    RENDERED.write_text(p.stdout)
    docs = _rendered_docs()

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
        "workarounds": applied,
        "harness_choices": [
            f"release name '{RELEASE}': gateway-routes.yaml hard-codes the Backend texera-dynamic-backend",
            "agent-service, litellm, notebook migration and the example loader are disabled",
            f"pullPolicy {pull_policy} for the Texera services and (KUBERNETES_IMAGE_PULL_POLICY) the unit pods",
            f"units in namespace {unit_namespace(ns)} (workflowComputingUnitPool.namespace)",
            "the gateway is forwarded to 127.0.0.1:<port> (OrbStack k8s.expose_services is off): a TCP "
            "relay to the envoy Service's ClusterIP; kubectl port-forward exits whenever Envoy resets "
            "one forwarded connection (websocket closes do)",
        ],
        "port": port,
        "gateway_url": f"http://127.0.0.1:{port}",
    }
    write_json(MANIFEST, manifest)
    return manifest


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
    return pending, failures, {"envoy_deployments": [d["metadata"]["name"] for d in envoy]}


def _pod_problems(ns: str, since: float) -> tuple[list[str], list[str]]:
    """(fatal, warnings) from container states of pods that `up` waits for."""
    fatal, warn = [], []
    for pod in kjson("get", "pods", ns=ns).get("items", []):
        name = pod["metadata"]["name"]
        if any(name.startswith(o) for o in OPTIONAL_WORKLOADS):
            continue
        statuses = (pod.get("status") or {}).get("initContainerStatuses", []) + \
            (pod.get("status") or {}).get("containerStatuses", [])
        for cs in statuses or []:
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
                if (cs.get("restartCount") or 0) >= 6:
                    fatal.append(f"pod/{name} container {cs['name']}: CrashLoopBackOff "
                                 f"({cs.get('restartCount')} restarts)")
                else:
                    warn.append(f"pod/{name}:CrashLoopBackOff({cs.get('restartCount')})")
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
    while time.time() < deadline:
        pending, failures, facts = _workload_status(ns)
        fatal, warn = _pod_problems(ns, t0)
        if failures or fatal:
            _dump_failure(ns, failures + fatal)
            die("deployment failed:\n  " + "\n  ".join(failures + fatal))
        if not pending:
            log(f"all workloads ready after {time.time() - t0:.0f}s")
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
      OrbStack routes from macOS. Each connection is independent.
    kubectl: `kubectl port-forward svc/<envoy>`, restarted whenever it exits. It exits
      ("lost connection to pod") as soon as the pod side resets any one forwarded
      connection, which closing a workflow websocket through Envoy does; requests in the
      second until the restart fail. Used when the ClusterIP is not reachable."""
    if pf_running():
        return {"mode": pf_mode(), "already_running": True}
    info: dict = {"mode": mode}
    if mode == "relay":
        target = relay_target(ns)
        if not target or not host_reaches(*target):
            log(f"the envoy Service's ClusterIP ({target}) is not reachable from this host; "
                "using kubectl port-forward")
            mode = info["mode"] = "kubectl"
            info["relay_unreachable"] = f"{target}"
        else:
            info["target"] = f"{target[0]}:{target[1]}"
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


# ----------------------------------------------------------------------- commands


def cmd_generate(a) -> None:
    reg, tag = parse_images(a.images)
    m = generate(a.source, reg, tag, a.namespace, a.port, a.profile, not a.no_workarounds)
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
                 metrics_server=facts["metrics_server"])
    log(f"chart {m['chart_source']} @ {m['source_git'].get('head', '')[:10]}; images {reg}/texera-*:{tag} "
        f"(pull {m['images']['pull_policy']}); workarounds: "
        f"{', '.join(w['name'] for w in m['workarounds']) or 'none'}")
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
    m.update({"deployed_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
              "up_seconds": round(time.time() - t0), "envoy": facts.get("envoy_deployments"),
              "envoy_service": envoy_service(ns), "gateway_forward": forward, "gateway_probes": probes})
    write_json(MANIFEST, m)
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

    p = sub.add_parser("generate", help="write stack/k8s/generated/ (chart copy, values, render)")
    gen_args(p)
    p = sub.add_parser("up", help="install, wait until ready, port-forward the gateway")
    gen_args(p)
    p.add_argument("--timeout", type=int, default=int(os.environ.get("SCE_K8S_UP_TIMEOUT", "900")),
                   help="seconds to wait for every workload (default %(default)s)")
    p.add_argument("--helm-timeout", type=int, default=900, help="helm install --timeout in seconds")
    p.add_argument("--forward", choices=["relay", "kubectl"], default=DEFAULT_FORWARD,
                   help="how 127.0.0.1:<port> reaches the gateway: a TCP relay to the envoy Service's "
                        "ClusterIP (OrbStack routes it from macOS) or kubectl port-forward (default "
                        "%(default)s; relay falls back to kubectl when the ClusterIP is unreachable)")
    sub.add_parser("down", help="uninstall, delete both namespaces and leftover cluster objects")
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
        "_pf-supervise": cmd_pf_supervise,
    }[a.cmd](a)


if __name__ == "__main__":
    main()
