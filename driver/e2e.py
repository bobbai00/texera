#!/usr/bin/env python3
"""Texera full-stack e2e driver.

Setup (REST, through the gateway): log in, upload the CSV dataset (create,
multipart upload, version), get a per-user warehouse when the deployment
requires one, and get a local computing unit pointing at the unit's in-network
URI. Then each selected scenario creates its own workflow, runs it through the
transport (transport.py), waits for the outcome, reads results and asserts.

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
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from scenarios import SCENARIOS, Ctx, resolve, run_scenario  # noqa: E402
from texera_api import TexeraApi  # noqa: E402
from transport import TRANSPORTS, make_transport  # noqa: E402

DATA_DIR = HERE / "data"
DATA_FILES = ["people.csv", "depts.csv", "numbers.csv"]
REPORTS = HERE.parent / "reports"

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
                    help="scenario key or name, repeatable or comma-separated (default: all). "
                         + "; ".join(f"{k}={v[0]}" for k, v in SCENARIOS.items()))
    ap.add_argument("--transport", default=os.environ.get("SCE_TRANSPORT", "ws"),
                    choices=sorted(TRANSPORTS), help="how runs are started/watched (default %(default)s)")
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
    a = ap.parse_args()

    if a.list:
        for k, (name, title, _) in SCENARIOS.items():
            print(f"{k}  {name:32} {title}")
        return 0

    keys = resolve(a.scenario)
    started = dt.datetime.now(dt.timezone.utc)
    run_id = started.strftime("%m%d-%H%M%S")
    report_path = a.report or REPORTS / f"e2e-{started.strftime('%Y%m%dT%H%M%SZ')}.json"
    report: dict = {
        "harness": "sce-e2e",
        "label": a.label,
        "run_id": run_id,
        "started_at": started.isoformat(timespec="seconds"),
        "base": a.base,
        "transport": None,
        "host": platform.node(),
        "scenarios_selected": keys,
        "setup": {},
        "scenarios": [],
    }
    if a.stack_manifest and a.stack_manifest.exists():
        report["stack"] = json.loads(a.stack_manifest.read_text())

    api = TexeraApi(a.base)
    records = []
    setup_ok = False
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
        report["setup"]["dataset"] = {"name": ds_name, **ds}

        whid, wh_status = api.ensure_warehouse(a.warehouse_name)
        report["setup"]["warehouse"] = {
            "enabled": bool(wh_status and wh_status.get("enabled")),
            "whid": whid,
            "endpoint_present": wh_status is not None,
        }
        log(f"warehouse: {'whid ' + str(whid) if whid else 'not required by this deployment'}")

        unit = api.ensure_local_unit(a.unit_name, a.unit_uri)
        cuid = int(unit["cuid"])
        report["setup"]["computing_unit"] = {"cuid": cuid, "uri": unit.get("uri"),
                                             "name": unit.get("name"), "type": unit.get("type")}
        log(f"computing unit {cuid} -> {unit.get('uri')}")

        transport = make_transport(a.transport, base=a.base, token_provider=lambda: api.token,
                                   uid_provider=lambda: api.uid, log=lambda m: log(f"    {m}"),
                                   api=api)
        report["transport"] = transport.describe()
        ctx = Ctx(api, transport, run_id=run_id, cuid=cuid, whid=whid, paths=ds["paths"],
                  data_dir=DATA_DIR, timeout=a.timeout, log=log)
        setup_ok = True
    except Exception as e:  # noqa: BLE001
        report["setup"]["error"] = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
        log(f"SETUP FAILED: {type(e).__name__}: {e}")

    if setup_ok:
        for key in keys:
            name, title, _ = SCENARIOS[key]
            log(f"=== scenario {key} {name}: {title}")
            rec = run_scenario(ctx, key)
            records.append(rec)
            log(f"=== scenario {key} {name}: {rec.outcome} ({rec.duration_s:.1f}s)")
            report["scenarios"] = [r.to_json() for r in records]
            _write(report_path, report)

    finished = dt.datetime.now(dt.timezone.utc)
    report["finished_at"] = finished.isoformat(timespec="seconds")
    report["duration_s"] = round((finished - started).total_seconds(), 1)
    outcomes = [r.outcome for r in records]
    report["summary"] = {
        "setup_ok": setup_ok,
        "passed": outcomes.count("PASS"),
        "failed": outcomes.count("FAIL"),
        "selected": len(keys),
        "result": "PASS" if setup_ok and outcomes and all(o == "PASS" for o in outcomes)
                  and len(outcomes) == len(keys) else "FAIL",
    }
    report["scenarios"] = [r.to_json() for r in records]
    _write(report_path, report)

    print()
    print("=" * 78)
    print(f" sce-e2e results  ({a.base}, transport {a.transport}, run {run_id})")
    print("=" * 78)
    if not setup_ok:
        print(" SETUP FAILED -- no scenario ran; see setup.error in the report")
    for r in records:
        failed = [c.name for c in r.checks if not c.ok]
        extra = f"  failed: {', '.join(failed)}" if failed else ""
        if r.error and not failed:
            extra = f"  error: {r.error.splitlines()[0][:120]}"
        print(f" {r.outcome:4}  {r.key}  {r.name:32} {r.duration_s:6.1f}s  "
              f"{sum(c.ok for c in r.checks)}/{len(r.checks)} checks{extra}")
    print("-" * 78)
    print(f" overall: {report['summary']['result']}   report: {report_path}")
    print("=" * 78)
    if not setup_ok:
        return 2
    return 0 if report["summary"]["result"] == "PASS" else 1


def _write(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(report, indent=2, default=str) + "\n")
    tmp.replace(path)


if __name__ == "__main__":
    sys.exit(main())
