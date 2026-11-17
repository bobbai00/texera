#!/usr/bin/env python3
"""Texera full-stack e2e driver.

Setup (REST, through the gateway): log in, upload the CSV dataset (create,
multipart upload, version), get a per-user warehouse when the deployment
requires one, and get a local computing unit pointing at the unit's in-network
URI. Scenarios that need them also get a second user (sce-e2e-other, with its own
local unit and warehouse) and a second local unit of the main user. Then each
selected scenario creates its own workflow, runs it through the transport
(transport.py), waits for the outcome, reads results and asserts.

With --evidence the driver also reads the stack's Postgres statement log and the
unit's network around every scenario and evaluates the step-2 Checks A-F
(evidence.py); --negative-control expects A, D and F to fail (the old unit). A
step-3 gate (--gate 3A, 3B, 3C) adds the scenarios and the checks of the record a
run leaves in the lake, of how the Dashboard service closes executions, and of a
unit that no longer touches Postgres; its waits follow the timers the stack was
started with (record_timing.py), and its scenarios take the unit down through the
stack's control (stack_control.py). --negative-control 3 is step 3's control: on
the unit of step 2's end, Checks G and H must fail and q's execution must stay
Running.

Prints PASS/FAIL per scenario and writes a JSON report. Exit code 0 only when
every selected scenario passes (1 = a scenario failed, 2 = setup failed).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from evidence import (ALL_CHECKS, Evidence, EvidenceUnavailable, docker_runner, evaluate,  # noqa: E402
                      parse_checks, read_env_file)
from lake import DEFAULT_CATALOG_URI, DEFAULT_WAREHOUSE, Catalog, Lake, docker_fetch  # noqa: E402
from record_timing import RecordTiming  # noqa: E402
from scenarios import (GROUPS, NEEDS_OTHER_USER, NEEDS_UNIT2, SCENARIOS, STEP3, Check, Ctx,  # noqa: E402
                       OtherUser, resolve, run_scenario, stayed_running)
from stack_control import SingleNodeControl, StackControl, pg_activity  # noqa: E402
from texera_api import TexeraApi  # noqa: E402
from transport import TRANSPORTS, make_transport  # noqa: E402

import k8s_unit  # noqa: E402  -- Kubernetes mode (--target k8s); see driver/k8s_unit.py
import localdev_unit  # noqa: E402  -- local-dev mode (--target localdev); see driver/localdev_unit.py

DATA_DIR = HERE / "data"
DATA_FILES = ["people.csv", "depts.csv", "numbers.csv"]
REPORTS = HERE.parent / "reports"
STACK_GENERATED = HERE.parent / "stack" / "generated"

OTHER_USER = "sce-e2e-other"
OTHER_EMAIL = "sce-e2e-other@example.com"
OTHER_PASSWORD = "sce-e2e-other-password"

# The harness gates of the step 2 design (section 5): transport, scenarios and the
# evidence checks that gate. The stack options each gate expects are in the README.
STEP2_LAST = "a,b,c,d,e,u,j,k,l,m,o,f,f2,g,h,i"
GATES = {
    "A": {"transport": "ws", "scenarios": "a,b,c,d,e,u,g0", "evidence": "E", "legacy_env": True},
    "B": {"transport": "create-ws", "scenarios": "a,b,c,d,e,u,j,k,l,m,o,g0", "evidence": "C,E,F",
          "legacy_env": True},
    "C": {"transport": "create-ws", "scenarios": "a,b,c,d,e,u,j,k,l,m,o,f,f2,g0", "evidence": "all",
          "legacy_env": True},
    "D": {"transport": "create-ws", "scenarios": STEP2_LAST, "evidence": "all", "legacy_env": False},
    # Step 3 (its design, sections 5 and 7). `scenarios` and `evidence` are the single-node
    # stack's; `other_modes` is what Kubernetes and local-dev run (H6), where the evidence
    # of the statement log does not exist.
    "3A": {"transport": "create-ws", "scenarios": STEP2_LAST + ",p", "other_modes": "a,b,c,d,e,u,p",
           "evidence": "A,B,C,D,E,F,I", "legacy_env": False, "level": "A"},
    "3B": {"transport": "create-ws", "scenarios": STEP2_LAST + ",p,q,r,s,t,w",
           "other_modes": "a,b,c,d,e,u,p,q,s,w", "evidence": "A,B,C,D,E,F,I,K", "legacy_env": False,
           "level": "B"},
    # A and B are retired here (the unit writes no status any more; G is stronger). J gates
    # only on a stack started with --unit-no-postgres, where G and H hold trivially: the
    # gate is run on a stack with the option and on one without.
    "3C": {"transport": "create-ws", "scenarios": STEP2_LAST + ",p,q,r,s,t,w,v",
           "other_modes": "a,b,c,d,e,u,p,q,s,v,w", "evidence": "C,D,E,F,G,H,I,J,K", "legacy_env": False,
           "level": "C"},
}
#: the gates that also run in Kubernetes and local-dev mode
PORTABLE_GATES = frozenset(g for g, v in GATES.items() if "other_modes" in v)
#: the product's level once the whole of step 3 has landed (see product_level)
FINISHED_LEVEL = "C"

_T0 = time.monotonic()


def log(msg: str) -> None:
    print(f"[{time.monotonic() - _T0:7.1f}s] {msg}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=os.environ.get("SCE_BASE", "http://localhost:8080"),
                    help="gateway URL (default %(default)s)")
    ap.add_argument("--username", default=os.environ.get("SCE_USER", "texera"))
    ap.add_argument("--password", default=os.environ.get("SCE_PASSWORD", "texera"))
    ap.add_argument("--scenario", action="append", default=[],
                    help="scenario key or name, repeatable or comma-separated; groups: "
                         + ", ".join(GROUPS) + "; `all` = every scenario the transport runs "
                         "(default: a,b,c,d,e,u). "
                         + "; ".join(f"{k}={v[0]}" for k, v in SCENARIOS.items()))
    ap.add_argument("--transport", default=None, choices=sorted(TRANSPORTS),
                    help="how runs are started/watched (default $SCE_TRANSPORT or ws; "
                         "create-ws from step 2's PR B on)")
    ap.add_argument("--gate", choices=list(GATES),
                    help="a harness gate of step 2 (A-D) or step 3 (3A-3C): sets the transport, scenarios "
                         "and gating evidence checks (explicit flags win): " + "; ".join(
                             f"{g}: {v['transport']} {v['scenarios']} checks {v['evidence']}"
                             for g, v in GATES.items()))
    ap.add_argument("--evidence", nargs="?", const="all", default=None, metavar="CHECKS",
                    help="evaluate Checks A-F from the stack's Postgres statement log and the "
                         "unit's network; the listed checks gate (default all six), the others are "
                         "reported. A step-3 check (G-K) is evaluated only when listed. Needs a stack "
                         "started with --pg-statement-log")
    ap.add_argument("--negative-control", nargs="?", const="2", default=None, choices=["2", "3"],
                    metavar="STEP",
                    help="the old unit: Checks A, D and F must FAIL (the scenario's own checks are "
                         "only reported). With 3, step 3's control on the unit of step 2's end: Checks "
                         "G and H must fail, and in scenario q the execution must stay Running past the "
                         "deadline by which step 3 closes it")
    ap.add_argument("--legacy-env", action="store_true",
                    help="enable g0, the legacy environment path (/api/pve/db + /wsapi/pve)")
    ap.add_argument("--with-replay-log", action="store_true",
                    help="the stack writes replay logs (default: read from the stack manifest)")
    ap.add_argument("--unit-uri", default=os.environ.get(
        "SCE_UNIT_URI", "http://workflow-runtime-coordinator-service:8085"),
                    help="URI recorded on the local computing unit (default %(default)s)")
    ap.add_argument("--unit-name", default="sce-e2e-unit")
    ap.add_argument("--warehouse-name", default="sce-e2e")
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("SCE_RUN_TIMEOUT", "300")),
                    help="seconds a run may take to reach Running/Completed (default %(default)s)")
    ap.add_argument("--ready-timeout", type=float, default=300,
                    help="seconds to wait for /api/healthcheck before giving up")
    ap.add_argument("--report", type=Path, help="JSON report path (default reports/e2e-<time>.json)")
    ap.add_argument("--label", default="", help="free text stored in the report (e.g. image tag)")
    ap.add_argument("--stack-manifest", type=Path,
                    help="stack/generated/MANIFEST.json to embed in the report")
    ap.add_argument("--list", action="store_true", help="list scenarios and exit")
    ap.add_argument("--print-token", action="store_true",
                    help="log in, print the user's token and exit (for --unit-env USER_JWT_TOKEN=...)")
    k8s_unit.add_arguments(ap)  # Kubernetes mode: --target k8s, --unit-kind, --k8s-unit-*
    a = ap.parse_args()
    # Kubernetes mode: unit kind and the gateway port-forward as --base
    k8s_unit.resolve_args(a, portable_gates=PORTABLE_GATES)
    # local-dev mode: the dev server as --base, the frontend's local unit URI
    localdev_unit.resolve_args(a, portable_gates=PORTABLE_GATES)

    if a.list:
        for k, (name, title, _) in SCENARIOS.items():
            print(f"{k:4} {name:32} {title}")
        return 0
    if a.print_token:
        api = TexeraApi(a.base)
        api.wait_ready(a.ready_timeout)
        print(api.login(a.username, a.password))
        return 0

    gate = GATES.get(a.gate or "", {})
    transport_name = a.transport or gate.get("transport") or os.environ.get("SCE_TRANSPORT", "ws")
    if transport_name not in TRANSPORTS:
        raise SystemExit(f"unknown transport {transport_name}; known: {', '.join(TRANSPORTS)}")
    a.transport = transport_name
    legacy_env = a.legacy_env or bool(gate.get("legacy_env"))
    single_node = a.target == "single-node"
    gate_scenarios = gate.get("scenarios" if single_node else "other_modes")
    keys = resolve(a.scenario or ([gate_scenarios] if gate else []), transport_name, legacy_env)
    k8s_unit.check_selection(a, keys, transport_name)  # Kubernetes mode: refuse single-node-only scenarios
    localdev_unit.check_selection(a, keys, transport_name)  # local-dev mode: the same for the unit container
    # the statement log and its checks exist on the single-node stack only
    evidence_spec = a.evidence if a.evidence is not None else (gate.get("evidence") if single_node else None)
    required = parse_checks(evidence_spec)
    use_evidence = evidence_spec is not None or bool(a.negative_control)
    manifest_path = a.stack_manifest or (STACK_GENERATED / "MANIFEST.json")
    stack_manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    if a.evidence is None and "J" in required and not (stack_manifest.get("options") or {}).get("unit_no_postgres"):
        # the gate's Check J is for its run on a stack whose unit has no Postgres to find
        required.remove("J")
        log("Check J does not gate this run: the stack was not started with --unit-no-postgres "
            "(the gate is run once more on such a stack)")
    with_replay_log = a.with_replay_log or bool((stack_manifest.get("options") or {}).get("with_replay_log"))
    timing = RecordTiming.from_manifest(stack_manifest)
    level = product_level(gate, keys)
    started = dt.datetime.now(dt.timezone.utc)
    run_id = started.strftime("%m%d-%H%M%S")
    report_path = a.report or REPORTS / f"e2e-{started.strftime('%Y%m%dT%H%M%SZ')}.json"
    report: dict = {
        "harness": "sce-e2e",
        "harness_git": harness_git(),
        "label": a.label,
        "run_id": run_id,
        "started_at": started.isoformat(timespec="seconds"),
        "base": a.base,
        "transport": None,
        "gate": a.gate,
        "evidence": ({"required": required, "negative_control": bool(a.negative_control),
                      **({"control_step": a.negative_control} if a.negative_control == "3" else {})}
                     if use_evidence else None),
        "host": platform.node(),
        "scenarios_selected": keys,
        "setup": {"record_timing": timing.describe()},
        "scenarios": [],
    }
    if a.stack_manifest and a.stack_manifest.exists():
        report["stack"] = json.loads(a.stack_manifest.read_text())

    api = TexeraApi(a.base)
    records = []
    setup_ok = False
    evidence: Evidence | None = None
    try:
        log(f"waiting for {a.base}/api/healthcheck")
        api.wait_ready(a.ready_timeout)
        api.login(a.username, a.password)
        log(f"logged in as {a.username} (uid {api.uid}, email {api.email})")
        report["setup"]["user"] = {"uid": api.uid, "email": api.email, "role": api.claims.get("role")}

        files = {f: (DATA_DIR / f).read_bytes() for f in DATA_FILES}
        digest = hashlib.sha256(b"".join(f.encode() + b"\0" + files[f] for f in DATA_FILES)).hexdigest()[:10]
        ds_name = f"sce-e2e-{digest}"
        ds = api.ensure_dataset(ds_name, files, "sce-e2e harness data (people, depts, numbers)")
        log(f"dataset {ds_name} (did {ds['did']}, {ds['version']}, "
            f"{'reused' if ds['reused'] else 'uploaded'})")
        ds["version_path"] = f"/dataset/{api.email}/{ds_name}/{ds['version']}"
        report["setup"]["dataset"] = {"name": ds_name, **ds}

        whid, wh_status = api.ensure_warehouse(a.warehouse_name)
        wh_name = _lakekeeper_name(wh_status, whid, api.uid)
        report["setup"]["warehouse"] = {
            "enabled": bool(wh_status and wh_status.get("enabled")),
            "whid": whid,
            "lakekeeper_name": wh_name,
            "endpoint_present": wh_status is not None,
        }
        log(f"warehouse: {'whid ' + str(whid) + ' (' + str(wh_name) + ')' if whid else 'not required by this deployment'}")

        # --- Kubernetes mode: a unit pod created through the managing service (k8s_unit.py)
        if k8s_unit.wanted(a):
            unit = k8s_unit.setup(api, a, run_id=run_id, log=log, report=report)
        elif localdev_unit.wanted(a):  # local-dev: the frontend's "Connect to a Local Computing Unit"
            unit = localdev_unit.setup(api, a, run_id=run_id, log=log, report=report)
        else:
            unit = api.ensure_local_unit(a.unit_name, a.unit_uri)
        cuid = int(unit["cuid"])
        report["setup"]["computing_unit"] = {"cuid": cuid, "uri": unit.get("uri"),
                                             "name": unit.get("name"), "type": unit.get("type")}
        log(f"computing unit {cuid} -> {unit.get('uri')}")

        other = None
        if transport_name == "create-ws" and set(keys) & NEEDS_OTHER_USER:
            other_api = api.ensure_user(OTHER_USER, OTHER_EMAIL, OTHER_PASSWORD)
            other_unit = other_api.ensure_local_unit(f"{OTHER_USER}-unit", a.unit_uri)
            o_whid, o_status = other_api.ensure_warehouse(f"{OTHER_USER}-wh")
            other = OtherUser(other_api, int(other_unit["cuid"]), o_whid,
                              _lakekeeper_name(o_status, o_whid, other_api.uid))
            report["setup"]["other_user"] = {"uid": other_api.uid, "role": other_api.role,
                                             "cuid": other.cuid, "whid": o_whid,
                                             "warehouse": other.warehouse_name}
            log(f"second user {OTHER_USER} (uid {other_api.uid}): unit {other.cuid}, warehouse {o_whid}")
        unit2 = None
        if set(keys) & NEEDS_UNIT2:
            unit2 = int(api.ensure_local_unit(f"{a.unit_name}-2", a.unit_uri)["cuid"])
            report["setup"]["computing_unit_2"] = unit2
            log(f"second computing unit {unit2} -> {a.unit_uri}")

        transport = make_transport(a.transport, base=a.base, token_provider=lambda: api.token,
                                   uid_provider=lambda: api.uid, log=lambda m: log(f"    {m}"),
                                   api=api)
        report["transport"] = transport.describe()

        containers = stack_manifest.get("containers") or {}
        stack_env = read_env_file(STACK_GENERATED / ".env") if single_node else {}
        stack = _stack_control(a, api, containers, run_id=run_id, cuid=cuid, report=report)
        if use_evidence:
            evidence = Evidence(run_id=run_id.replace("-", ""), required=required,
                                negative_control=a.negative_control or False, containers=containers,
                                env=stack_env, log=log, level=level, timing=timing,
                                read_log=api.execution_log, connections=stack.pg_activity)
            info = evidence.preflight()
            evidence.warehouse_name = wh_name
            transport.phase_hook = evidence.on_phase
            report["setup"]["evidence"] = info
            log(f"evidence: statement log OK; unit {info['unit_hosts']} on {info['unit_networks']}; "
                f"gating checks {','.join(required) or '-'}"
                + (f"; negative control ({', '.join(evidence.controls)} must fail)" if a.negative_control else ""))

        ctx = Ctx(api, transport, run_id=run_id, cuid=cuid, whid=whid, paths=ds["paths"],
                  data_dir=DATA_DIR, timeout=a.timeout, log=log, transport_name=transport_name,
                  evidence=evidence, dataset=ds, warehouse_name=wh_name,
                  unit_container=containers.get("workflow-runtime-coordinator-service",
                                                "sce-workflow-runtime-coordinator-service"),
                  with_replay_log=with_replay_log, other=other, unit2_cuid=unit2, unit_uri=a.unit_uri,
                  unit_exec_prefix=(k8s_unit.exec_prefix(cuid) if k8s_unit.wanted(a)
                                    else localdev_unit.exec_prefix() if localdev_unit.wanted(a) else None),
                  timing=timing, lake=_lake(a, containers, stack_env), level=level, stack=stack,
                  # until gate 3C a Kubernetes gateway sends a statistics request to the unit
                  stats_through_unit=k8s_unit.wanted(a) and level != FINISHED_LEVEL)
        ctx.negative_control = a.negative_control == "3"
        if gate.get("level") == FINISHED_LEVEL and not single_node:
            # the other modes' proof that the unit has no Postgres (design H6), before and after
            report["unit_without_postgres"] = [_unit_without_postgres(stack, "after the setup",
                                                                      env_names=k8s_unit.wanted(a))]
        setup_ok = True
    except Exception as e:  # noqa: BLE001
        report["setup"]["error"] = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
        log(f"SETUP FAILED: {type(e).__name__}: {e}")

    if setup_ok:
        for key in keys:
            name, title, _ = SCENARIOS[key]
            log(f"=== scenario {key} {name}: {title}")
            waited = evidence.begin_scenario(key) if evidence else None
            rec = run_scenario(ctx, key)
            if evidence:
                _apply_evidence(evidence, rec, waited, api, a.negative_control)
            records.append(rec)
            log(f"=== scenario {key} {name}: {rec.outcome} ({rec.duration_s:.1f}s)")
            report["scenarios"] = [r.to_json() for r in records]
            _write(report_path, report)
        if evidence:
            finals = evidence.final_checks(ctx.created_wids)
            report["final_check"] = finals[0]
            if finals[1:]:
                report["final_checks"] = finals
            for final in finals:
                log(f"final check ({final['name']}): {'ok' if final['ok'] else 'FAIL'} -- {final['detail']}")
        if "unit_without_postgres" in report:
            report["unit_without_postgres"].append(_unit_without_postgres(
                ctx.stack, "after the last scenario", env_names=k8s_unit.wanted(a)))

    k8s_unit.teardown(api, a, log=log, report=report)  # Kubernetes mode: terminate the unit

    finished = dt.datetime.now(dt.timezone.utc)
    report["finished_at"] = finished.isoformat(timespec="seconds")
    report["duration_s"] = round((finished - started).total_seconds(), 1)
    outcomes = [r.outcome for r in records]
    final_ok = all(f["ok"] for f in [*(report.get("final_checks") or [report.get("final_check") or {"ok": True}]),
                                     *(report.get("unit_without_postgres") or [])])
    report["summary"] = {
        "setup_ok": setup_ok,
        "passed": outcomes.count("PASS"),
        "failed": outcomes.count("FAIL"),
        "selected": len(keys),
        "result": "PASS" if setup_ok and outcomes and all(o == "PASS" for o in outcomes)
                  and len(outcomes) == len(keys) and final_ok else "FAIL",
    }
    if a.negative_control:
        report["summary"]["controls"] = ("controls failed as expected"
                                         if report["summary"]["result"] == "PASS"
                                         else "a control did not fail as expected (or did not run)")
    report["scenarios"] = [r.to_json() for r in records]
    _write(report_path, report)

    print()
    print("=" * 78)
    hg = report.get("harness_git") or {}
    print(f" sce-e2e results  ({a.base}, transport {a.transport}, run {run_id}"
          + (f", gate {a.gate}" if a.gate else "")
          + f", harness {str(hg.get('head') or 'unknown')[:10]}{' +changes' if hg.get('dirty') else ''})")
    print("=" * 78)
    if not setup_ok:
        print(" SETUP FAILED -- no scenario ran; see setup.error in the report")
    for r in records:
        failed = [c.name for c in r.checks if not c.ok]
        extra = f"  failed: {', '.join(failed)}" if failed else ""
        if r.error and not failed:
            extra = f"  error: {r.error.splitlines()[0][:120]}"
        print(f" {r.outcome:4}  {r.key:3}  {r.name:30} {r.duration_s:6.1f}s  "
              f"{sum(c.ok for c in r.checks)}/{len(r.checks)} checks{extra}")
    for final in report.get("final_checks") or ([report["final_check"]] if "final_check" in report else []):
        print(f" {'ok' if final['ok'] else 'FAIL'}   final: {final['detail']}")
    for proof in report.get("unit_without_postgres") or []:
        print(f" {'ok' if proof['ok'] else 'FAIL'}   the unit without Postgres, {proof['when']}: {proof['detail']}")
    print("-" * 78)
    if a.negative_control:
        print(f" negative control: {report['summary']['controls']}")
    print(f" overall: {report['summary']['result']}   report: {report_path}")
    print("=" * 78)
    if not setup_ok:
        return 2
    return 0 if report["summary"]["result"] == "PASS" else 1


def product_level(gate: dict, keys: list[str]) -> str | None:
    """How far the product under test is taken to be: the letter of the last step-3 gate
    it has passed (A, B or C), None for a product of step 2. A step-3 gate says it.
    Without one, a run that selects a scenario of step 3 is on the whole of step 3; any
    other run is as it was before step 3, so step 2's images run as they always did."""
    return gate.get("level") or (FINISHED_LEVEL if set(keys) & STEP3 else None)


