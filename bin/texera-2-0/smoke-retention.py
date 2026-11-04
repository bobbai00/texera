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

"""Results are kept per execution: a second run of an edited workflow does not disturb the
first run's rows, and both stay readable after the unit's idle release."""
import argparse
import importlib.util
import sys
import time

spec = importlib.util.spec_from_file_location("smoke_chat", __file__.rsplit("/", 1)[0] + "/smoke-chat.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def rows(tok: str, rid: str, eid: str) -> list:
    return c.api(tok, "GET", f"/workflows/{rid}/executions/{eid}/operators/avg/ports/output-0/rows?limit=10")["rows"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--idle-seconds", type=int, default=40)
    args = parser.parse_args()

    tok = c.token("alice", "alice")
    ds = c.ensure_iris(tok)
    file_uri = f"{ds['metadata']['uri']}@{ds['metadata']['head']}/files/iris.csv"
    workflow = {
        "operators": [
            {"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": file_uri, "fileEncoding": "UTF_8", "hasHeader": True}},
            {"operatorID": "avg", "operatorType": "Aggregate", "viewResult": True,
             "operatorProperties": {"groupByKeys": ["Species"], "aggregations": [{"aggFunction": "average", "attribute": "PetalLengthCm", "result attribute": "avg"}]}},
        ],
        "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "avg", "portID": "input-0"}}],
    }
    wf = c.api(tok, "POST", "/workflows", {"name": f"retention {time.strftime('%H%M%S')}", "spec": workflow})
    rid = wf["metadata"]["rid"]

    first = c.api(tok, "POST", f"/workflows/{rid}/run", {"waitSeconds": 180, "name": "petal length"})
    first_eid = first["metadata"]["rid"]
    first_rows = rows(tok, rid, first_eid)
    print(f"v1 run {first_eid[:8]}: {first['status']['phase']}, {first_rows}")

    c.api(tok, "POST", f"/workflows/{rid}/edit", {
        "patch": [{"op": "replace", "path": "/operators/1/operatorProperties/aggregations/0/attribute", "value": "SepalLengthCm"}],
        "expectedHead": 1, "message": "sepal instead of petal"})
    second = c.api(tok, "POST", f"/workflows/{rid}/run", {"waitSeconds": 180, "name": "sepal length"})
    second_eid = second["metadata"]["rid"]
    second_rows = rows(tok, rid, second_eid)
    print(f"v2 run {second_eid[:8]}: {second['status']['phase']}, {second_rows}")

    ok = first["status"]["phase"] == "completed" and second["status"]["phase"] == "completed" and bool(first_rows) and first_rows != second_rows
    after_second = rows(tok, rid, first_eid)
    print(f"v1 results after the v2 run: {'same' if after_second == first_rows else after_second}")
    ok &= after_second == first_rows
    for run in (first, second):
        ports = run["status"].get("ports", [])
        print(f"run {run['metadata']['rid'][:8]} ports: {[(p['operatorID'], p['portID'], p.get('table', '')[-30:]) for p in ports]}")
        ok &= bool(ports) and all(p.get("table") for p in ports)

    print(f"waiting {args.idle_seconds}s for the unit's idle release")
    time.sleep(args.idle_seconds)
    late_first, late_second = rows(tok, rid, first_eid), rows(tok, rid, second_eid)
    print(f"after the idle release: v1 {'same' if late_first == first_rows else late_first}, v2 {'same' if late_second == second_rows else late_second}")
    ok &= late_first == first_rows and late_second == second_rows

    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
