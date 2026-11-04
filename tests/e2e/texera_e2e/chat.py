"""A chat with an agent: one AG-UI turn at a time, through the gateway."""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
import uuid

from .client import Api


def template_uri(api: Api, name: str) -> str:
    templates = api.get(f"/agent-templates?q={urllib.parse.quote(name)}")["items"]
    return next(t for t in templates if t["metadata"]["name"] == name)["metadata"]["uri"]


class Turn:
    """What one turn produced: the events, the assistant's text, the tools it called."""

    def __init__(self, events: list):
        self.events = events
        self.text = "".join(e.get("delta", "") for e in events if e.get("type") == "TEXT_MESSAGE_CONTENT").strip()
        self.tool_calls = [e.get("toolCallName") for e in events if e.get("type") == "TOOL_CALL_START"]
        self.handoffs = [e.get("value", {}) for e in events if e.get("type") == "CUSTOM" and e.get("name") == "texera.handoff"]
        self.resources = [e.get("value") for e in events if e.get("type") == "CUSTOM" and e.get("name") == "texera.resource"]
        self.errors = [e for e in events if e.get("type") == "RUN_ERROR"]
        finished = [e for e in events if e.get("type") == "RUN_FINISHED"]
        self.outcome = (finished[-1].get("outcome") or {}).get("type") if finished else None


def say(api: Api, conversation: str, prompt: str, template: str | None = None, timeout: int = 900) -> Turn:
    """Runs one turn and returns it when the stream ends; prints the tool calls as they come."""
    body = {
        "threadId": conversation, "runId": str(uuid.uuid4()), "state": {}, "tools": [], "context": [],
        "forwardedProps": {"template": template} if template else {},
        "messages": [{"id": str(uuid.uuid4()), "role": "user", "content": prompt}],
    }
    req = urllib.request.Request(f"{api.gw}/agents/conversations/{conversation}/ag-ui", method="POST", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {api.token}", "Content-Type": "application/json", "Accept": "text/event-stream"})
    events = []
    with urllib.request.urlopen(req, timeout=timeout) as r:
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
                print(f"    result: {str(ev.get('content', ''))[:160].replace(chr(10), ' ')}", flush=True)
            elif t == "CUSTOM" and ev.get("name") == "texera.handoff":
                v = ev.get("value", {})
                print(f"  handoff by {v.get('by')}: -> {v.get('name')}", flush=True)
            elif t == "RUN_ERROR":
                print(f"  RUN_ERROR: {ev}", flush=True)
    turn = Turn(events)
    print("\nassistant:\n" + turn.text + "\n", flush=True)
    return turn


def conversation(api: Api, name: str, template: str, unit: str | None = None, project: str | None = None) -> str:
    spec = {"template": template}
    if unit:
        spec["computingUnit"] = unit
    body = {"name": name, "spec": spec}
    if project:
        body["parent"] = project
    return api.post("/conversations", body)["metadata"]["rid"]


def created_in(api: Api, conversation_rid: str) -> list:
    """The resources a chat made: [(kind, name, head)]."""
    return [(r["kind"], r["metadata"]["name"], r["metadata"]["rid"]) for r in api.get(f"/conversations/{conversation_rid}/resources")]
