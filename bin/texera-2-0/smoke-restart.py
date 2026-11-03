#!/usr/bin/env python3
"""A finished run's results survive a restart of the unit that ran it.

The unit keeps its runs in memory only. After it restarts, the catalog still serves an old run's
results: it hands the unit the table the lineage events recorded, and the unit reads it there
once it checked the table belongs to that execution.

Restarts the unit of this worktree (bin/texera-2-0/lib.sh). Needs the dev stack and the catalog.
"""
import importlib.util
import os
import pathlib
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
spec = importlib.util.spec_from_file_location("smoke_chat", HERE / "smoke-chat.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def restart_unit() -> None:
    script = (
        'set -euo pipefail; source "$HERE/lib.sh"; stop unit 28085; '
        'start unit 28085 "$ROOT" "exec \'$HERE/run-unit.sh\'"; '
        "wait_for unit 900 http_ok http://localhost:28085/api/health"
    )
    env = dict(os.environ, HERE=str(HERE), ROOT=str(ROOT), LOGS=str(ROOT / "logs" / "texera-2-0"))
    subprocess.run(["bash", "-c", script], check=True, env=env)


def main() -> int:
    tok = c.token("alice", "alice")
    c.ensure_iris(tok)
    ds = next(d for d in c.api(tok, "GET", "/catalog/v1/datasets?q=iris")["items"] if d["metadata"]["name"] == "iris")
    content = {
        "operators": [
            {"operatorID": "scan", "operatorType": "CSVFileScan",
             "operatorProperties": {"fileName": f"dataset://{ds['metadata']['rid']}@{ds['metadata']['headVersion']}/iris.csv",
                                    "fileEncoding": "UTF_8", "hasHeader": True}},
            {"operatorID": "avg", "operatorType": "Aggregate", "viewResult": True,
             "operatorProperties": {"groupByKeys": ["Species"],
                                    "aggregations": [{"aggFunction": "average", "attribute": "SepalWidthCm", "result attribute": "avg"}]}},
        ],
        "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "avg", "portID": "input-0"}}],
    }
    wf = c.api(tok, "POST", "/catalog/v1/workflows/with-content", {"name": f"restart {time.strftime('%H%M%S')}", "content": content})
    run = c.api(tok, "POST", f"/catalog/v1/workflows/{wf['workflow']['metadata']['rid']}/executions", {"waitSeconds": 180})
    path = f"/catalog/v1/executions/{run['eid']}/results/avg/output-0?limit=10"
    before = c.api(tok, "GET", path)["rows"]
    print(f"run {run['eid'][:8]}: {run['status']}, {before}")

    print("restarting the unit")
    restart_unit()
    after = c.api(tok, "GET", path)["rows"]
    print(f"after the restart: {'same' if after == before else after}")

    ok = run["status"] == "completed" and bool(before) and after == before
    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
