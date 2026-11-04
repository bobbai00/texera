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

"""Sharing a project: a viewer of the project finds its workflow, run and dataset in search,
reads them and runs the workflow on the platform's unit, but cannot edit the workflow, delete
it, or lease the owner's credential."""
import importlib.util
import json
import sys
import time
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("smoke_chat", __file__.rsplit("/", 1)[0] + "/smoke-chat.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def call(tok: str, method: str, path: str, body=None) -> tuple[int, object]:
    """Like smoke-chat's api, but returns the status instead of exiting on an error."""
    req = urllib.request.Request(f"{c.API}{path}", method=method, headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode(errors="replace")


def main() -> int:
    alice, bob = c.token("alice", "alice"), c.token("bob", "bob")
    home = c.api(alice, "GET", "/me")["homeProject"]
    bob_pid = c.api(bob, "GET", "/me")["principal"]["pid"]
    stamp = time.strftime("%H%M%S")
    ok = True

    def check(cond: bool, what: str) -> None:
        nonlocal ok
        print(("ok   " if cond else "FAIL ") + what)
        ok &= cond

    ds = c.ensure_iris(alice)
    file_uri = f"{ds['metadata']['uri']}@{ds['metadata']['head']}/files/iris.csv"
    workflow = {
        "operators": [
            {"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": file_uri, "fileEncoding": "UTF_8", "hasHeader": True}},
            {"operatorID": "avg", "operatorType": "Aggregate", "viewResult": True,
             "operatorProperties": {"groupByKeys": ["Species"], "aggregations": [{"aggFunction": "average", "attribute": "PetalWidthCm", "result attribute": "avg"}]}},
        ],
        "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "avg", "portID": "input-0"}}],
    }
    wf = c.api(alice, "POST", "/workflows", {"name": f"shared petal widths {stamp}", "spec": workflow})
    rid = wf["metadata"]["rid"]
    run = c.api(alice, "POST", f"/workflows/{rid}/run", {"waitSeconds": 180, "name": f"alice's run {stamp}"})
    eid = run["metadata"]["rid"]
    check(run["status"]["phase"] == "completed", f"alice's run completed ({eid[:8]})")
    cred = c.api(alice, "POST", "/credentials", {"name": f"alice's key {stamp}", "spec": {"kind": "api_key", "scope": "example.org"}})
    crid = cred["metadata"]["rid"]
    c.api(alice, "PUT", f"/credentials/{crid}/secret", {"fields": {"value": "s3cret-" + stamp}})

    status, _ = call(bob, "GET", f"/workflows/{rid}")
    check(status in (403, 404), f"before the share, bob cannot read the workflow ({status})")

    c.api(alice, "PUT", f"/resources/{home}/grants/{bob_pid}", {"relation": "viewer"})
    print(f"alice shared her project {home[:8]} with bob as viewer")
    try:
        found = {r["metadata"]["rid"] for r in c.api(bob, "GET", f"/resources?project={home}&limit=500")["items"]}
        check({rid, eid, ds["metadata"]["rid"]} <= found, "bob's search lists the workflow, the run and the dataset")
        status, seen = call(bob, "GET", f"/workflows/{rid}")
        check(status == 200 and seen["metadata"]["name"] == wf["metadata"]["name"], "bob reads the workflow")
        status, _ = call(bob, "GET", f"/workflows/{rid}/executions/{eid}/operators/avg/ports/output-0/rows?limit=5")
        check(status == 200, "bob reads alice's result rows")
        status, files = call(bob, "GET", f"/datasets/{ds['metadata']['rid']}/versions/{ds['metadata']['head']}/files")
        check(status == 200 and any(f["path"] == "iris.csv" for f in files["files"]), "bob lists the dataset's files")

        status, bobs_run = call(bob, "POST", f"/workflows/{rid}/run", {"waitSeconds": 180, "name": f"bob's run {stamp}"})
        check(status == 201 and bobs_run["status"]["phase"] == "completed", f"bob runs the workflow on the platform's unit ({status}, {bobs_run['status']['phase'] if status == 201 else bobs_run})")
        if status == 201:
            check(bobs_run["metadata"]["owner"] == bob_pid, "bob's run is his own")

        status, _ = call(bob, "POST", f"/workflows/{rid}/edit", {"patch": [{"op": "replace", "path": "/operators/1/operatorProperties/aggregations/0/attribute", "value": "SepalWidthCm"}], "message": "bob tries"})
        check(status == 403, f"bob cannot edit the workflow ({status})")
        status, _ = call(bob, "DELETE", f"/workflows/{rid}")
        check(status == 403, f"bob cannot delete the workflow ({status})")
        status, _ = call(bob, "POST", f"/credentials/{crid}/lease", {"purpose": f"texera://conversations/{eid}"})
        check(status == 403, f"bob cannot lease alice's credential ({status})")
        status, lease = call(alice, "POST", f"/credentials/{crid}/lease", {"purpose": f"texera://conversations/{eid}"})
        check(status == 201 and lease["fields"]["value"].startswith("s3cret-"), "alice leases her own credential")
        status, grants = call(bob, "GET", f"/resources/{rid}/grants")
        check(status == 403, f"bob cannot see who the workflow is shared with ({status})")
    finally:
        c.api(alice, "DELETE", f"/resources/{home}/grants/{bob_pid}")
        print("grant revoked")
    status, _ = call(bob, "GET", f"/workflows/{rid}")
    check(status in (403, 404), f"after the revoke, bob cannot read the workflow ({status})")

    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
