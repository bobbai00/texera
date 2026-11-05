"""A chat names the computing unit its runs use, and the catalog applies it: a tool call an
agent makes in the chat, vouched for by the runtime, compiles and runs there with nothing said
about units. A unit named in the call wins; the same call outside a chat falls back to the
workflow's, the project's or the platform's default."""
import json

from texera_e2e import chat
from texera_e2e import workflows as w


def test_a_run_in_a_chat_uses_the_chats_unit(alice, project, iris, service):
    platform = alice.get("/settings")["spec"]["defaults"]["computingUnit"]
    mine = chat.second_unit(alice, project)
    assert mine != platform
    wf = alice.create("workflows", "in a chat", w.average_by_species(iris.file), project=project)["metadata"]["rid"]
    crid = chat.conversation(alice, "on my unit", chat.agent_uri(alice), mine, project)
    turn, in_chat = chat.in_turn(alice, crid, service)
    try:
        failed, text = chat.tool(alice, "dataflow", "validate_workflow", headers=in_chat, rid=wf)
        assert not failed and json.loads(text)["ok"] is True, text[:600]

        failed, text = chat.tool(alice, "dataflow", "run_workflow", headers=in_chat, rid=wf, waitSeconds=240)
        run = json.loads(text)
        assert not failed and run["status"]["phase"] == "completed", text[:800]
        assert run["spec"]["computingUnit"] == mine, "the run went to the chat's unit"
        assert run["metadata"]["origin"]["conversation"] == crid

        # The person asked for another unit, so the agent names it: the call's own word wins.
        failed, text = chat.tool(alice, "dataflow", "run_workflow", headers=in_chat, rid=wf, waitSeconds=240, computingUnit=platform)
        assert not failed and json.loads(text)["spec"]["computingUnit"] == platform, text[:800]

        # A forged origin, without the runtime's token, is refused outright.
        status, _ = alice.mcp("dataflow", "tools/call", {"name": "run_workflow", "arguments": {"rid": wf}}, headers={"X-Texera-Origin": in_chat["X-Texera-Origin"]})
        assert status == 401
    finally:
        alice.call("DELETE", f"/conversations/{crid}/turns/{turn}")

    # Outside any chat nothing changes.
    assert w.run(alice, wf, "outside a chat")["spec"]["computingUnit"] == platform
