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

"""A chat through the gateway with a real model: a conversation on an agent template, turns
over the runtime's AG-UI endpoint, the events as they stream, and what the chat produced.

  python3 bin/texera-2-0/smoke-chat.py                      # the Data Analyst on the iris dataset
  python3 bin/texera-2-0/smoke-chat.py --template "Bio Researcher" --prompt "..." --followup "" --save ""
  python3 bin/texera-2-0/smoke-chat.py --demo               # the M1 scenario: bio ideas, then a handoff to the analyst
"""
import argparse
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

GW = os.environ.get("GW", "http://localhost:8088")
API = f"{GW}/catalog/v1"


def token(user: str, password: str) -> str:
    data = urllib.parse.urlencode({"grant_type": "password", "client_id": "texera-app", "username": user, "password": password}).encode()
    with urllib.request.urlopen(f"{GW}/auth/realms/texera/protocol/openid-connect/token", data) as r:
        return json.load(r)["access_token"]


def api(tok: str, method: str, path: str, body=None):
    req = urllib.request.Request(f"{API}{path}", method=method, headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> {e.code}: {e.read()[:400]!r}")


def ensure_iris(tok: str) -> dict:
    """Makes sure the person owns one dataset named iris with a committed version; returns it."""
    mine = api(tok, "GET", "/datasets?q=iris")["items"]
    for d in mine:
        if d["metadata"]["name"] == "iris" and d["metadata"]["head"] > 0:
            return d
    ds = next((d for d in mine if d["metadata"]["name"] == "iris"), None)
    if ds is None:
        ds = api(tok, "POST", "/datasets", {"name": "iris", "description": "Fisher's iris flowers", "spec": {"format": "csv"}})
    rid = ds["metadata"]["rid"]
    data = (pathlib.Path(__file__).parent / "examples" / "iris.csv").read_bytes()
    req = urllib.request.Request(f"{API}/datasets/{rid}/files/iris.csv", method="PUT", data=data,
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "text/csv"})
    urllib.request.urlopen(req).read()
    api(tok, "POST", f"/datasets/{rid}/commit", {"message": "initial upload"})
    print(f"created dataset iris {rid}")
    return api(tok, "GET", f"/datasets/{rid}")


def template_uri(tok: str, name: str) -> str:
    templates = api(tok, "GET", f"/agent-templates?q={urllib.parse.quote(name)}")["items"]
    tpl = next(t for t in templates if t["metadata"]["name"] == name)
    return tpl["metadata"]["uri"]


def run_turn(tok: str, conversation: str, prompt: str, template: str | None = None) -> list:
    body = {
        "threadId": conversation, "runId": str(uuid.uuid4()), "state": {}, "tools": [], "context": [],
        "forwardedProps": {"template": template} if template else {},
        "messages": [{"id": str(uuid.uuid4()), "role": "user", "content": prompt}],
    }
    req = urllib.request.Request(f"{GW}/agents/conversations/{conversation}/ag-ui", method="POST", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json", "Accept": "text/event-stream"})
    events = []
    text = []
    with urllib.request.urlopen(req, timeout=900) as r:
        for raw in r:
            line = raw.decode().rstrip("\n")
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:].strip())
            events.append(ev)
            t = ev.get("type")
            if t == "TOOL_CALL_START":
                print(f"  tool call: {ev.get('toolCallName')}", flush=True)
            elif t == "TOOL_CALL_RESULT":
                content = str(ev.get("content", ""))
                print(f"    result: {content[:160].replace(chr(10), ' ')}", flush=True)
            elif t == "TEXT_MESSAGE_CONTENT":
                text.append(ev.get("delta", ""))
            elif t == "CUSTOM" and ev.get("name") == "texera.resource":
                print(f"  resource: {ev.get('value')}", flush=True)
            elif t == "CUSTOM" and ev.get("name") == "texera.handoff":
                v = ev.get("value", {})
                print(f"  handoff by {v.get('by')}: -> {v.get('name')} ({v.get('to')})", flush=True)
            elif t == "RUN_ERROR":
                print(f"  RUN_ERROR: {ev}", flush=True)
            elif t == "RUN_FINISHED":
                print(f"  run finished: {ev.get('outcome')}", flush=True)
    print("\nassistant:\n" + "".join(text).strip() + "\n")
    return events


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", default="Data Analyst")
    ap.add_argument("--user", default="bob")
    ap.add_argument("--prompt", default="Using the iris dataset in my catalog, what is the average petal length for each species? "
                                        "Build and run a Texera workflow to compute it, then report the numbers.")
    ap.add_argument("--followup", default="Now edit that same workflow so it also computes the average sepal width per species, "
                                          "run it again, and report both averages.")
    ap.add_argument("--save", default="Save the per-species averages from your last run as a dataset named 'iris averages by species'.",
                    help="a last turn that keeps a result as a dataset; empty to skip")
    ap.add_argument("--demo", action="store_true", help="the M1 scenario: the Bio Researcher, then a handoff to the Data Analyst")
    args = ap.parse_args()

    tok = token(args.user, args.user)
    ensure_iris(tok)
    if args.demo:
        # The catalog knows a principal once they have logged in; the share turn needs Bob known.
        api(token("bob", "bob"), "GET", "/me")
    units = api(tok, "GET", "/computing-units/available")
    unit = next(u for u in units if u["status"]["phase"] == "ready")
    first = "Bio Researcher" if args.demo else args.template
    tpl = template_uri(tok, first)
    print(f"template: {first} ({tpl}); unit: {unit['metadata']['name']}")
    conv = api(tok, "POST", "/conversations", {"name": f"chat {time.strftime('%H:%M:%S')}", "spec": {"template": tpl, "computingUnit": unit["metadata"]["uri"]}})
    crid = conv["metadata"]["rid"]
    print(f"conversation {crid}\n")

    turns = [args.prompt, args.followup, args.save]
    if args.demo:
        turns = [
            "I study CRISPR off-target effects. Give me three research ideas grounded in recent literature, with citations.",
            "Now analyze the iris dataset in my catalog: what is the average petal length per species? Build and run a workflow and report the numbers.",
            "Share my iris dataset with Bob so he can read it.",
        ]
    for i, prompt in enumerate(p for p in turns if p):
        print(f"turn {i + 1}: {prompt}")
        started = time.time()
        events = run_turn(tok, crid, prompt)
        print(f"turn {i + 1} took {time.time() - started:.1f}s, {len(events)} events\n")

    msgs = api(tok, "GET", f"/conversations/{crid}/messages")["items"]
    print(f"messages: {[(m['seq'], m['role'], (m.get('template') or '')[-14:]) for m in msgs]}")
    conv = api(tok, "GET", f"/conversations/{crid}")
    print(f"conversation template now: {conv['spec']['template']}")
    resources = api(tok, "GET", f"/conversations/{crid}/resources")
    print(f"resources created in this chat: {[(r['kind'], r['metadata']['name'], r['metadata']['head']) for r in resources]}")
    if args.demo:
        # The share went through the catalog MCP server: bob now reads alice's iris.
        bob = token("bob", "bob")
        pid = api(bob, "GET", "/me")["principal"]["pid"]
        shared = [d for d in api(bob, "GET", "/datasets?q=iris")["items"] if d["metadata"]["name"] == "iris" and d["metadata"]["owner"] != pid]
        print(f"bob can read {len(shared)} iris dataset(s) owned by someone else")
        print("\nRESULT:", "PASS" if shared else "CHECK")
        return 0 if shared else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
