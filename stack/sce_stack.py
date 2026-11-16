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

Options for the evidence checks of the self-contained-engine work (all off by
default, all recorded in MANIFEST.json):

  * --pg-statement-log  Postgres logs every statement with the connection's
    application name, database and client address (and the unit's idle
    cleanup drops to 2 s unless --unit-env sets it);
  * --isolate-unit      the unit sits alone on a second network, sce-unit-net,
    with only Postgres, Lakekeeper, RustFS and nginx (and agent-service when
    kept) beside it, so it cannot reach file-service or LakeFS; nginx's access
    log goes on (client address, method, path without query, status), so a
    request the unit sends through the gateway shows up too;
  * --with-replay-log   the Dashboard and the unit write replay logs under the
    shared result volume;
  * --unit-env KEY=VAL  extra environment for the unit (repeatable).

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
POSTGRES_SERVICE = "postgres"
DASHBOARD_SERVICE = "dashboard-service"

# --pg-statement-log: the compose service has no command upstream, so this one is
# the image's default command plus the logging settings. Extended-protocol
# statements log their values on a following "DETAIL:  parameters:" line of the
# same pid; %a is the connection's application_name (texera-<service> from
# step 2's sub-part 1 on).
PG_LOG_LINE_PREFIX = "%m [%p] app=%a db=%d host=%h "
PG_STATEMENT_LOG_COMMAND = ["postgres", "-c", "log_statement=all",
                            "-c", f"log_line_prefix={PG_LOG_LINE_PREFIX}"]
# With the statement log the unit cleans an idle workflow after 2 s instead of 30,
# so the cleanup of one scenario's execution never lands in the next one's window.
CLEANUP_ENV = "WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS"
CLEANUP_SECONDS_WITH_STATEMENT_LOG = "2"

# --isolate-unit: the unit's own network and the services that join it.
UNIT_NETWORK_KEY = "unit"
UNIT_NETWORK = "sce-unit-net"
UNIT_NETWORK_PEERS = ("postgres", "lakekeeper", "rustfs", NGINX_SERVICE, "agent-service")
# --isolate-unit also turns nginx's access log on (upstream: `access_log off;`): the
# isolated unit still reaches nginx, which proxies file-service and the Dashboard, so
# Check D reads which requests came from the unit's address. $uri has no query
# string, so a websocket's access-token never reaches the log.
GATEWAY_LOG_FORMAT = "sce_e2e"
GATEWAY_ACCESS_LOG = (f"log_format {GATEWAY_LOG_FORMAT} "
                      "'sce-access $remote_addr \"$request_method $uri\" $status';\n"
                      f"    access_log /dev/stdout {GATEWAY_LOG_FORMAT};")

# --with-replay-log: both services mount workflow_result_data at /amber/user-resources.
REPLAY_LOG_ENV = "FAULT_TOLERANCE_LOG_STORAGE_URI"
REPLAY_LOG_URI = "file:///amber/user-resources/recovery-logs/"
REPLAY_LOG_SERVICES = (DASHBOARD_SERVICE, UNIT_SERVICE)

_SECRET_KEY = re.compile(r"TOKEN|SECRET|PASSWORD|PASSWD|KEY", re.I)


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


def _enable_gateway_access_log(conf: str) -> str:
    """Replace the http block's one `access_log off;` with GATEWAY_ACCESS_LOG; refuse a
    source whose nginx.conf does not have exactly one (the edit must be exactly this)."""
    found = re.findall(r"^([ \t]*)access_log\s+off;[ \t]*$", conf, re.M)
    if len(found) != 1:
        die(f"--isolate-unit turns nginx's access log on by replacing its one `access_log off;`; "
            f"the source nginx.conf has {len(found)}")
    new = re.sub(r"^([ \t]*)access_log\s+off;[ \t]*$",
                 lambda m: m.group(1) + GATEWAY_ACCESS_LOG.replace("\n    ", "\n" + m.group(1)),
                 conf, count=1, flags=re.M)
    # round trip: removing the added lines and putting `access_log off;` back gives the source
    back = new.replace(GATEWAY_ACCESS_LOG.replace("\n    ", "\n" + found[0]), "access_log off;")
    if back != conf:
        die("the nginx access-log edit failed its round-trip check")
    return new


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


