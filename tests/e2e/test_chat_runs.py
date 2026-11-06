"""Where an execution runs is not a chat's to choose. A tool call an agent makes in a chat,
vouched for by the runtime, compiles and runs where any call does: on the unit it names, else the
workflow's default unit, the project's or the platform's. A workflow that names a unit made for it
runs there for the agent and for the person alike. A forged origin is refused outright."""
import json

from texera_e2e import chat
from texera_e2e import workflows as w


def test_a_run_in_a_chat_goes_where_any_run_goes(alice, project, iris, service):
    platform = alice.get("/settings")["spec"]["defaults"]["computingUnit"]
    mine = chat.second_unit(alice, project)
    assert mine != platform
    plain = alice.create("workflows", "plain", w.average_by_species(iris.file), project=project)["metadata"]["rid"]
    own = alice.create("workflows", "with its unit", {**w.average_by_species(iris.file), "defaultComputingUnit": mine}, project=project)["metadata"]["rid"]
    crid = chat.conversation(alice, "the work", project)
    assert "computingUnit" not in chat.settings(alice, crid)
    turn, in_chat = chat.in_turn(alice, crid, service)
    try:
        # With nothing said, in the chat as outside it: the platform's unit.
        failed, text = chat.tool(alice, "run_workflow", headers=in_chat, rid=plain, waitSeconds=240)
        run = json.loads(text)
        assert not failed and run["status"]["phase"] == "completed", text[:800]
        assert run["spec"]["computingUnit"] == platform and run["metadata"]["origin"]["conversation"] == crid

        # A workflow that names its unit compiles and runs there.
        failed, text = chat.tool(alice, "validate_workflow", headers=in_chat, rid=own)
        assert not failed and json.loads(text)["ok"] is True, text[:600]
        failed, text = chat.tool(alice, "run_workflow", headers=in_chat, rid=own, waitSeconds=240)
        assert not failed and json.loads(text)["spec"]["computingUnit"] == mine, text[:800]

        # The person asked for another unit, so the agent names it: the call's own word wins.
        failed, text = chat.tool(alice, "run_workflow", headers=in_chat, rid=own, waitSeconds=240, computingUnit=platform)
        assert not failed and json.loads(text)["spec"]["computingUnit"] == platform, text[:800]

        # A forged origin, without the runtime's token, is refused outright.
        status, _ = alice.mcp("tools/call", {"name": "run_workflow", "arguments": {"rid": plain}}, headers={"X-Texera-Origin": in_chat["X-Texera-Origin"]})
        assert status == 401
    finally:
        alice.call("DELETE", f"/conversations/{crid}/turns/{turn}")

    # Outside any chat, the same workflow goes to the same unit.
    assert w.run(alice, own, "by hand")["spec"]["computingUnit"] == mine
