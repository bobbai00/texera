#!/usr/bin/env python3
"""Real-model chat through the whole stack, as a person would use it.

Logs in as alice through Keycloak, picks an agent template (the chat's mode), creates a
conversation and its principal agent in the catalog, sends one AG-UI run to the agent runtime
through the gateway, streams the events, and then checks what the turn left behind: the
assistant message, the workflow versions and executions the agent created, their attribution
(agent, on behalf of alice) and their origin (this conversation), and the lineage.

Usage: smoke-chat.py [--template "Data Analyst"] [--prompt "..."]
Needs the dev stack, the catalog, the unit and the agent runtime (see README.md).
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

GW = os.environ.get("GW", "http://localhost:8088")  # the gateway; GW=http://localhost:28088 for the k8s deployment


def token(user: str, password: str) -> str:
    data = urllib.parse.urlencode({"grant_type": "password", "client_id": "texera-app", "username": user, "password": password}).encode()
    with urllib.request.urlopen(f"{GW}/auth/realms/texera/protocol/openid-connect/token", data) as r:
        return json.load(r)["access_token"]


def api(tok: str, method: str, path: str, body=None):
    req = urllib.request.Request(f"{GW}{path}", method=method, headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> {e.code}: {e.read()[:400]!r}")


def ensure_iris(tok: str) -> None:
    """Makes sure the person owns one dataset named iris with a committed version."""
    mine = api(tok, "GET", "/catalog/v1/datasets?q=iris")["items"]
    if any(d["metadata"]["name"] == "iris" and d["metadata"]["headVersion"] > 0 for d in mine):
        return
    import pathlib
    ds = api(tok, "POST", "/catalog/v1/datasets", {"name": "iris", "description": "Fisher's iris flowers", "spec": {"format": "csv"}})
    rid = ds["metadata"]["rid"]
    data = (pathlib.Path(__file__).parent / "examples" / "iris.csv").read_bytes()
    req = urllib.request.Request(f"{GW}/catalog/v1/datasets/{rid}/files/iris.csv", method="PUT", data=data,
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/octet-stream"})
    urllib.request.urlopen(req).read()
    api(tok, "POST", f"/catalog/v1/datasets/{rid}/commit", {"message": "initial upload"})
    print(f"created dataset iris {rid}")


def run_turn(tok: str, pid: str, conversation: str, prompt: str) -> list:
    body = {
        "threadId": conversation, "runId": str(uuid.uuid4()), "state": {}, "tools": [], "context": [], "forwardedProps": {},
        "messages": [{"id": str(uuid.uuid4()), "role": "user", "content": prompt}],
    }
    req = urllib.request.Request(f"{GW}/agents/{pid}/ag-ui", method="POST", data=json.dumps(body).encode(),
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
            elif t in ("RUN_ERROR",):
                print(f"  RUN_ERROR: {ev}", flush=True)
            elif t == "RUN_FINISHED":
                print(f"  run finished: {ev.get('outcome')}", flush=True)
    print("\nassistant:\n" + "".join(text).strip() + "\n")
    return events


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", default="Data Analyst")
    ap.add_argument("--user", default="bob")
    ap.add_argument("--followup", default="Now edit that same workflow so it also computes the average sepal width per species, "
                                          "run it again, and report both averages.")
    ap.add_argument("--save", default="Save the per-species averages from your last run as a dataset named 'iris averages by species'.",
                    help="a last turn that keeps a result as a dataset; empty to skip")
    ap.add_argument("--prompt", default="Using the iris dataset in my catalog, what is the average petal length for each species? "
                                        "Build and run a Texera workflow to compute it, then report the numbers.")
    args = ap.parse_args()

    tok = token(args.user, args.user)
    me = api(tok, "GET", "/catalog/v1/me")
    alice = me["principal"]["pid"]  # the person the agent acts for
    ensure_iris(tok)
    templates = api(tok, "GET", "/catalog/v1/agent-templates")["items"]
    tpl = next(t for t in templates if t["metadata"]["name"] == args.template)
    units = api(tok, "GET", "/catalog/v1/computing-units/available")
    unit = next(u for u in units if u["status"]["phase"] == "ready")
    print(f"mode: {tpl['metadata']['name']} v{tpl['metadata']['headVersion']}; unit: {unit['metadata']['name']}")

    conv = api(tok, "POST", "/catalog/v1/conversations", {"name": f"chat {time.strftime('%H:%M:%S')}",
               "spec": {"template": {"rid": tpl["metadata"]["rid"], "vno": tpl["metadata"]["headVersion"]}, "computingUnit": unit["metadata"]["rid"]}})
    crid = conv["metadata"]["rid"]
    agent = api(tok, "POST", "/catalog/v1/agents", {"template": {"rid": tpl["metadata"]["rid"], "vno": tpl["metadata"]["headVersion"]},
                                                     "conversation": crid, "lifetime": "conversation"})
    pid = agent["pid"]
    print(f"conversation {crid}\nagent {pid}\n")

    started = time.time()
    events = run_turn(tok, pid, crid, args.prompt)
    print(f"turn 1 took {time.time() - started:.1f}s, {len(events)} events")
    if args.followup:
        print(f"\nfollow-up: {args.followup}")
        started = time.time()
        events = run_turn(tok, pid, crid, args.followup)
        print(f"turn 2 took {time.time() - started:.1f}s, {len(events)} events")
    if args.save:
        print(f"\nsave: {args.save}")
        started = time.time()
        events = run_turn(tok, pid, crid, args.save)
        print(f"save turn took {time.time() - started:.1f}s, {len(events)} events")

    msgs = api(tok, "GET", f"/catalog/v1/conversations/{crid}/messages")
    print(f"messages: {[(m['seq'], m['role'], m['author'][:8]) for m in msgs]}")
    resources = api(tok, "GET", f"/catalog/v1/conversations/{crid}/resources")
    print(f"resources created in this chat: {[(r['kind'], r['metadata']['name'], r['metadata']['headVersion']) for r in resources]}")
    execs = api(tok, "GET", f"/catalog/v1/executions?conversation={crid}")["items"]
    chat_runs = {e["eid"] for e in execs}
    ok = True
    saved = False
    for r in resources:
        md = r["metadata"]
        attributed = md["createdBy"] == pid and md.get("onBehalfOf") == alice and md.get("origin", {}).get("conversation") == crid
        ok &= attributed
        print(f"  {r['kind']} {md['name']}: createdBy agent={md['createdBy'] == pid} onBehalfOf alice={md.get('onBehalfOf') == alice} origin={md.get('origin')}")
        versions = api(tok, "GET", f"/catalog/v1/resources/{md['rid']}/versions")["items"]
        for v in versions:
            print(f"    v{v['vno']} by agent={v['createdBy'] == pid} origin={v.get('origin')} message={v.get('message')}")
        if r["kind"] == "workflow":
            lin = api(tok, "GET", f"/catalog/v1/resources/{md['rid']}/lineage")
            print(f"    lineage upstream: {[(e['kind'], e['from']['rid'][:8], e['from']['vno'], e['to']['vno']) for e in lin['upstream']]}")
        if r["kind"] == "dataset" and md["headVersion"] > 0:
            lin = api(tok, "GET", f"/catalog/v1/resources/{md['rid']}/lineage?vno={md['headVersion']}")
            produced = [e for e in lin["upstream"] if e["kind"] == "produced"]
            print(f"    produced by: {[(e['from']['rid'][:8], 'v' + str(e['from']['vno']), (e.get('execution') or '')[:8]) for e in produced]}")
            saved |= any(e.get("execution") in chat_runs for e in produced)
    print(f"executions from this chat: {[(e['eid'][:8], e['status'], 'wf v' + str(e['workflow']['vno']), e['actor'] == pid, e.get('origin')) for e in execs]}")
    ok &= any(e["status"] == "completed" for e in execs) and len(resources) > 0
    user_msgs = [m for m in msgs if m["role"] == "user"]
    ok &= all(m["author"] == alice for m in user_msgs)
    print(f"user messages authored by the person: {all(m['author'] == alice for m in user_msgs)}")
    if args.followup:
        wf = [r for r in resources if r["kind"] == "workflow"]
        edited = any(r["metadata"]["headVersion"] >= 2 for r in wf)
        rerun = any(e["status"] == "completed" and e["workflow"]["vno"] >= 2 for e in execs)
        print(f"follow-up edited the workflow into a new version: {edited}; reran that version: {rerun}")
        ok &= edited and rerun
    if args.save:
        print(f"a dataset version saved from this chat's run, with lineage to it: {saved}")
        ok &= saved
    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
