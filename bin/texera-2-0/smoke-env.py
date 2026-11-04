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

"""Environments through the gateway: a Python UDF that imports a package the unit lacks fails
without an environment and succeeds with one that lists the package; the environment's
builds show in its status."""
import importlib.util
import sys
import time

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


def main() -> int:
    tok = c.token("bob", "bob")
    ds = c.ensure_iris(tok)
    file_uri = f"{ds['metadata']['uri']}@{ds['metadata']['head']}/files/iris.csv"

    env = c.api(tok, "POST", "/environments", {"name": f"py-humanize {time.strftime('%H%M%S')}", "spec": {"python": {"packages": ["humanize==4.11.0"]}}})
    env_uri = env["metadata"]["uri"]
    print(f"environment {env_uri} @{env['metadata']['head']}: {env['spec']['python']['packages']}")

    workflow = {
        "operators": [
            {"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": file_uri, "fileEncoding": "UTF_8", "hasHeader": True}},
            {"operatorID": "udf", "operatorType": "PythonUDFV2", "viewResult": True,
             "operatorProperties": {"code": UDF, "workers": 1, "retainInputColumns": True, "defaultEnv": True,
                                    "outputColumns": [{"attributeName": "rank", "attributeType": "string"}]}},
        ],
        "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "udf", "portID": "input-0"}}],
    }
    wf = c.api(tok, "POST", "/workflows", {"name": f"humanize ranks {time.strftime('%H%M%S')}", "spec": workflow})
    rid = wf["metadata"]["rid"]
    val = c.api(tok, "POST", f"/workflows/{rid}/validate", {})
    print(f"workflow {rid[:8]} validates: {val['ok']} {val['operatorErrors'] or ''}")

    plain = c.api(tok, "POST", f"/workflows/{rid}/run", {"waitSeconds": 240, "name": "no environment"})
    err = str(plain["status"].get("error") or plain["status"].get("operators"))
    print(f"run without the environment: {plain['status']['phase']}; mentions humanize: {'humanize' in err}")

    started = time.time()
    with_env = c.api(tok, "POST", f"/workflows/{rid}/run", {"waitSeconds": 600, "environment": env_uri, "name": "with environment"})
    print(f"run with the environment: {with_env['status']['phase']} in {time.time() - started:.0f}s; pinned {with_env['spec'].get('environment')}")
    ok = val["ok"] and plain["status"]["phase"] == "failed" and with_env["status"]["phase"] == "completed"
    ok &= (with_env["spec"].get("environment") or "") == f"{env_uri}@1"
    if with_env["status"]["phase"] == "completed":
        page = c.api(tok, "GET", f"/workflows/{rid}/executions/{with_env['metadata']['rid']}/operators/udf/ports/output-0/rows?limit=3")
        cols = [a["attributeName"] for a in page["schema"]]
        print(f"columns: {cols}\nfirst rows: {page['rows']}")
        ok &= "rank" in cols and page["rows"][0][cols.index("rank")] == "1st"
    else:
        print(f"error: {str(with_env['status'].get('error'))[:500]}")
    builds = c.api(tok, "GET", f"/environments/{env['metadata']['rid']}")["status"].get("builds", [])
    print(f"builds: {[(b['vno'], b['state']) for b in builds]}")
    ok &= any(b["state"] == "ready" for b in builds)
    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
