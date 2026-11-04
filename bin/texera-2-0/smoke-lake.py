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

"""The lake enforces the catalog's decision: a run's tables live in a namespace of their own,
which the unit that ran it may read and write and nobody else may. Anonymous callers and a
person's own token get nothing from the lake directly; a second unit's identity cannot see the
first unit's run; deleting that unit deletes its identity.

Runs against the dev stack: the gateway at GW, Lakekeeper at LAKE, Keycloak at KEYCLOAK, the
dev secret store at SECRETS (the dev root token reads a provisioned unit's credential, which
only the catalog and the unit itself hold in a real deployment)."""
import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

spec = importlib.util.spec_from_file_location("smoke_chat", __file__.rsplit("/", 1)[0] + "/smoke-chat.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

LAKE = os.environ.get("LAKE", "http://localhost:18181")
KEYCLOAK = os.environ.get("KEYCLOAK", "http://localhost:18081/auth/realms/texera")
SECRETS = os.environ.get("SECRETS", "http://localhost:18200")
SECRETS_TOKEN = os.environ.get("SECRETS_TOKEN", "texera-dev-root")
UNIT_CLIENT = (os.environ.get("UNIT_CLIENT_ID", "texera-unit"), os.environ.get("UNIT_CLIENT_SECRET", "texera-unit-secret"))


def http(method: str, url: str, token: str | None = None, body=None, headers=None) -> tuple[int, object]:
    h = {"Content-Type": "application/json", **(headers or {})}
    if token:
        h["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, method=method, headers=h, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode(errors="replace")


def client_token(client_id: str, secret: str) -> tuple[int, str]:
    data = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": client_id, "client_secret": secret, "scope": "openid"}).encode()
    try:
        with urllib.request.urlopen(f"{KEYCLOAK}/protocol/openid-connect/token", data, timeout=30) as r:
            return r.status, json.load(r)["access_token"]
    except urllib.error.HTTPError as e:
        return e.code, ""


def lake_prefix(token: str) -> str:
    status, cfg = http("GET", f"{LAKE}/catalog/v1/config?warehouse=texera", token)
    if status != 200:
        raise SystemExit(f"lake config as the unit: {status} {cfg}")
    return cfg["overrides"].get("prefix") or cfg["defaults"].get("prefix")


def main() -> int:
    alice = c.token("alice", "alice")
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
    wf = c.api(alice, "POST", "/workflows", {"name": f"lake petal widths {stamp}", "spec": workflow})
    rid = wf["metadata"]["rid"]
    run = c.api(alice, "POST", f"/workflows/{rid}/run", {"waitSeconds": 180, "name": f"run {stamp}"})
    eid = run["metadata"]["rid"]
    check(run["status"]["phase"] == "completed", f"alice's run completed ({eid[:8]}): {run['status'].get('error') or ''}".rstrip(": "))
    namespace = "e_" + eid.replace("-", "")
    rows = c.api(alice, "GET", f"/workflows/{rid}/executions/{eid}/operators/avg/ports/output-0/rows?limit=10")["rows"]
    check(len(rows) == 3, f"the catalog serves the rows ({len(rows)} groups)")

    # The lake itself: nothing without a token, nothing for a person's token.
    status, _ = http("GET", f"{LAKE}/catalog/v1/config?warehouse=texera")
    check(status == 401, f"the lake refuses an anonymous caller ({status})")
    status, body = http("GET", f"{LAKE}/catalog/v1/config?warehouse=texera", alice)
    check(status in (403, 404), f"the lake refuses alice's own token ({status})")

    # The unit that ran it sees its namespace and the result table in it.
    status, unit_tok = client_token(*UNIT_CLIENT)
    check(status == 200, f"the unit's identity gets a token ({status})")
    prefix = lake_prefix(unit_tok)
    status, listing = http("GET", f"{LAKE}/catalog/v1/{prefix}/namespaces", unit_tok)
    names = [n[0] for n in listing.get("namespaces", [])] if status == 200 else []
    check(status == 200 and namespace in names, f"the unit lists the run's namespace ({status}, {len(names)} visible)")
    status, tables = http("GET", f"{LAKE}/catalog/v1/{prefix}/namespaces/{namespace}/tables", unit_tok)
    table_names = [t["name"] for t in tables.get("identifiers", [])] if status == 200 else []
    check(status == 200 and len(table_names) >= 1, f"the run's tables are in its namespace ({status}, {len(table_names)} tables)")
    others = [n for n in names if not n.startswith("e_")]
    check(not others, f"the unit sees no namespace but runs ({others})")
    loaded = 0
    if table_names:
        status, _ = http("GET", f"{LAKE}/catalog/v1/{prefix}/namespaces/{namespace}/tables/{urllib.parse.quote(table_names[0], safe='')}", unit_tok,
                         headers={"X-Iceberg-Access-Delegation": "vended-credentials"})
        loaded = status
    check(loaded == 200, f"the unit loads a result table with vended credentials ({loaded})")

    # A second unit's identity: minted by the catalog for a unit it provisions, with no grant
    # on alice's run. Reading its credential from the dev secret store stands in for the pod.
    other = c.api(alice, "POST", "/computing-units", {"name": f"other unit {stamp}", "spec": {"provider": "kubernetes", "computingNodes": [{"name": "master", "role": "master", "memory": "1Gi"}]}})
    orid = other["metadata"]["rid"]
    identity = other["status"].get("identity") or {}
    check(identity.get("clientId") == f"unit-{orid}" and bool(identity.get("subject")), f"the new unit has an identity of its own ({identity.get('clientId')})")
    status, secret = http("GET", f"{SECRETS}/v1/texera/data/units/{orid}", headers={"X-Vault-Token": SECRETS_TOKEN})
    other_secret = (secret or {}).get("data", {}).get("data", {}).get("secret", "") if status == 200 else ""
    check(bool(other_secret), f"its credential is in the secret store ({status})")
    status, other_tok = client_token(f"unit-{orid}", other_secret)
    check(status == 200, f"the other unit's identity gets a token ({status})")
    status, _ = http("GET", f"{LAKE}/catalog/v1/config?warehouse=texera", other_tok)
    check(status in (403, 404), f"with no run of its own it gets nothing from the lake ({status})")
    status, _ = http("GET", f"{LAKE}/catalog/v1/{prefix}/namespaces/{namespace}/tables", other_tok)
    check(status in (403, 404), f"it cannot list alice's run's tables ({status})")
    if table_names:
        status, _ = http("GET", f"{LAKE}/catalog/v1/{prefix}/namespaces/{namespace}/tables/{urllib.parse.quote(table_names[0], safe='')}", other_tok)
        check(status in (403, 404), f"it cannot load alice's result table ({status})")
    c.api(alice, "DELETE", f"/computing-units/{orid}")
    status, _ = client_token(f"unit-{orid}", other_secret)
    check(status in (400, 401), f"deleting the unit deleted its identity ({status})")
    status, _ = http("GET", f"{SECRETS}/v1/texera/data/units/{orid}", headers={"X-Vault-Token": SECRETS_TOKEN})
    check(status == 404, f"and its credential ({status})")

    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
