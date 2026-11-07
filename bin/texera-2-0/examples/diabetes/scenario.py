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

"""A scientist new to the diabetes team asks the Texera Agent what the team has, what it can do
with it, and then does it: five questions in one chat in the project load.py made, as bob. Each
turn prints the tools the agent called and its answer; the transcript is written as JSON.

    python scenario.py                      # all five questions, against http://localhost:8088
    python scenario.py --ask 3 5            # only some of them, in a new chat
    python scenario.py --transcript out.json

It needs the platform's model key on the stack. Only the standard library is used.
"""

import argparse
import json
import pathlib
import urllib.parse
import urllib.request
import uuid

QUESTIONS = [
    "I just joined the diabetes team. What does our project have (data, models and tools), and what is each for?",
    "What could we learn by putting these together? Suggest three analyses we could run today.",
    "Let's check our diabetes onset-risk model the honest way: on the women it was never fitted on, how well does it "
    "separate those who developed diabetes from those who did not, and is its predicted risk calibrated?",
    "In the hospital data, is measuring HbA1c associated with fewer readmissions within 30 days? Break it down by "
    "primary diagnosis, and leave out encounters that ended in death or hospice.",
    "For the adolescents with type 1 diabetes, compute the standard CGM metrics for each participant, check them "
    "against what the study itself reported, and tell me whether more daily steps go with more time in range.",
]


def token(gw: str, user: str) -> str:
    data = urllib.parse.urlencode(
        {
            "grant_type": "password",
            "client_id": "texera-app",
            "username": user,
            "password": user,
        }
    ).encode()
    with urllib.request.urlopen(
        f"{gw}/auth/realms/texera/protocol/openid-connect/token", data, timeout=60
    ) as r:
        return json.load(r)["access_token"]


def call(gw: str, bearer: str, method: str, path: str, body=None):
    req = urllib.request.Request(
        f"{gw}/catalog/v1{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def ask(gw: str, bearer: str, chat: str, question: str) -> dict:
    """One turn over AG-UI: the question in, the events out as they stream."""
    body = {
        "threadId": chat,
        "runId": str(uuid.uuid4()),
        "state": {},
        "tools": [],
        "context": [],
        "forwardedProps": {},
        "messages": [{"id": str(uuid.uuid4()), "role": "user", "content": question}],
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
    turn = {"question": question, "tools": [], "answer": "", "outcome": None}
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
    return turn


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--gw", default="http://localhost:8088", help="the gateway")
    ap.add_argument("--user", default="bob", help="the scientist, on the team")
    ap.add_argument(
        "--ask", type=int, nargs="*", help="which questions, 1 to 5; all by default"
    )
    ap.add_argument(
        "--transcript",
        type=pathlib.Path,
        default=pathlib.Path("diabetes-transcript.json"),
    )
    args = ap.parse_args()
    gw = args.gw.rstrip("/")
    bearer = token(gw, args.user)
    projects = call(gw, bearer, "GET", "/resources?kind=project&limit=500")["items"]
    project = next(
        (
            p["metadata"]["rid"]
            for p in projects
            if p["metadata"]["name"] == "Diabetes research"
        ),
        None,
    )
    if project is None:
        raise SystemExit(
            "no project Diabetes research that this person may open: run load.py first"
        )
    # Auto mode: each change goes through as the agent makes it; in manual mode each waits for a yes.
    chat = call(
        gw,
        bearer,
        "POST",
        "/conversations",
        {
            "name": "Getting to know the diabetes project",
            "parent": project,
            "spec": {"workMode": "auto"},
        },
    )
    print(f"chat {gw}/conversations/{chat['metadata']['rid']}")
    turns = []
    for n in args.ask or range(1, len(QUESTIONS) + 1):
        print(f"\n== {n}. {QUESTIONS[n - 1]}")
        turn = ask(gw, bearer, chat["metadata"]["rid"], QUESTIONS[n - 1])
        print(f"\n{turn['answer'].strip()}\n")
        turns.append(turn)
    args.transcript.write_text(
        json.dumps({"chat": chat["metadata"]["uri"], "turns": turns}, indent=1) + "\n"
    )
    print(f"transcript: {args.transcript}")


if __name__ == "__main__":
    main()
