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

"""Credentials in operator properties: a custom operator declares a property with format
credential; the workflow names a credential by URI; the run gets the secret through a lease and
the result shows it was there; the stored version keeps the URI; a project viewer who may not use
the credential is refused."""
import importlib.util
import json
import sys
import time
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("smoke_chat", __file__.rsplit("/", 1)[0] + "/smoke-chat.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

UDF = '''from pytexera import *


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["auth"] = PROPS["apiKey"][-4:]
        tuple_["label"] = PROPS.get("label", "")
        yield tuple_
'''


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


def main() -> int:
    alice, bob = c.token("alice", "alice"), c.token("bob", "bob")
    home = c.api(alice, "GET", "/me")["homeProject"]
    bob_pid = c.api(bob, "GET", "/me")["principal"]["pid"]
    stamp = time.strftime("%H%M%S")
    secret = f"token-{stamp}-9f3a"
    ok = True

    def check(cond: bool, what: str) -> None:
        nonlocal ok
        print(("ok   " if cond else "FAIL ") + what)
        ok &= cond

    ds = c.ensure_iris(alice)
    file_uri = f"{ds['metadata']['uri']}@{ds['metadata']['head']}/files/iris.csv"
    cred = c.api(alice, "POST", "/credentials", {"name": f"service key {stamp}", "spec": {"kind": "api_key", "scope": "example.org"}})
    c.api(alice, "PUT", f"/credentials/{cred['metadata']['rid']}/secret", {"fields": {"value": secret}})
    op = c.api(alice, "POST", "/operators", {
        "name": f"Authed tagger {stamp}",
        "spec": {
            "operatorType": f"AuthedTagger{stamp}", "displayName": "Authed tagger", "group": "Custom",
            "inputPorts": [{"portID": "input-0"}], "outputPorts": [{"portID": "output-0"}],
            "propertiesSchema": {"type": "object", "properties": {"apiKey": {"type": "string", "format": "credential", "description": "The service key"}, "label": {"type": "string"}}, "required": ["apiKey"]},
            "implementation": {"python": {"code": UDF, "outputColumns": [{"attributeName": "auth", "attributeType": "string"}, {"attributeName": "label", "attributeType": "string"}]}},
        },
    })
    op_uri = f"{op['metadata']['uri']}@{op['metadata']['head']}"
    workflow = {
        "operators": [
            {"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": file_uri, "fileEncoding": "UTF_8", "hasHeader": True}},
            {"operatorID": "tag", "operatorType": op_uri, "operatorProperties": {"apiKey": cred["metadata"]["uri"], "label": "tagged"}, "viewResult": True},
        ],
        "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "tag", "portID": "input-0"}}],
    }
    wf = c.api(alice, "POST", "/workflows", {"name": f"authed tagging {stamp}", "spec": workflow})
    rid = wf["metadata"]["rid"]
    val = c.api(alice, "POST", f"/workflows/{rid}/validate", {})
    check(val["ok"], f"the workflow compiles with the credential URI in place {val['operatorErrors'] or ''}")

    run = c.api(alice, "POST", f"/workflows/{rid}/run", {"waitSeconds": 240, "name": f"authed run {stamp}"})
    check(run["status"]["phase"] == "completed", f"the run completes ({run['status']['phase']})")
    if run["status"]["phase"] == "completed":
        page = c.api(alice, "GET", f"/workflows/{rid}/executions/{run['metadata']['rid']}/operators/tag/ports/output-0/rows?limit=2")
        cols = [a["attributeName"] for a in page["schema"]]
        row = page["rows"][0]
        check(row[cols.index("auth")] == secret[-4:] and row[cols.index("label")] == "tagged", f"the code saw the leased secret and its other property through PROPS: {dict(zip(cols, row))}")
    else:
        print("error:", str(run["status"].get("error"))[:400])
    version = json.dumps(c.api(alice, "GET", f"/workflows/{rid}/versions/1"))
    check(cred["metadata"]["uri"] in version and secret not in version, "the stored version holds the credential URI, never the secret")
    execution = json.dumps(c.api(alice, "GET", f"/workflows/{rid}/executions/{run['metadata']['rid']}"))
    check(secret not in execution, "the execution holds no secret")

    c.api(alice, "PUT", f"/resources/{home}/grants/{bob_pid}", {"relation": "viewer"})
    try:
        status, body = call(bob, "POST", f"/workflows/{rid}/run", {"waitSeconds": 60, "name": f"bob tries {stamp}"})
        check(status == 403, f"a project viewer who may not use the credential is refused ({status}: {str(body)[:80]})")
        c.api(alice, "PUT", f"/resources/{cred['metadata']['rid']}/grants/{bob_pid}", {"relation": "user"})
        status, bobs = call(bob, "POST", f"/workflows/{rid}/run", {"waitSeconds": 240, "name": f"bob with use {stamp}"})
        check(status == 201 and bobs["status"]["phase"] == "completed", f"granted use of the credential, bob's run completes ({status})")
    finally:
        c.api(alice, "DELETE", f"/resources/{home}/grants/{bob_pid}")
        call(alice, "DELETE", f"/resources/{cred['metadata']['rid']}/grants/{bob_pid}")
        print("grants revoked")

    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
