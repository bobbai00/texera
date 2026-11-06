"""A chat with an agent: one AG-UI turn at a time, through the gateway."""
from __future__ import annotations

import json
import urllib.request
import uuid

from .client import Api


def agent_uri(api: Api) -> str:
    """The deployment's agent: the template a chat runs unless it or its project chooses another."""
    return api.get("/settings")["spec"]["defaults"]["agentTemplate"]


def settings(api: Api, conversation: str) -> dict:
    """What a turn of the chat runs with for this person, as the catalog resolves it."""
    return api.get(f"/conversations/{conversation}/settings")


def tool(api: Api, name: str, /, headers: dict | None = None, **arguments) -> tuple[bool, str]:
    """Calls an MCP tool as an agent does: whether it failed, and the text it answered. The
    tool's own arguments are the keywords, `name` among them."""
    status, body = api.mcp("tools/call", {"name": name, "arguments": arguments}, headers=headers)
    assert status == 200, (status, body)
    result = body["result"]
    return bool(result.get("isError")), "\n".join(c.get("text", "") for c in result["content"])


def in_turn(api: Api, conversation: str, service_token: str) -> tuple[str, dict]:
    """Starts a turn and returns it with the headers the runtime puts on a tool call made in
    it: the chat as the call's origin, vouched for by the service token."""
    turn = api.post(f"/conversations/{conversation}/turns", {})
    origin = f"conversation={conversation};turn={turn['turn']};template={turn['template']}"
    return turn["turn"], {"X-Texera-Origin": origin, "X-Texera-Service-Token": service_token}


def second_unit(api: Api, project: str, name: str = "a second unit") -> str:
    """Another computing unit resource at the deployment's engine, so a test can tell where an
    execution went on any stack; returns its URI."""
    platform = api.me()["systemProject"]
    base = next(u for u in api.get(f"/computing-units/available?scope={platform}") if u["spec"]["provider"] == "static")
    spec = {"provider": "static", "endpoint": base["spec"]["endpoint"]}
    if base["spec"].get("clientId"):
        spec["clientId"] = base["spec"]["clientId"]
    return api.create("computing-units", name, spec, project=project)["metadata"]["uri"]


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


def conversation(api: Api, name: str, project: str | None = None, **choices) -> str:
    """A chat in a project. It stores only the choices given (modelEndpoint, mcpServers,
    template); with none it runs with the project's and the platform's defaults."""
    body = {"name": name, "spec": choices}
    if project:
        body["parent"] = project
    return api.post("/conversations", body)["metadata"]["rid"]


def made_in(api: Api, conversation_rid: str) -> list:
    """The resources a chat made, or made a version of, as envelopes, the latest first."""
    return [item["resource"] for item in api.get(f"/conversations/{conversation_rid}/resources") if item["made"]]


def created_in(api: Api, conversation_rid: str) -> list:
    """The resources a chat created itself: [(kind, name, rid)]. Not one it only changed, which
    was someone's before the chat."""
    return [(r["kind"], r["metadata"]["name"], r["metadata"]["rid"]) for r in made_in(api, conversation_rid)
            if (r["metadata"].get("origin") or {}).get("conversation") == conversation_rid]
