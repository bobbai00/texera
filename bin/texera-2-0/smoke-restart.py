#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""A completed run's rows stay readable after the unit restarts: the catalog recorded the
result's table and the unit serves it from the warehouse."""
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
    ds = c.ensure_iris(tok)
    file_uri = f"{ds['metadata']['uri']}@{ds['metadata']['head']}/files/iris.csv"
    workflow = {
        "operators": [
            {"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": file_uri, "fileEncoding": "UTF_8", "hasHeader": True}},
            {"operatorID": "avg", "operatorType": "Aggregate", "viewResult": True,
             "operatorProperties": {"groupByKeys": ["Species"], "aggregations": [{"aggFunction": "average", "attribute": "SepalWidthCm", "result attribute": "avg"}]}},
        ],
        "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "avg", "portID": "input-0"}}],
    }
    wf = c.api(tok, "POST", "/workflows", {"name": f"restart {time.strftime('%H%M%S')}", "spec": workflow})
    rid = wf["metadata"]["rid"]
    run = c.api(tok, "POST", f"/workflows/{rid}/run", {"waitSeconds": 180})
    eid = run["metadata"]["rid"]
    path = f"/workflows/{rid}/executions/{eid}/operators/avg/ports/output-0/rows?limit=10"
    before = c.api(tok, "GET", path)["rows"]
    print(f"run {eid[:8]}: {run['status']['phase']}, {before}")

    print("restarting the unit")
    restart_unit()
    after = c.api(tok, "GET", path)["rows"]
    print(f"after the restart: {'same' if after == before else after}")

    ok = run["status"]["phase"] == "completed" and bool(before) and after == before
    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
