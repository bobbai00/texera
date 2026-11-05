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

"""A tour of Texera 2.0 through its API, as alice, against a running stack: sign in, make a
dataset, build a workflow, see the plan an execution would use, run it, read the rows and the
lineage, keep the execution, share with bob, and clean up. Every step prints the request and the
part of the answer that matters, so this file doubles as the API's quick reference.

    bin/texera-2-0/examples/walkthrough.py                  # against http://localhost:8088
    bin/texera-2-0/examples/walkthrough.py --gw http://localhost:28088   # the cluster
    bin/texera-2-0/examples/walkthrough.py --chat           # also one turn with the Texera Agent (needs the model key)

Only the standard library is used; the same calls as curl would make them.
"""
import argparse
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

HERE = pathlib.Path(__file__).resolve().parent


def token(gw: str, user: str, password: str) -> str:
    """A person's access token: Keycloak's password grant on the public client texera-app."""
    data = urllib.parse.urlencode({"grant_type": "password", "client_id": "texera-app", "username": user, "password": password}).encode()
    with urllib.request.urlopen(f"{gw}/auth/realms/texera/protocol/openid-connect/token", data, timeout=60) as r:
        return json.load(r)["access_token"]


class Person:
    """One caller of the catalog API through the gateway."""

    def __init__(self, gw: str, user: str, password: str):
        self.gw, self.user, self.token = gw, user, token(gw, user, password)

    def call(self, method: str, path: str, body=None, *, raw: bytes | None = None, content_type="application/json"):
        """Returns (status, decoded body) for a call to /catalog/v1{path}."""
        headers = {"Authorization": f"Bearer {self.token}", "Content-Type": content_type}
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        req = urllib.request.Request(f"{self.gw}/catalog/v1{path}", method=method, headers=headers, data=data)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                out = r.read()
                return r.status, (json.loads(out) if out.startswith(b"{") or out.startswith(b"[") else out.decode(errors="replace"))
        except urllib.error.HTTPError as e:
            out = e.read()
            return e.code, (json.loads(out) if out.startswith(b"{") else out.decode(errors="replace"))

    def must(self, method: str, path: str, body=None, **kw):
        status, out = self.call(method, path, body, **kw)
        if status // 100 != 2:
            sys.exit(f"{method} {path} -> {status}: {str(out)[:400]}")
        return out


def step(title: str) -> None:
    print(f"\n== {title}")