class StackOptions:
    """The evidence options of `generate` (see the module doc)."""

    def __init__(self, pg_statement_log: bool = False, isolate_unit: bool = False,
                 with_replay_log: bool = False, unit_env: list[str] | None = None):
        self.pg_statement_log = pg_statement_log
        self.isolate_unit = isolate_unit
        self.with_replay_log = with_replay_log
        self.unit_env: dict[str, str] = {}
        for item in unit_env or []:
            key, sep, value = item.partition("=")
            if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                die(f"--unit-env takes KEY=VALUE, got '{item}'")
            self.unit_env[key] = value

    def unit_environment(self) -> dict[str, str]:
        """What the unit gets on top of the source's environment, in order."""
        env: dict[str, str] = {}
        if self.with_replay_log:
            env[REPLAY_LOG_ENV] = REPLAY_LOG_URI
        if self.pg_statement_log and CLEANUP_ENV not in self.unit_env:
            env[CLEANUP_ENV] = CLEANUP_SECONDS_WITH_STATEMENT_LOG
        env.update(self.unit_env)
        return env

    def describe(self) -> dict:
        def shown(key: str, value: str) -> str:
            if _SECRET_KEY.search(key):
                return f"<set, {len(value)} chars>"
            return value

        return {
            "pg_statement_log": self.pg_statement_log,
            "pg_log_line_prefix": PG_LOG_LINE_PREFIX if self.pg_statement_log else None,
            "isolate_unit": self.isolate_unit,
            "unit_network": UNIT_NETWORK if self.isolate_unit else None,
            "gateway_access_log": GATEWAY_LOG_FORMAT if self.isolate_unit else None,
            "with_replay_log": self.with_replay_log,
            "unit_env": {k: shown(k, v) for k, v in self.unit_environment().items()},
            "dashboard_env": ({REPLAY_LOG_ENV: REPLAY_LOG_URI} if self.with_replay_log else {}),
        }


def _with_env(svc: dict, extra: dict[str, str]) -> object:
    """`svc`'s environment (a list or a mapping, as compose allows) with `extra` set;
    a key already present is replaced in place. `$` is escaped for compose."""
    escaped = {k: v.replace("$", "$$") for k, v in extra.items()}
    env = svc.get("environment")
    if isinstance(env, dict):
        out = dict(env)
        out.update(escaped)
        return out
    out_list = list(env or [])
    for key, value in escaped.items():
        idx = next((i for i, e in enumerate(out_list) if str(e).split("=", 1)[0] == key), None)
        if idx is None:
            out_list.append(f"{key}={value}")
        else:
            out_list[idx] = f"{key}={value}"
    return out_list


def _self_check(original: dict, generated: dict, dropped: set[str],
                edits: dict[str, dict] | None = None) -> None:
    """Re-read the written compose and prove every kept service is the original
    except for the keys the generator rewrites on purpose and the option edits,
    which must be exactly what the options asked for."""
    edits = edits or {}
    problems = []
    if set(generated) != set(original) - dropped:
        problems.append(f"service set differs: {sorted(set(generated) ^ (set(original) - dropped))}")
    for name, gen in generated.items():
        orig = original.get(name, {})
        for key in set(orig) | set(gen):
            if key in _REWRITTEN_KEYS:
                continue
            want = edits.get(name, {}).get(key, orig.get(key))
            if want != gen.get(key):
                problems.append(f"{name}.{key} changed" + (" beyond the requested option" if
                                                            key in edits.get(name, {}) else ""))
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


def _check_networks(generated: dict, isolate_unit: bool) -> None:
    """Every service is on sce-net only, except with --isolate-unit: the unit on
    sce-unit-net only, its peers on both, each with its aliases on each."""
    problems = []
    for name, svc in generated.items():
        nets = svc.get("networks") or {}
        if not isolate_unit:
            want = {"default"}
        elif name == UNIT_SERVICE:
            want = {UNIT_NETWORK_KEY}
        elif name in UNIT_NETWORK_PEERS:
            want = {"default", UNIT_NETWORK_KEY}
        else:
            want = {"default"}
        if set(nets) != want:
            problems.append(f"{name} is on {sorted(nets)}, want {sorted(want)}")
        aliases = [sorted((nets.get(n) or {}).get("aliases") or []) for n in nets]
        if any(a != aliases[0] for a in aliases) or not aliases or not aliases[0]:
            problems.append(f"{name} lacks the same aliases on each of its networks")
    if problems:
        die("generated compose failed its network check: " + "; ".join(problems))


class _Dumper(yaml.SafeDumper):
    """Writes multi-line strings (the init scripts) as literal blocks when YAML allows it."""


def _str_presenter(dumper: yaml.SafeDumper, data: str):
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