def harness_git(root: Path = HERE.parent) -> dict:
    """The harness's own commit and uncommitted changes, so a report says which code
    ran. A `git archive` copy has no .git and may name its commit in .harness-commit."""
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")

    def git(*args: str) -> str | None:
        try:
            p = subprocess.run(["git", "-C", str(root), *args], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, timeout=20, env=env)
        except (OSError, subprocess.SubprocessError):
            return None
        return p.stdout if p.returncode == 0 else None

    head = (git("rev-parse", "HEAD") or "").strip()
    if not head:
        marker = root / ".harness-commit"
        named = marker.read_text().strip() if marker.exists() else ""
        return {"head": named or None, "dirty": None,
                "note": "not a git checkout" + (" (.harness-commit names the commit)" if named else "")}
    status = git("status", "--porcelain") or ""
    changes = [ln for ln in status.splitlines() if ln.strip()]
    return {"head": head, "dirty": bool(changes), "changes": changes[:30]}


def _lake(a, containers: dict, stack_env: dict) -> Lake:
    """The lake's catalog, asked from where this mode's stack can reach Lakekeeper."""
    if k8s_unit.wanted(a):
        return k8s_unit.lake()
    if localdev_unit.wanted(a):
        return localdev_unit.lake()
    uri = stack_env.get("STORAGE_ICEBERG_CATALOG_REST_URI", DEFAULT_CATALOG_URI).rstrip("/")
    dashboard = containers.get("dashboard-service", "sce-dashboard-service")
    return Lake(Catalog(docker_fetch(docker_runner, dashboard, uri)),
                stack_env.get("STORAGE_ICEBERG_CATALOG_REST_WAREHOUSE_NAME", DEFAULT_WAREHOUSE), stack_env)


