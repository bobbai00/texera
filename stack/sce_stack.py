#!/usr/bin/env python3
"""Generate and drive the isolated "sce" copy of Texera's single-node stack.

The source of truth is a Texera worktree's bin/single-node deployment
(docker-compose.yml, .env, nginx.conf) and its sql/ DDL. `generate` writes a
renamed copy into stack/generated/ that can never collide with the user's own
single-node stack:

  * compose project `sce`, every container named `sce-<original name>`;
  * the original service and container names kept as network aliases, so the
    services (and the hostnames baked into .env / nginx.conf) still resolve;
  * its own network (`sce-net`) and volumes (`sce_<volume>`);
  * the same host ports as the original (8080 UI/API, 9000 RustFS), bound to
    127.0.0.1 by default;
  * optional parts dropped (observability, LiteLLM, agent-service, Jupyter,
    notebook migration, the example loader and the startup banner); nginx
    answers 503 on the routes of a dropped service;
  * a healthcheck added for the computing unit, which has none upstream.

Commands: generate | up | down | reset | status | logs. See --help.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
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
DEFAULT_SOURCE = Path("/Users/jiadongb/Desktop/projects/texera-worktrees/self-contained-engine")

PROJECT = "sce"
PREFIX = "sce"
NETWORK = "sce-net"
VOLUME_PREFIX = "sce_"

DEFAULT_REGISTRY = "ghcr.io/apache"
DEFAULT_TAG = "latest"

# Services a workflow run does not need. They are not profile-gated upstream,
# so they would otherwise start with the stack.
OPTIONAL_SERVICES = {
    "litellm",
    "agent-service",
    "notebook-migration-service",
    "jupyter",
    "startup-message",
}
# The computing unit has no healthcheck upstream; `up` needs one to know the
# engine is accepting websockets.
UNIT_SERVICE = "workflow-runtime-coordinator-service"
UNIT_HEALTHCHECK = {
    "test": ["CMD", "curl", "-sf", "http://localhost:8085/api/execution/health"],
    "interval": "5s",
    "timeout": "3s",
    "retries": 60,
    "start_period": "20s",
}
NGINX_SERVICE = "nginx"


# --------------------------------------------------------------------------- utils


def log(msg: str) -> None:
    print(f"[sce-stack] {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"[sce-stack] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def run(cmd: list[str], check: bool = True, capture: bool = False, **kw) -> subprocess.CompletedProcess:
    if capture:
        kw.setdefault("stdout", subprocess.PIPE)
        kw.setdefault("stderr", subprocess.PIPE)
        kw.setdefault("text", True)
    proc = subprocess.run(cmd, **kw)
    if check and proc.returncode != 0:
        detail = ""
        if capture:
            detail = f"\n{(proc.stdout or '')[-4000:]}{(proc.stderr or '')[-4000:]}"
        die(f"command failed ({proc.returncode}): {' '.join(cmd)}{detail}")
    return proc


def git_info(source: Path) -> dict:
    # GIT_OPTIONAL_LOCKS=0: `git status` must not refresh (and lock) the index of a
    # worktree someone else may be committing in at the same moment.
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")

    def g(*args: str) -> str:
        p = subprocess.run(["git", "-C", str(source), *args], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True, env=env)
        return p.stdout.strip() if p.returncode == 0 else ""

    return {
        "head": g("rev-parse", "HEAD"),
        "branch": g("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(g("status", "--porcelain", "--untracked-files=no")),
    }


def parse_images(spec: str | None) -> tuple[str, str]:
    """`<registry>/<tag>` or `<registry>:<tag>` -> (registry, tag)."""
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


# ------------------------------------------------------------------------ generate


def _rewrite_env(src_env: str, overrides: dict[str, str]) -> str:
    out, seen = [], set()
    for line in src_env.splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line)
        if m and m.group(1) in overrides:
            key = m.group(1)
            out.append(f"{key}={overrides[key]}")
            seen.add(key)
        else:
            out.append(line)
    missing = [k for k in overrides if k not in seen]
    if missing:
        out.append("")
        out.append("# Added by the sce e2e stack generator")
        out.extend(f"{k}={overrides[k]}" for k in missing)
    return "\n".join(out) + "\n"


def _location_blocks(conf: str):
    """Yield (start, end, body) for every `location ... { ... }` (no nested braces)."""
    for m in re.finditer(r"location\s+[^{]*\{[^{}]*\}", conf):
        yield m.start(), m.end(), m.group(0)


def _rewrite_nginx(conf: str, dropped: set[str]) -> tuple[str, list[str]]:
    disabled_routes: list[str] = []
    pieces, last = [], 0
    for start, end, block in _location_blocks(conf):
        target = re.search(r"proxy_pass\s+https?://([A-Za-z0-9_.-]+)", block)
        if target and target.group(1) in dropped:
            head = block[: block.index("{")].strip()
            indent = re.search(r"\n([ \t]*)[^\s]", block)
            pad = indent.group(1) if indent else "            "
            new_block = (
                f"{head} {{\n{pad}# {target.group(1)} is not part of the sce e2e stack\n"
                f"{pad}return 503 \"{target.group(1)} is disabled in the sce e2e stack\\n\";\n"
                f"{pad[:-4] if len(pad) >= 4 else ''}}}"
            )
            pieces.append(conf[last:start])
            pieces.append(new_block)
            last = end
            disabled_routes.append(head)
    pieces.append(conf[last:])
    return "".join(pieces), disabled_routes


def _rewrite_ports(ports: list, bind: str) -> list:
    out = []
    for p in ports:
        if isinstance(p, dict):
            p = dict(p)
            if bind and not p.get("host_ip"):
                p["host_ip"] = bind
            out.append(p)
            continue
        s = str(p)
        # "${VAR:-9000}:9000" has a ':' inside the interpolation; count the
        # colons outside ${...} to tell HOST:CONTAINER from IP:HOST:CONTAINER.
        outside = re.sub(r"\$\{[^}]*\}", "X", s)
        if bind and outside.count(":") == 1:
            s = f"{bind}:{s}"
        out.append(s)
    return out


#: keys the generator is allowed to change on a kept service
_REWRITTEN_KEYS = {"container_name", "networks", "depends_on", "ports", "volumes", "healthcheck"}


def _self_check(original: dict, generated: dict, dropped: set[str]) -> None:
    """Re-read the written compose and prove every kept service is the original
    except for the keys the generator rewrites on purpose."""
    problems = []
    if set(generated) != set(original) - dropped:
        problems.append(f"service set differs: {sorted(set(generated) ^ (set(original) - dropped))}")
    for name, gen in generated.items():
        orig = original.get(name, {})
        for key in set(orig) | set(gen):
            if key in _REWRITTEN_KEYS:
                continue
            if orig.get(key) != gen.get(key):
                problems.append(f"{name}.{key} changed")
        if "healthcheck" in orig and orig["healthcheck"] != gen.get("healthcheck"):
            problems.append(f"{name}.healthcheck changed")
        dep_o, dep_g = orig.get("depends_on"), gen.get("depends_on")
        if dep_o is not None:
            want = ([d for d in dep_o if d not in dropped] if isinstance(dep_o, list)
                    else {k: v for k, v in dep_o.items() if k not in dropped})
            if (want or None) != dep_g:
                problems.append(f"{name}.depends_on differs beyond dropped services")
    if problems:
        die("generated compose failed its round-trip check: " + "; ".join(problems))


class _Dumper(yaml.SafeDumper):
    """Writes multi-line strings (the init scripts) as literal blocks when YAML allows it."""


def _str_presenter(dumper: yaml.SafeDumper, data: str):
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


_Dumper.add_representer(str, _str_presenter)


def generate(source: Path, registry: str, tag: str, bind: str, with_optional: bool) -> dict:
    sn = source / "bin" / "single-node"
    compose_src = sn / "docker-compose.yml"
    for f in (compose_src, sn / ".env", sn / "nginx.conf", source / "sql"):
        if not f.exists():
            die(f"source worktree is missing {f}")

    compose = yaml.safe_load(compose_src.read_text())
    services: dict = compose["services"]

    dropped = {name for name, svc in services.items() if svc.get("profiles")}
    if not with_optional:
        dropped |= OPTIONAL_SERVICES & set(services)

    if GEN_DIR.exists():
        shutil.rmtree(GEN_DIR)
    GEN_DIR.mkdir(parents=True)
    (GEN_DIR / "mounts").mkdir()

    used_volumes: set[str] = set()
    new_services: dict = {}
    container_names: dict[str, str] = {}
    for name, svc in services.items():
        if name in dropped:
            continue
        svc = dict(svc)
        original_cn = svc.get("container_name", name)
        svc["container_name"] = f"{PREFIX}-{original_cn}"
        container_names[name] = svc["container_name"]
        aliases = sorted({name, original_cn})
        svc["networks"] = {"default": {"aliases": aliases}}

        dep = svc.get("depends_on")
        if isinstance(dep, list):
            dep = [d for d in dep if d not in dropped]
            svc["depends_on"] = dep
        elif isinstance(dep, dict):
            dep = {k: v for k, v in dep.items() if k not in dropped}
            svc["depends_on"] = dep
        if not svc.get("depends_on"):
            svc.pop("depends_on", None)

        if "ports" in svc:
            svc["ports"] = _rewrite_ports(svc["ports"], bind)

        vols = []
        for v in svc.get("volumes", []):
            if isinstance(v, dict):
                vols.append(v)
                continue
            parts = str(v).split(":")
            src_part = parts[0]
            if src_part.startswith((".", "/")):
                src_path = (sn / src_part).resolve()
                if src_path == (source / "sql").resolve():
                    dst = GEN_DIR / "sql"
                    dst.mkdir()
                    # Postgres runs only the top-level scripts of the init dir.
                    for f in sorted(src_path.iterdir()):
                        if f.is_file() and f.suffix in (".sql", ".sh"):
                            shutil.copy2(f, dst / f.name)
                    parts[0] = "./sql"
                    if len(parts) == 2:
                        parts.append("ro")
                elif src_path.name == "nginx.conf":
                    parts[0] = "./nginx.conf"  # rewritten below
                else:
                    dst = GEN_DIR / "mounts" / src_path.name
                    if src_path.is_dir():
                        shutil.copytree(src_path, dst)
                    elif src_path.exists():
                        shutil.copy2(src_path, dst)
                    else:
                        die(f"bind-mount source {src_path} (service {name}) does not exist")
                    parts[0] = f"./mounts/{src_path.name}"
                vols.append(":".join(parts))
            else:
                used_volumes.add(src_part)
                vols.append(str(v))
        if vols:
            svc["volumes"] = vols

        if name == UNIT_SERVICE and "healthcheck" not in svc:
            svc["healthcheck"] = dict(UNIT_HEALTHCHECK)

        new_services[name] = svc

    volumes = {}
    for key in sorted(used_volumes):
        volumes[key] = {"name": f"{VOLUME_PREFIX}{key}"}

    out = {
        "name": PROJECT,
        "services": new_services,
        "networks": {"default": {"name": NETWORK}},
        "volumes": volumes,
    }

    header = (
        "# GENERATED by sce-e2e/stack/sce_stack.py -- do not edit; re-run `sce-stack.sh generate`.\n"
        f"# source: {compose_src}\n"
    )
    (GEN_DIR / "docker-compose.yml").write_text(
        header + yaml.dump(out, Dumper=_Dumper, sort_keys=False, width=1000,
                           default_flow_style=False, allow_unicode=True)
    )

    env_overrides = {
        "IMAGE_REGISTRY": registry,
        "IMAGE_TAG": tag,
        "COMPOSE_PROFILES": "",
    }
    if "agent-service" in dropped:
        env_overrides["GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED"] = "false"
    if "notebook-migration-service" in dropped:
        env_overrides["GUI_WORKFLOW_WORKSPACE_PYTHON_NOTEBOOK_MIGRATION_ENABLED"] = "false"
    (GEN_DIR / ".env").write_text(_rewrite_env((sn / ".env").read_text(), env_overrides))

    nginx_conf, disabled_routes = _rewrite_nginx((sn / "nginx.conf").read_text(), dropped)
    (GEN_DIR / "nginx.conf").write_text(nginx_conf)

    _self_check(services, yaml.safe_load((GEN_DIR / "docker-compose.yml").read_text())["services"],
                dropped)

    env_vals = dict(
        re.findall(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", (GEN_DIR / ".env").read_text(), re.M)
    )
    manifest = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": str(source),
        "source_git": git_info(source),
        "project": PROJECT,
        "network": NETWORK,
        "volumes": [v["name"] for v in volumes.values()],
        "containers": container_names,
        "dropped_services": sorted(dropped),
        "nginx_routes_answering_503": disabled_routes,
        "images": {"registry": registry, "tag": tag},
        "bind": bind or "0.0.0.0",
        "ports": {
            "texera": int(env_vals.get("TEXERA_PORT", "8080") or 8080),
            "rustfs": int(env_vals.get("RUSTFS_PORT", "9000") or 9000),
        },
    }
    (GEN_DIR / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


# ------------------------------------------------------------------- compose glue


def load_manifest() -> dict:
    f = GEN_DIR / "MANIFEST.json"
    if not f.exists():
        die("stack/generated/ does not exist yet; run `sce-stack.sh up` (or `generate`) first")
    return json.loads(f.read_text())


def compose_cmd(*args: str) -> list[str]:
    return [
        "docker", "compose",
        "-p", PROJECT,
        "-f", str(GEN_DIR / "docker-compose.yml"),
        "--env-file", str(GEN_DIR / ".env"),
        *args,
    ]


def compose_env() -> dict[str, str]:
    """The environment docker compose runs with: the caller's, minus every variable
    the generated .env defines (and compose's own selectors). Compose lets the shell
    override the env file during interpolation, so an exported IMAGE_TAG,
    IMAGE_REGISTRY or TEXERA_PORT would otherwise silently replace --images (while
    the manifest and the report still name the requested images) or move a port."""
    env = dict(os.environ)
    gen_env = GEN_DIR / ".env"
    keys = re.findall(r"^([A-Za-z_][A-Za-z0-9_]*)=", gen_env.read_text(), re.M) if gen_env.exists() else []
    for key in [*keys, "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "COMPOSE_ENV_FILES"]:
        env.pop(key, None)
    return env


def compose(*args: str, **kw) -> subprocess.CompletedProcess:
    return run(compose_cmd(*args), env=compose_env(), **kw)


def compose_ps() -> list[dict]:
    p = compose("ps", "-a", "--format", "json", capture=True)
    text = p.stdout.strip()
    if not text:
        return []
    if text.startswith("["):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def compose_services() -> dict:
    return yaml.safe_load((GEN_DIR / "docker-compose.yml").read_text())["services"]


def _host_port_holders(port: int) -> list[tuple[str, str]]:
    """(container, compose project) of running containers publishing `port` on the host."""
    p = run(["docker", "ps", "--format",
             '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Ports}}'], capture=True)
    holders = []
    for line in p.stdout.splitlines():
        cols = line.split("\t")
        if len(cols) < 3:
            continue
        # e.g. "0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp, 127.0.0.1:9000->9000/tcp"
        if re.search(rf"(^|[\s,]|\]|\d):{port}->", cols[2]):
            holders.append((cols[0], cols[1]))
    return holders


def _listening(addr: str, port: int) -> bool:
    """True if something accepts TCP connections on addr:port."""
    family = socket.AF_INET6 if ":" in addr else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as c:
            c.settimeout(1)
            return c.connect_ex((addr, port)) == 0
    except OSError:
        return False


def check_ports_free(manifest: dict) -> None:
    for label, port in manifest["ports"].items():
        holders = _host_port_holders(port)
        foreign = [h for h in holders if h[1] != PROJECT]
        if foreign:
            die(f"host port {port} ({label}) is published by container(s) "
                f"{', '.join(h[0] for h in foreign)}; stop them first (this script never touches them)")
        if holders:
            continue  # ours
        # The bind probe below misses a listener on the wildcard address: on macOS a
        # SO_REUSEADDR bind of 127.0.0.1 succeeds next to a socket on 0.0.0.0/[::].
        # The driver's http://localhost resolves to ::1 first, so it would then talk
        # to that process (e.g. a native local-dev server) instead of this stack.
        for addr in ("127.0.0.1", "::1"):
            if _listening(addr, port):
                die(f"host port {port} ({label}) is in use by a non-docker process "
                    f"(it accepts connections on {addr}); stop it first")
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                die(f"host port {port} ({label}) is in use by a non-docker process")


def check_images(manifest: dict) -> None:
    services = compose_services()
    reg, tag = manifest["images"]["registry"], manifest["images"]["tag"]
    missing = []
    for svc in services.values():
        image = (svc.get("image") or "")
        image = image.replace("${IMAGE_REGISTRY:-ghcr.io/apache}", reg).replace("${IMAGE_TAG:-latest}", tag)
        if "${" in image:
            continue
        if run(["docker", "image", "inspect", image], check=False, capture=True).returncode != 0:
            missing.append(image)
    if missing:
        pull = os.environ.get("SCE_PULL", "missing")
        texera_missing = [m for m in missing if "/texera-" in m and not m.startswith("ghcr.io/")]
        if texera_missing:
            die("these images are not present locally (build them with images/build.sh):\n  "
                + "\n  ".join(texera_missing))
        if pull == "never":
            die("images missing locally and SCE_PULL=never:\n  " + "\n  ".join(missing))
        log("images not present locally (compose will pull them):\n  " + "\n  ".join(missing))


def wait_healthy(timeout: int, manifest: dict) -> None:
    services = compose_services()
    one_shot = {n for n, s in services.items() if str(s.get("restart", "")).lower() == "no"}
    with_hc = {n for n, s in services.items() if "healthcheck" in s}
    deadline = time.time() + timeout
    last_report = 0.0
    pending: list[str] = []
    while time.time() < deadline:
        rows = {r["Service"]: r for r in compose_ps()}
        pending, failed = [], []
        for name in services:
            r = rows.get(name)
            if r is None:
                pending.append(f"{name}(absent)")
                continue
            state = (r.get("State") or "").lower()
            health = (r.get("Health") or "").lower()
            if name in one_shot:
                if state == "exited":
                    if int(r.get("ExitCode", 1)) != 0:
                        failed.append(f"{name} exited {r.get('ExitCode')}")
                else:
                    pending.append(f"{name}({state})")
            elif name in with_hc:
                if state in ("exited", "dead"):
                    failed.append(f"{name} {state} (exit {r.get('ExitCode')})")
                elif health != "healthy":
                    pending.append(f"{name}({state}/{health or 'starting'})")
            elif state != "running":
                if state in ("exited", "dead"):
                    failed.append(f"{name} {state} (exit {r.get('ExitCode')})")
                else:
                    pending.append(f"{name}({state})")
        if failed:
            for f in failed:
                svc = f.split()[0]
                print(f"----- last log lines of {svc} -----", file=sys.stderr)
                compose("logs", "--no-color", "--tail", "60", svc, check=False)
            die("services failed: " + "; ".join(failed))
        if not pending:
            break
        if time.time() - last_report > 15:
            log(f"waiting for {len(pending)} service(s): {', '.join(pending)}")
            last_report = time.time()
        time.sleep(3)
    else:
        die(f"timed out after {timeout}s; still pending: {', '.join(pending)}")
    log("all containers are up, healthy, and init jobs finished")


def http_ok(url: str, timeout: float = 5) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return 200 <= r.status < 300
    except (urllib.error.URLError, OSError, ValueError):
        return False


def wait_http(url: str, timeout: int) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if http_ok(url):
            log(f"{url} answers 200")
            return
        time.sleep(2)
    die(f"{url} did not answer 200 within {timeout}s")


# ----------------------------------------------------------------------- commands


def cmd_generate(a) -> None:
    reg, tag = parse_images(a.images)
    m = generate(a.source, reg, tag, a.bind, a.with_optional)
    log(f"generated {GEN_DIR} from {m['source']} @ {m['source_git'].get('head', '?')[:10]} "
        f"({m['source_git'].get('branch', '?')}{', dirty' if m['source_git'].get('dirty') else ''})")
    log(f"images: {reg}/texera-*:{tag}; dropped: {', '.join(m['dropped_services'])}")


def cmd_up(a) -> None:
    if a.no_generate:
        manifest = load_manifest()
        if a.images:
            die("--images needs a regenerate; drop --no-generate")
    else:
        cmd_generate(a)
        manifest = load_manifest()
    check_ports_free(manifest)
    check_images(manifest)
    pull = os.environ.get("SCE_PULL", "missing")
    log(f"docker compose up -d (project {PROJECT}, pull={pull})")
    compose("up", "-d", "--remove-orphans", "--pull", pull)
    wait_healthy(a.timeout, manifest)
    # nginx resolves its upstreams once at start; a service recreated by this
    # `up` would otherwise keep receiving traffic at its old address.
    compose("restart", NGINX_SERVICE, capture=True)
    port = manifest["ports"]["texera"]
    wait_http(f"http://127.0.0.1:{port}/api/healthcheck", 120)
    log(f"stack is up: http://localhost:{port}  (login texera / texera)")


def cmd_down(a) -> None:
    if (GEN_DIR / "docker-compose.yml").exists():
        compose("down", "--remove-orphans")
    else:
        run(["docker", "compose", "-p", PROJECT, "down", "--remove-orphans"])
    log("stack is down (volumes kept)")


def cmd_reset(a) -> None:
    if (GEN_DIR / "docker-compose.yml").exists():
        compose("down", "--remove-orphans", "--volumes")
    else:
        run(["docker", "compose", "-p", PROJECT, "down", "--remove-orphans", "--volumes"])
    # Belt and braces: anything still labelled as ours, never anything else.
    p = run(["docker", "volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={PROJECT}"],
            capture=True)
    leftovers = [v for v in p.stdout.split() if v.strip()]
    for v in leftovers:
        if v.startswith(VOLUME_PREFIX) or len(v) == 64:
            run(["docker", "volume", "rm", v], check=False, capture=True)
    log("stack reset: containers, network and sce_* volumes removed")


def cmd_status(a) -> None:
    gen = (GEN_DIR / "docker-compose.yml").exists()
    if not gen:
        log("not generated yet")
        return
    manifest = load_manifest()
    rows = compose_ps()
    if a.json:
        print(json.dumps({"manifest": manifest, "containers": rows}, indent=2))
        return
    src = manifest["source_git"]
    print(f"source : {manifest['source']} @ {src.get('head', '')[:10]} ({src.get('branch')})"
          f"{' dirty' if src.get('dirty') else ''}")
    print(f"images : {manifest['images']['registry']}/texera-*:{manifest['images']['tag']}")
    print(f"network: {manifest['network']}   volumes: {', '.join(manifest['volumes'])}")
    if not rows:
        print("(no containers)")
        return
    print(f"{'SERVICE':42} {'CONTAINER':48} {'STATE':10} {'HEALTH':10} IMAGE")
    for r in sorted(rows, key=lambda r: r.get("Service", "")):
        print(f"{r.get('Service', ''):42} {r.get('Name', ''):48} {r.get('State', ''):10} "
              f"{(r.get('Health') or '-'):10} {r.get('Image', '')}")
    port = manifest["ports"]["texera"]
    up = http_ok(f"http://127.0.0.1:{port}/api/healthcheck")
    print(f"\nhttp://localhost:{port}/api/healthcheck -> {'200' if up else 'not answering'}")


LOG_ALIASES = {
    "unit": UNIT_SERVICE,
    "cu": UNIT_SERVICE,
    "dashboard": "dashboard-service",
    "gateway": NGINX_SERVICE,
    "cu-manager": "workflow-computing-unit-managing-service",
    "compiler": "workflow-compiling-service",
    "files": "file-service",
}


def cmd_logs(a) -> None:
    load_manifest()
    services = compose_services()
    svc = LOG_ALIASES.get(a.service, a.service)
    if svc not in services:
        by_container = {s.get("container_name"): n for n, s in services.items()}
        svc = by_container.get(svc) or by_container.get(f"{PREFIX}-{svc}") or svc
    if svc not in services:
        die(f"unknown service '{a.service}'; known: {', '.join(sorted(services))} "
            f"(aliases: {', '.join(sorted(LOG_ALIASES))})")
    args = ["logs", "--no-color", "--tail", str(a.tail)]
    if a.follow:
        args.append("-f")
    os.execvpe("docker", compose_cmd(*args, svc), compose_env())


def main() -> None:
    ap = argparse.ArgumentParser(
        prog="sce-stack.sh",
        description="Isolated copy of Texera's single-node stack (compose project 'sce').",
    )
    ap.add_argument("--source", type=Path, default=Path(os.environ.get("SCE_SOURCE", DEFAULT_SOURCE)),
                    help="Texera worktree whose bin/single-node is copied (default: %(default)s)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def gen_args(p):
        p.add_argument("--images", help="<registry>/<tag> of the texera-* images "
                                        "(default ghcr.io/apache/latest), e.g. sce/step1")
        p.add_argument("--bind", default=os.environ.get("SCE_BIND", "127.0.0.1"),
                       help="host IP for published ports (default %(default)s; '' = all interfaces)")
        p.add_argument("--with-optional", action="store_true",
                       help="keep LiteLLM, agent-service, Jupyter and notebook migration")

    p = sub.add_parser("generate", help="write stack/generated/ from the source worktree")
    gen_args(p)
    p = sub.add_parser("up", help="generate, start, and wait until healthy")
    gen_args(p)
    p.add_argument("--no-generate", action="store_true", help="reuse stack/generated/ as is")
    p.add_argument("--timeout", type=int, default=int(os.environ.get("SCE_UP_TIMEOUT", "900")))
    sub.add_parser("down", help="stop and remove containers and network; keep volumes")
    sub.add_parser("reset", help="down, then delete the sce_* volumes")
    p = sub.add_parser("status", help="container states and the generated manifest")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("logs", help="logs of one service (service or container name)")
    p.add_argument("service")
    p.add_argument("--tail", type=int, default=200)
    p.add_argument("-f", "--follow", action="store_true")

    a = ap.parse_args()
    a.source = a.source.expanduser().resolve()
    {
        "generate": cmd_generate,
        "up": cmd_up,
        "down": cmd_down,
        "reset": cmd_reset,
        "status": cmd_status,
        "logs": cmd_logs,
    }[a.cmd](a)


if __name__ == "__main__":
    main()
