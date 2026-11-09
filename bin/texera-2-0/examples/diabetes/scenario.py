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

"""The README's demo without a browser: attaches the screening cohort to a new chat in the project
load.py made, then says what the demo says, answering the agent's question about where to run
with a Small unit. Each turn prints the tools the agent called and its answer; at the end, what
the chat's graph holds and the outside sources it consulted. The transcript is written as JSON.

    python scenario.py --data ~/texera-diabetes                       # against http://localhost:8088
    python scenario.py --data ~/texera-diabetes --gw http://localhost:28088

It needs the platform's model key on the stack. Only the standard library is used.
"""

import argparse
import json
import pathlib
import urllib.parse
import urllib.request
import uuid

from load import PROJECT, Person

# What the presenter says, in order; the first with the file attached.
MESSAGES = [
    "Can you check what's in this data? I want to analyze it using the models in our project. "
    "Which model do you think works best? Please go ahead and run it.",
    "How does that compare with what has been published on models like this? Cite what you find.",
    "Please keep this file as a dataset called Screening cohort.",
]


def ask(gw: str, bearer: str, chat: str, message: str, attached=None) -> dict:
    """One turn over AG-UI: the message in, with a file attached by URI, the events out as they
    stream."""
    content = message
    if attached:
        uri, name = attached
        content = [
            {"type": "text", "text": message},
            {"type": "binary", "mimeType": "application/vnd.texera.resource", "url": uri, "filename": name},
        ]
    body = {
        "threadId": chat,
        "runId": str(uuid.uuid4()),
        "state": {},
        "tools": [],
        "context": [],
        "forwardedProps": {},
        "messages": [{"id": str(uuid.uuid4()), "role": "user", "content": content}],
    }
    req = urllib.request.Request(
        f"{gw}/agents/conversations/{chat}/ag-ui",
        method="POST",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
    )
    turn = {"message": message, "tools": [], "answer": "", "outcome": None}
    with urllib.request.urlopen(req, timeout=1800) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            event = json.loads(line[5:])
            kind = event.get("type")
            if kind == "TOOL_CALL_START":
                turn["tools"].append(event.get("toolCallName"))
                print(f"   - {event.get('toolCallName')}", flush=True)
            elif kind == "TEXT_MESSAGE_CONTENT":
                turn["answer"] += event.get("delta", "")
            elif kind == "RUN_ERROR":
                turn["error"] = event.get("message")
                print(f"   ! {event.get('message')}", flush=True)
            elif kind == "RUN_FINISHED":
                turn["outcome"] = (event.get("outcome") or {}).get("type")
    print(f"\n{turn['answer'].strip()}\n", flush=True)
    return turn


def attach(person: Person, project: str, chat: str, path: pathlib.Path) -> tuple[str, str]:
    """What the chat's attach button does: the file is the chat's own, a dataset no list shows."""
    made = person.must(
        "POST",
        "/datasets",
        {"name": path.name, "parent": project, "spec": {}, "labels": {"texera.attachment": chat}},
    )
    rid = made["metadata"]["rid"]
    person.must("PUT", f"/datasets/{rid}/files/{path.name}", raw=path.read_bytes(), content_type="application/octet-stream")
    version = person.must("POST", f"/datasets/{rid}/commit", {"message": "Attached"})
    return f"{made['metadata']['uri']}@{version['vno']}", path.name


def question_asked(person: Person, chat: str):
    """The question the agent's last message ends on, if it does."""
    messages = person.must("GET", f"/conversations/{chat}/messages?limit=200")["items"]
    if not messages or messages[-1]["role"] != "assistant":
        return None
    asks = [
        p["args"]
        for p in messages[-1]["parts"]
        if p.get("type") == "tool_call" and p.get("toolName") == "ask"
    ]
    return asks[-1] if asks else None


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--data", type=pathlib.Path, required=True, help="the folder prepare.py wrote"
    )
    ap.add_argument("--gw", default="http://localhost:8088", help="the gateway")
    ap.add_argument("--user", default="alice", help="who presents")
    ap.add_argument("--project", default=PROJECT, help="the project's name")
    ap.add_argument(
        "--transcript",
        type=pathlib.Path,
        default=pathlib.Path("diabetes-transcript.json"),
    )
    args = ap.parse_args()
    gw = args.gw.rstrip("/")
    person = Person(gw, args.user)
    projects = person.must("GET", "/projects?limit=500")["items"]
    project = next(
        (p["metadata"]["rid"] for p in projects if p["metadata"]["name"] == args.project),
        None,
    )
    if project is None:
        raise SystemExit(f"no project {args.project} this person may open: run load.py first")

    # Auto mode: each change goes through as the agent makes it; in manual mode each waits for a yes.
    chat = person.must(
        "POST",
        "/conversations",
        {"name": "The screening cohort", "parent": project, "spec": {"workMode": "auto"}},
    )
    rid = chat["metadata"]["rid"]
    print(f"chat {gw}/conversations/{rid}", flush=True)
    attached = attach(person, project, rid, args.data / "uploads" / "screening_cohort.csv")
    turns = []
    for n, message in enumerate(MESSAGES, 1):
        print(f"\n== {n}. {message}", flush=True)
        # A turn can outlast a token: a fresh one for each.
        person = Person(gw, args.user)
        turns.append(ask(gw, person.token, rid, message, attached if n == 1 else None))
        asked = question_asked(person, rid)
        if asked:
            labels = [o["label"] for o in asked.get("options", [])]
            pick = next((label for label in labels if label.startswith("Small")), labels[0])
            print(f"   [{asked.get('question')}] answering: {pick}", flush=True)
            turns.append(ask(gw, Person(gw, args.user).token, rid, pick))

    graph = Person(gw, args.user).must("GET", f"/conversations/{rid}/graph")
    made = sorted(f"{n['role']} {n['name']}" for n in graph["nodes"] if n["made"])
    print(f"the graph: {len(graph['nodes'])} nodes, made: {', '.join(made) or 'nothing'}")
    for source in graph["sources"]:
        print(f"consulted {source['name']}: {len(source['calls'])} calls")
        for c in source["calls"]:
            print(f"   - {c['tool']}: {c['asked']}")
    args.transcript.write_text(
        json.dumps(
            {"chat": chat["metadata"]["uri"], "turns": turns, "graph": graph}, indent=1
        )
        + "\n"
    )
    print(f"transcript: {args.transcript}")


if __name__ == "__main__":
    main()