def _stack_control(a, api: TexeraApi, containers: dict, *, run_id: str, cuid: int, report: dict) -> StackControl:
    """How this mode's stack takes the unit down and brings one back (stack_control.py)."""
    if k8s_unit.wanted(a):
        return k8s_unit.KubernetesControl(api, a, run_id=run_id, cuid=cuid, log=log)
    if localdev_unit.wanted(a):
        return localdev_unit.control(api, a, cuid=cuid, report=report, log=log)
    return SingleNodeControl(containers, wait_gateway=lambda: api.wait_ready(a.ready_timeout))


def _unit_without_postgres(stack: StackControl, when: str, *, env_names: bool) -> dict:
    """What Kubernetes and local-dev mode can show of a unit that has no Postgres (design
    H6), where no statement log is read: Postgres holds no connection named after the unit
    and none from its address; and with `env_names` (Kubernetes, where the manager hands a
    unit its environment) the unit was given no database login."""
    try:
        connections = pg_activity.of_unit(stack.pg_activity(), stack.unit_addresses())
        login = [n for n in stack.unit_env_names() if n.startswith("STORAGE_JDBC_")] if env_names else []
    except Exception as e:  # noqa: BLE001 -- a proof that cannot be made is not made
        return {"when": when, "ok": False, "detail": f"not evaluable: {type(e).__name__}: {str(e)[:300]}"}
    problems = ([f"{len(connections)} connection(s) of the unit in pg_stat_activity: " + "; ".join(
        f"pid {c['pid']} app={c['application_name'] or '-'} from {c['client_addr'] or '-'}"
        for c in connections[:4])] if connections else [])
    problems += [f"the unit was given {', '.join(login)}"] if login else []
    return {"when": when, "ok": not problems, "connections": connections, "database_login": login,
            "detail": "; ".join(problems) or "Postgres holds no connection of the unit"
                      + (", and the unit was given no STORAGE_JDBC_* setting" if env_names else "")}


