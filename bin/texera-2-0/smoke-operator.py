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

"""A custom Python operator: created as a resource, used in a workflow version by its URI, run in
a pinned environment that carries the package it imports; deleting it is refused while the
workflow references it, and it appears in the operator list beside the built-ins."""
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
import humanize


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["rank"] = humanize.ordinal(int(tuple_["Id"]))
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
    tok = c.token("alice", "alice")
    stamp = time.strftime("%H%M%S")
    ok = True

    def check(cond: bool, what: str) -> None:
        nonlocal ok
        print(("ok   " if cond else "FAIL ") + what)
        ok &= cond

    ds = c.ensure_iris(tok)
    file_uri = f"{ds['metadata']['uri']}@{ds['metadata']['head']}/files/iris.csv"
    env = c.api(tok, "POST", "/environments", {"name": f"humanize {stamp}", "spec": {"python": {"packages": ["humanize==4.11.0"]}}})
    op = c.api(tok, "POST", "/operators", {
        "name": f"Ordinal rank {stamp}",
        "description": "Adds an ordinal rank column from Id",
        "spec": {
            "operatorType": f"OrdinalRank{stamp}", "displayName": "Ordinal rank", "group": "Custom",
            "inputPorts": [{"portID": "input-0"}], "outputPorts": [{"portID": "output-0"}],
            "implementation": {"python": {"code": UDF, "outputColumns": [{"attributeName": "rank", "attributeType": "string"}]}},
        },
    })
    op_uri = f"{op['metadata']['uri']}@{op['metadata']['head']}"
    print(f"operator {op_uri}")
    listed = c.api(tok, "GET", f"/operators?q=Ordinal+rank+{stamp}")["items"]
    check(any(o["metadata"]["rid"] == op["metadata"]["rid"] and not (o.get("status") or {}).get("builtin") for o in listed), "the operator is listed beside the built-ins, not as one")

    workflow = {
        "operators": [
            {"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": file_uri, "fileEncoding": "UTF_8", "hasHeader": True}},
            {"operatorID": "rank", "operatorType": op_uri, "operatorProperties": {}, "viewResult": True},
        ],
        "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "rank", "portID": "input-0"}}],
    }
    wf = c.api(tok, "POST", "/workflows", {"name": f"ranked iris {stamp}", "spec": workflow})
    rid = wf["metadata"]["rid"]
    val = c.api(tok, "POST", f"/workflows/{rid}/validate", {})
    check(val["ok"], f"the workflow compiles with the custom operator {val['operatorErrors'] or ''}")

    plain = c.api(tok, "POST", f"/workflows/{rid}/run", {"waitSeconds": 240, "name": "no environment"})
    err = str(plain["status"].get("error") or plain["status"].get("operators"))
    check(plain["status"]["phase"] == "failed" and "humanize" in err, f"without the environment the run fails on the import ({plain['status']['phase']})")
    started = time.time()
    pinned = c.api(tok, "POST", f"/workflows/{rid}/run", {"waitSeconds": 600, "environment": env["metadata"]["uri"], "name": "pinned environment"})
    check(pinned["status"]["phase"] == "completed", f"with the environment pinned the run completes ({pinned['status']['phase']} in {time.time() - started:.0f}s)")
    check(pinned["spec"].get("environment") == f"{env['metadata']['uri']}@1", "the execution pins the environment version")
    if pinned["status"]["phase"] == "completed":
        page = c.api(tok, "GET", f"/workflows/{rid}/executions/{pinned['metadata']['rid']}/operators/rank/ports/output-0/rows?limit=3")
        cols = [a["attributeName"] for a in page["schema"]]
        check("rank" in cols and page["rows"][0][cols.index("rank")] == "1st", f"the custom operator's column is in the result: {cols} {page['rows'][0]}")

    dependents = c.api(tok, "GET", f"/resources/{op['metadata']['rid']}/dependents")
    check(any(e["from"].startswith(wf["metadata"]["uri"]) and e["relation"] == "references" for e in dependents), "lineage records the workflow referencing the operator")
    status, body = call(tok, "DELETE", f"/operators/{op['metadata']['rid']}")
    check(status == 409 and wf["metadata"]["uri"] in json.dumps(body), f"deleting the operator is refused with the workflow as a dependent ({status}: {str(body)[:120]})")

    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