_Dumper.add_representer(str, _str_presenter)


def generate(source: Path, registry: str, tag: str, bind: str, with_optional: bool,
             options: StackOptions | None = None, out_dir: Path | None = None) -> dict:
    options = options or StackOptions()
    gen_dir = out_dir or GEN_DIR
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
    for needed in [UNIT_SERVICE, POSTGRES_SERVICE] + ([DASHBOARD_SERVICE] if options.with_replay_log else []):
        if needed not in services or needed in dropped:
            die(f"the source compose has no service '{needed}', which the options need")
    if options.pg_statement_log and services[POSTGRES_SERVICE].get("command") is not None:
        die("the source's postgres service already has a command; --pg-statement-log would replace it")

    if gen_dir.exists():
        shutil.rmtree(gen_dir)
    gen_dir.mkdir(parents=True)
    (gen_dir / "mounts").mkdir()

    used_volumes: set[str] = set()
    new_services: dict = {}
    container_names: dict[str, str] = {}
    # option edits, applied below and verified exactly by the round-trip check
    edits: dict[str, dict] = {}
    if options.pg_statement_log:
        edits.setdefault(POSTGRES_SERVICE, {})["command"] = list(PG_STATEMENT_LOG_COMMAND)
    unit_env = options.unit_environment()
    if unit_env:
        edits.setdefault(UNIT_SERVICE, {})["environment"] = _with_env(services[UNIT_SERVICE], unit_env)
    if options.with_replay_log:
        edits.setdefault(DASHBOARD_SERVICE, {})["environment"] = _with_env(
            services[DASHBOARD_SERVICE], {REPLAY_LOG_ENV: REPLAY_LOG_URI})
    for name, svc in services.items():
        if name in dropped:
            continue
        svc = dict(svc)
        original_cn = svc.get("container_name", name)
        svc["container_name"] = f"{PREFIX}-{original_cn}"
        container_names[name] = svc["container_name"]
        aliases = sorted({name, original_cn})
        if options.isolate_unit and name == UNIT_SERVICE:
            svc["networks"] = {UNIT_NETWORK_KEY: {"aliases": aliases}}
        elif options.isolate_unit and name in UNIT_NETWORK_PEERS:
            svc["networks"] = {"default": {"aliases": aliases},
                               UNIT_NETWORK_KEY: {"aliases": list(aliases)}}
        else:
            svc["networks"] = {"default": {"aliases": aliases}}
        for key, value in edits.get(name, {}).items():
            svc[key] = value

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
                    dst = gen_dir / "sql"
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
                    dst = gen_dir / "mounts" / src_path.name
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

    networks = {"default": {"name": NETWORK}}
    if options.isolate_unit:
        # Not `internal`: a unit installing a Python environment needs the package index.
        networks[UNIT_NETWORK_KEY] = {"name": UNIT_NETWORK}
    out = {
        "name": PROJECT,
        "services": new_services,
        "networks": networks,
        "volumes": volumes,
    }

    header = (
        "# GENERATED by sce-e2e/stack/sce_stack.py -- do not edit; re-run `sce-stack.sh generate`.\n"
        f"# source: {compose_src}\n"
    )
    (gen_dir / "docker-compose.yml").write_text(
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
    (gen_dir / ".env").write_text(_rewrite_env((sn / ".env").read_text(), env_overrides))

    nginx_conf, disabled_routes = _rewrite_nginx((sn / "nginx.conf").read_text(), dropped)
    if options.isolate_unit:
        nginx_conf = _enable_gateway_access_log(nginx_conf)
    (gen_dir / "nginx.conf").write_text(nginx_conf)

    written = yaml.safe_load((gen_dir / "docker-compose.yml").read_text())["services"]
    _self_check(services, written, dropped, edits)
    _check_networks(written, options.isolate_unit)

    env_vals = dict(
        re.findall(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", (gen_dir / ".env").read_text(), re.M)
    )
    manifest = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": str(source),
        "source_git": git_info(source),
        "project": PROJECT,
        "network": NETWORK,
        "networks": [n["name"] for n in networks.values()],
        "options": options.describe(),
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
    (gen_dir / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
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


def options_from_args(a) -> StackOptions:
    return StackOptions(pg_statement_log=a.pg_statement_log, isolate_unit=a.isolate_unit,
                        with_replay_log=a.with_replay_log, unit_env=a.unit_env)


def describe_options(opts: dict) -> str:
    parts = []
    if opts.get("pg_statement_log"):
        parts.append("Postgres statement log")
    if opts.get("isolate_unit"):
        parts.append(f"unit isolated on {opts.get('unit_network')}")
    if opts.get("with_replay_log"):
        parts.append("replay logs")
    if opts.get("unit_env"):
        parts.append("unit env " + ", ".join(f"{k}={v}" for k, v in opts["unit_env"].items()))
    return "; ".join(parts) or "none"


def cmd_generate(a) -> None:
    reg, tag = parse_images(a.images)
    m = generate(a.source, reg, tag, a.bind, a.with_optional, options_from_args(a))
    log(f"generated {GEN_DIR} from {m['source']} @ {m['source_git'].get('head', '?')[:10]} "
        f"({m['source_git'].get('branch', '?')}{', dirty' if m['source_git'].get('dirty') else ''})")
    log(f"images: {reg}/texera-*:{tag}; dropped: {', '.join(m['dropped_services'])}")
    log(f"options: {describe_options(m.get('options') or {})}")


def prepare_replay_log_dir(manifest: dict) -> None:
    """The shared result volume is root's (Docker creates it), and the services run as
    texera (1001): without this the coordinator cannot create its replay log and the
    run hangs in Initializing ("Could not create directory .../recovery-logs")."""
    unit = manifest["containers"][UNIT_SERVICE]
    path = REPLAY_LOG_URI.removeprefix("file://").rstrip("/")
    run(["docker", "exec", "-u", "0", unit, "sh", "-c", f"mkdir -p {path} && chown 1001:1001 {path}"],
        capture=True)
    log(f"replay logs: {path} (shared result volume) made writable for uid 1001")


def remove_unit_network_if_unused() -> None:
    """compose leaves a network that the regenerated file no longer names; drop ours
    when nothing is attached to it (it carries our project label)."""
    p = run(["docker", "network", "inspect", UNIT_NETWORK, "--format",
             '{{index .Labels "com.docker.compose.project"}} {{len .Containers}}'],
            check=False, capture=True)
    if p.returncode != 0:
        return
    project, _, attached = p.stdout.strip().partition(" ")
    if project == PROJECT and attached == "0":
        run(["docker", "network", "rm", UNIT_NETWORK], check=False, capture=True)


def cmd_up(a) -> None:
    if a.no_generate:
        manifest = load_manifest()
        if a.images:
            die("--images needs a regenerate; drop --no-generate")
        if a.pg_statement_log or a.isolate_unit or a.with_replay_log or a.unit_env:
            die("the stack options need a regenerate; drop --no-generate")
    else:
        cmd_generate(a)
        manifest = load_manifest()
    check_ports_free(manifest)
    check_images(manifest)
    pull = os.environ.get("SCE_PULL", "missing")
    log(f"docker compose up -d (project {PROJECT}, pull={pull})")
    compose("up", "-d", "--remove-orphans", "--pull", pull)
    if not (manifest.get("options") or {}).get("isolate_unit"):
        remove_unit_network_if_unused()
    wait_healthy(a.timeout, manifest)
    if (manifest.get("options") or {}).get("with_replay_log"):
        prepare_replay_log_dir(manifest)
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
    remove_unit_network_if_unused()
    log("stack is down (volumes kept)")


def cmd_reset(a) -> None:
    if (GEN_DIR / "docker-compose.yml").exists():
        compose("down", "--remove-orphans", "--volumes")
    else:
        run(["docker", "compose", "-p", PROJECT, "down", "--remove-orphans", "--volumes"])
    remove_unit_network_if_unused()
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
    print(f"network: {', '.join(manifest.get('networks') or [manifest['network']])}   "
          f"volumes: {', '.join(manifest['volumes'])}")
    print(f"options: {describe_options(manifest.get('options') or {})}")
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
    "pg": POSTGRES_SERVICE,
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
        p.add_argument("--pg-statement-log", action="store_true",
                       help="Postgres logs every statement with app, db and client address "
                            f"(and the unit's idle cleanup drops to {CLEANUP_SECONDS_WITH_STATEMENT_LOG} s)")
        p.add_argument("--isolate-unit", action="store_true",
                       help=f"the unit alone on {UNIT_NETWORK} with Postgres, Lakekeeper, RustFS and nginx")
        p.add_argument("--with-replay-log", action="store_true",
                       help=f"{REPLAY_LOG_ENV}={REPLAY_LOG_URI} for the Dashboard and the unit")
        p.add_argument("--unit-env", action="append", default=[], metavar="KEY=VAL",
                       help="extra environment for the unit (repeatable)")

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