def _lakekeeper_name(status: dict | None, whid: int | None, uid: int) -> str | None:
    """The Lakekeeper name of warehouse `whid`: /api/warehouse/status gives it on
    newer Dashboards; older ones (the published images) do not, and the name is
    the Dashboard's convention user-<uid>-<whid> (WarehouseResource)."""
    if whid is None:
        return None
    for w in (status or {}).get("warehouses") or []:
        if int(w.get("whid", -1)) == whid and w.get("lakekeeperWarehouseName"):
            return w["lakekeeperWarehouseName"]
    return f"user-{uid}-{whid}"


def _apply_evidence(evidence: Evidence, rec, waited, api: TexeraApi, negative: bool | str | None) -> None:
    """Close the scenario's evidence and fold its checks into the record."""
    try:
        out = evidence.end_scenario(
            resolve_eid=lambda run: (api.latest_execution(run.wid) or {}).get("eId") if run.wid else None)
    except Exception as e:  # noqa: BLE001
        rec.checks.append(Check("evidence collected", False, f"{type(e).__name__}: {e}"))
        rec.outcome = "FAIL"
        return
    gates, info = evaluate(out["checks"], evidence.required, negative)
    rec.evidence = {"cleanup_wait": waited, "checks": info, **out["report"]}
    if negative:
        rec.functional_checks, rec.checks = rec.checks, []
    if negative == "3" and rec.key == "q":  # step 3's control on q: nothing closes the execution
        held, detail = stayed_running(rec)
        gates.append(("control q stays at status 1 past its deadline (the old Dashboard closes no "
                      "execution)", held, detail))
    for name, ok, detail in gates:
        rec.checks.append(Check(name, ok, detail[:2000]))
        log(f"  [{'ok' if ok else 'FAIL'}] {name}{'' if ok else ' -- ' + detail[:400]}")
    for key in ALL_CHECKS:
        if key in info and key not in evidence.required and not (negative and key in evidence.controls):
            r = info[key]
            log(f"  [info] Check {key}: {'pass' if r['ok'] else ('n/a' if r['ok'] is None else 'fail')} "
                f"-- {str(r['detail'])[:300]}")
    for exp in out["report"].get("no_unit_statement_for", []):
        name = f"no unit statement for execution {exp['eid']} since {exp['since']} ({exp['why']})"
        rec.checks.append(Check(name, exp["ok"], json.dumps(exp["statements"])[:2000] if exp["statements"] else ""))
        log(f"  [{'ok' if exp['ok'] else 'FAIL'}] {name}")
    for exp in out["report"].get("unit_silent_after_refused_start", []):
        name = (f"the unit ran no statement from the refused start of execution {exp['eid']} until after "
                f"its answer ({exp['why']})")
        detail = exp["detail"] + (": " + json.dumps(exp["statements"]) if exp["statements"] else "")
        rec.checks.append(Check(name, exp["ok"], detail[:2000]))
        log(f"  [{'ok' if exp['ok'] else 'FAIL'}] {name}" + ("" if exp["ok"] else f" -- {detail[:300]}"))
    if negative:
        rec.outcome = "PASS" if rec.checks and all(c.ok for c in rec.checks) else "FAIL"
    else:
        rec.outcome = ("PASS" if rec.checks and all(c.ok for c in rec.checks) and not rec.error
                       else "FAIL")


def _write(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(report, indent=2, default=str) + "\n")
    tmp.replace(path)


if __name__ == "__main__":
    sys.exit(main())
