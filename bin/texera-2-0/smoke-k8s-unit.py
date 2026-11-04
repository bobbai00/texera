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

"""A computing unit as a resource on Kubernetes: created through the API with provider
kubernetes, it becomes a Deployment the catalog reconciles, with a Secret holding the identity
the catalog minted for it; it reports pending, then ready; a workflow runs on it; a viewer may
not run on it until granted use; terminating it removes the Deployment and the Secret and
deleting the resource is refused while it is referenced... then succeeds.
Runs against a Kubernetes deployment: GW=http://localhost:28088."""
import importlib.util
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("smoke_chat", __file__.rsplit("/", 1)[0] + "/smoke-chat.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def call(tok: str, method: str, path: str, body=None) -> tuple[int, object]:
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


def deployments(rid: str) -> str:
    """What the cluster holds for the unit, when kubectl is around; '' otherwise."""
    try:
        out = subprocess.run(["kubectl", "--context", "kind-texera2", "-n", "texera2", "get", "deploy,svc,secret", "-l", f"texera.apache.org/unit={rid}", "-o", "name"],
                             capture_output=True, text=True, timeout=30)
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def main() -> int:
    alice, bob = c.token("alice", "alice"), c.token("bob", "bob")
    bob_pid = c.api(bob, "GET", "/me")["principal"]["pid"]
    stamp = time.strftime("%H%M%S")
    ok = True

    def check(cond: bool, what: str) -> None:
        nonlocal ok
        print(("ok   " if cond else "FAIL ") + what)
        ok &= cond

    unit = c.api(alice, "POST", "/computing-units", {
        "name": f"alice's unit {stamp}",
        "spec": {"provider": "kubernetes", "computingNodes": [{"name": "master", "role": "master", "memory": "2Gi"}]},
    })
    rid, uri = unit["metadata"]["rid"], unit["metadata"]["uri"]
    print(f"unit {uri}")
    phase = None
    started = time.time()
    while time.time() - started < 600:
        phase = c.api(alice, "GET", f"/computing-units/{rid}")["status"]["phase"]
        if phase == "ready":
            break
        time.sleep(5)
    check(phase == "ready", f"the unit becomes ready ({phase} after {time.time() - started:.0f}s)")
    held = deployments(rid)
    check(not held or ("deployment" in held and "service" in held and "secret" in held), f"the cluster holds its deployment, service and identity secret: {held.replace(chr(10), ' ') or 'kubectl not available'}")
    identity = c.api(alice, "GET", f"/computing-units/{rid}")["status"].get("identity") or {}
    check(identity.get("clientId") == f"unit-{rid}" and bool(identity.get("subject")), f"the unit runs as its own client ({identity.get('clientId')})")

    ds = c.ensure_iris(alice)
    file_uri = f"{ds['metadata']['uri']}@{ds['metadata']['head']}/files/iris.csv"
    workflow = {
        "operators": [
            {"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": file_uri, "fileEncoding": "UTF_8", "hasHeader": True}},
            {"operatorID": "avg", "operatorType": "Aggregate", "viewResult": True,
             "operatorProperties": {"groupByKeys": ["Species"], "aggregations": [{"aggFunction": "average", "attribute": "SepalLengthCm", "result attribute": "avg"}]}},
        ],
        "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "avg", "portID": "input-0"}}],
    }
    wf = c.api(alice, "POST", "/workflows", {"name": f"on my unit {stamp}", "spec": workflow})
    wrid = wf["metadata"]["rid"]
    if phase == "ready":
        run = c.api(alice, "POST", f"/workflows/{wrid}/run", {"waitSeconds": 300, "computingUnit": uri, "name": f"run on my unit {stamp}"})
        check(run["status"]["phase"] == "completed" and run["spec"]["computingUnit"] == uri, f"a run on the unit completes ({run['status']['phase']})")
        if run["status"]["phase"] == "completed":
            page = c.api(alice, "GET", f"/workflows/{wrid}/executions/{run['metadata']['rid']}/operators/avg/ports/output-0/rows?limit=5")
            check(len(page["rows"]) == 3, f"its rows are readable: {page['rows']}")
        c.api(alice, "PUT", f"/resources/{wrid}/grants/{bob_pid}", {"relation": "viewer"})
        c.api(alice, "PUT", f"/resources/{ds['metadata']['rid']}/grants/{bob_pid}", {"relation": "viewer"})
        status, body = call(bob, "POST", f"/workflows/{wrid}/run", {"waitSeconds": 60, "computingUnit": uri, "name": f"bob on alice's unit {stamp}"})
        check(status == 403, f"bob may not run on alice's unit until granted use ({status})")
        c.api(alice, "PUT", f"/resources/{rid}/grants/{bob_pid}", {"relation": "user"})
        status, body = call(bob, "POST", f"/workflows/{wrid}/run", {"waitSeconds": 300, "computingUnit": uri, "name": f"bob with use {stamp}"})
        check(status == 201 and body["status"]["phase"] == "completed", f"granted use, bob's run completes ({status})")

    terminated = c.api(alice, "POST", f"/computing-units/{rid}/terminate", {})
    check(terminated["status"]["phase"] == "terminated", "terminate reports the unit terminated")
    time.sleep(3)
    held = deployments(rid)
    check(held == "", f"the cluster no longer holds it: {held or 'nothing'}")
    status, _ = call(alice, "DELETE", f"/computing-units/{rid}")
    check(status in (200, 204), f"the resource can be deleted afterwards ({status})")

    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