def show(method: str, path: str, note: str = "") -> None:
    print(f"   {method} {path}" + (f"   # {note}" if note else ""))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gw", default="http://localhost:8088", help="the gateway")
    ap.add_argument("--chat", action="store_true", help="also run one turn with the Texera Agent (needs the model key)")
    ap.add_argument("--keep", action="store_true", help="leave what the tour made in place")
    args = ap.parse_args()
    gw = args.gw.rstrip("/")

    step("sign in as alice and bob (Keycloak password grant, client texera-app)")
    alice, bob = Person(gw, "alice", "alice"), Person(gw, "bob", "bob")
    show("POST", f"{gw}/auth/realms/texera/protocol/openid-connect/token", "grant_type=password&client_id=texera-app&username=alice&password=alice")

    step("who am I: the principal and the home project")
    me = alice.must("GET", "/me")
    show("GET", "/me")
    print(f"   {me['principal']['displayName']}, home project {me['homeProject']}")
    bob_pid = bob.must("GET", "/me")["principal"]["pid"]

    step("a project for the tour (names are unique per project and kind)")
    stamp = time.strftime("%H%M%S")
    project = alice.must("POST", "/projects", {"name": f"tour {stamp}", "spec": {}})["metadata"]["rid"]
    show("POST", "/projects", '{"name": "tour", "spec": {}}')
    print(f"   project {project}")

    step("a dataset: create, upload a file, commit a version")
    ds = alice.must("POST", "/datasets", {"name": "iris", "spec": {"format": "csv"}, "parent": project})
    show("POST", "/datasets", '{"name": "iris", "spec": {"format": "csv"}, "parent": "<project rid>"}')
    rid = ds["metadata"]["rid"]
    alice.must("PUT", f"/datasets/{rid}/files/iris.csv", raw=(HERE / "iris.csv").read_bytes(), content_type="text/csv")
    show("PUT", f"/datasets/{rid}/files/iris.csv", "the bytes, Content-Type: text/csv; staged until the commit")
    version = alice.must("POST", f"/datasets/{rid}/commit", {"message": "first upload"})
    show("POST", f"/datasets/{rid}/commit", '{"message": "first upload"}')
    file_uri = f"{ds['metadata']['uri']}@{version['vno']}/files/iris.csv"
    print(f"   version {version['vno']}; the file is named {file_uri}")

    step("a workflow: scan the file, average the petal length per species")
    spec = {
        "operators": [
            {"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": file_uri, "fileEncoding": "UTF_8", "hasHeader": True}},
            {"operatorID": "avg", "operatorType": "Aggregate", "viewResult": True,
             "operatorProperties": {"groupByKeys": ["Species"], "aggregations": [{"aggFunction": "average", "attribute": "PetalLengthCm", "result attribute": "avg"}]}},
        ],
        "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "avg", "portID": "input-0"}}],
    }
    wf = alice.must("POST", "/workflows", {"name": "petal length by species", "spec": spec, "parent": project})
    show("POST", "/workflows", '{"name": ..., "spec": {"operators": [...], "links": [...]}, "parent": "<project rid>"}')
    wrid = wf["metadata"]["rid"]
    print(f"   workflow {wf['metadata']['uri']} at version {wf['metadata']['head']}")

    step("a unit to run on: the platform's static unit (the dev stack's), or any unit you may run on")
    units = alice.must("GET", "/computing-units/available")
    show("GET", "/computing-units/available")
    ready = [u for u in units if u["status"]["phase"] == "ready"]
    if not ready:
        sys.exit("no computing unit is ready; is the unit up? (bin/texera-2-0/up.sh)")
    unit = ready[0]["metadata"]["uri"]
    print(f"   {ready[0]['metadata']['name']}: {unit}")

    step("validate: the engine compiles the version on the unit, and the catalog shows the plan an execution would use")
    validation = alice.must("POST", f"/workflows/{wrid}/validate", {"computingUnit": unit})
    show("POST", f"/workflows/{wrid}/validate", '{"computingUnit": "<unit uri>"}')
    print(f"   ok={validation['ok']}; output columns of avg: {[a['attributeName'] for a in validation['operatorOutputSchemas']['avg']['output-0']]}")
    print(f"   the plan names the tables an execution writes: {[(o['operatorID'], o['table']) for o in validation['plan']['outputs']]}")

    step("run: authorized, compiled and materialized by the catalog; waitSeconds waits for the end")
    run = alice.must("POST", f"/workflows/{wrid}/run", {"name": "tour run", "computingUnit": unit, "waitSeconds": 240})
    show("POST", f"/workflows/{wrid}/run", '{"name": "tour run", "computingUnit": "<unit uri>", "waitSeconds": 240}')
    eid = run["metadata"]["rid"]
    print(f"   execution {eid}: {run['status']['phase']}")
    if run["status"]["phase"] != "completed":
        sys.exit(f"the execution did not complete: {json.dumps(run['status'].get('error'))[:400]}")
    print(f"   its plan is stored with it: namespace {run['spec']['plan']['namespace']}, outputs {[o['table'] for o in run['spec']['plan']['outputs']]}")
    ports = run["status"]["ports"]
    print(f"   ports: {[(p['operatorID'], p['portID'], p.get('rows'), p.get('table')) for p in ports]}")

    step("the rows of the result port")
    page = alice.must("GET", f"/workflows/{wrid}/executions/{eid}/operators/avg/ports/output-0/rows?limit=10")
    show("GET", f"/workflows/{wrid}/executions/{eid}/operators/avg/ports/output-0/rows?limit=10")
    print(f"   schema {[a['attributeName'] for a in page['schema']]}")
    for row in page["rows"]:
        print(f"   {row}")

    step("lineage: the execution used the file and produced its table; the dataset leads to the execution")
    down = alice.must("GET", f"/resources/{eid}/lineage?direction=downstream")
    show("GET", f"/resources/{eid}/lineage?direction=downstream")
    for e in down["edges"]:
        print(f"   {e['from']} --{e['relation']}--> {e['to']}")
    up = alice.must("GET", f"/resources/{eid}/lineage?direction=upstream")
    show("GET", f"/resources/{eid}/lineage?direction=upstream")
    for e in up["edges"]:
        print(f"   {e['from']} --{e['relation']}--> {e['to']}")

    step("keep the execution: the label the retention sweep honours")
    kept = alice.must("PATCH", f"/resources/{eid}", {"labels": {"texera.keep": "true"}})
    show("PATCH", f"/resources/{eid}", '{"labels": {"texera.keep": "true"}}')
    print(f"   labels now {kept['metadata'].get('labels')}")

    step("share the project with bob as a viewer: he can read and run, nothing more")
    status, _ = bob.call("GET", f"/workflows/{wrid}")
    print(f"   before: bob reads the workflow -> {status}")
    alice.must("PUT", f"/resources/{project}/grants/{bob_pid}", {"relation": "viewer"})
    show("PUT", f"/resources/{project}/grants/{bob_pid}", '{"relation": "viewer"}')
    status, _ = bob.call("GET", f"/workflows/{wrid}/executions/{eid}/operators/avg/ports/output-0/rows?limit=3")
    print(f"   after: bob reads the rows -> {status}")
    status, _ = bob.call("POST", f"/workflows/{wrid}/edit", {"patch": [{"op": "replace", "path": "/operators/1/operatorProperties/groupByKeys", "value": ["Species"]}]})
    print(f"   bob edits the workflow -> {status} (a viewer may not)")

    step("the MCP server: the same operations as tools, for any agent with a person's token")
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    req = urllib.request.Request(f"{gw}/mcp/catalog", method="POST", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {alice.token}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=60) as r:
        names = []
        for line in r:
            text = line.decode().strip()
            if text.startswith("data:") or text.startswith("{"):
                names = [t["name"] for t in json.loads(text.removeprefix("data:").strip())["result"]["tools"]]
                break
    show("POST", f"{gw}/mcp/catalog", '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"} with Accept: application/json, text/event-stream')
    print(f"   {len(names)} tools, e.g. {names[:6]}")

    if args.chat:
        step("a chat turn: the Texera Agent answers from a workflow it builds (AG-UI stream)")
        conv = alice.must("POST", "/conversations", {"name": f"tour chat {stamp}", "spec": {}, "parent": project})
        show("POST", "/conversations", '{"name": ..., "spec": {}, "parent": "<project rid>"}: a chat stores only what was chosen for it')
        crid = conv["metadata"]["rid"]
        runs_with = alice.must("GET", f"/conversations/{crid}/settings")
        show("GET", f"/conversations/{crid}/settings", "what a turn runs with, and which level chose each")
        print(f"   agent {runs_with['agent']['name']} ({runs_with['agent']['from']}), model {runs_with['modelEndpoint']['name']} ({runs_with['modelEndpoint']['from']}), "
              f"servers {[m['name'] for m in runs_with['mcpServers']]}")
        prompt = f"Using the dataset {ds['metadata']['uri']}, what is the average petal length per species? Build and run a workflow, then report the numbers."
        body = {"threadId": crid, "runId": str(uuid.uuid4()), "state": {}, "tools": [], "context": [], "forwardedProps": {},
                "messages": [{"id": str(uuid.uuid4()), "role": "user", "content": prompt}]}
        req = urllib.request.Request(f"{gw}/agents/conversations/{crid}/ag-ui", method="POST", data=json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {alice.token}", "Content-Type": "application/json", "Accept": "text/event-stream"})
        show("POST", f"{gw}/agents/conversations/{crid}/ag-ui", "an AG-UI RunAgentInput with the new user message; events stream back")
        text = []
        with urllib.request.urlopen(req, timeout=900) as r:
            for raw in r:
                line = raw.decode().rstrip("\n")
                if not line.startswith("data:"):
                    continue
                ev = json.loads(line[5:].strip())
                if ev.get("type") == "TOOL_CALL_START":
                    print(f"   tool call: {ev.get('toolCallName')}")
                elif ev.get("type") == "TEXT_MESSAGE_CONTENT":
                    text.append(ev.get("delta", ""))
        print("   assistant: " + "".join(text).strip().replace("\n", "\n              ")[:1200])
        made = alice.must("GET", f"/conversations/{crid}/resources")
        show("GET", f"/conversations/{crid}/resources", "what the chat made")
        print(f"   {[(r['kind'], r['metadata']['name']) for r in made]}")

    if args.keep:
        print(f"\nleft in place: project {project}")
        return
    step("clean up: the execution, then the resources in reference order, then the project")
    alice.must("DELETE", f"/workflows/{wrid}/executions/{eid}")
    show("DELETE", f"/workflows/{wrid}/executions/{eid}", "its tables go with it")
    if args.chat:
        for r in alice.must("GET", f"/conversations?project={project}")["items"]:
            for made in alice.must("GET", f"/conversations/{r['metadata']['rid']}/resources"):
                if made["kind"] == "execution":
                    alice.call("DELETE", f"/workflows/{made['metadata']['parent']}/executions/{made['metadata']['rid']}")
            for made in alice.must("GET", f"/conversations/{r['metadata']['rid']}/resources"):
                if made["kind"] == "workflow":
                    alice.call("DELETE", f"/resources/{made['metadata']['rid']}")
            alice.call("DELETE", f"/resources/{r['metadata']['rid']}")
    alice.must("DELETE", f"/resources/{wrid}")
    alice.must("DELETE", f"/resources/{rid}")
    alice.must("DELETE", f"/projects/{project}")
    show("DELETE", f"/projects/{project}", "a project is refused with 409 while it still holds anything")
    print("\ndone")


if __name__ == "__main__":
    main()
