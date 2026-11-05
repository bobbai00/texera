"""A chat stores choices and nothing else: its agent, the model the agent uses, the computing
unit its executions prefer, its add-on MCP servers. A turn runs with the chat's choice, else the
project's, else the agent's own or the platform's default, and the catalog is the one place that
says which. A choice someone may not use is passed over for them, so a shared chat still works."""
from texera_e2e import chat


def _said(setting):
    return f"{setting['name']} from {setting['from']}"


def _mounts(settings):
    return [(m["name"], m["from"], m["platform"]) for m in settings["mcpServers"]]


def test_a_new_chat_stores_nothing_and_runs_with_the_defaults(alice, project):
    crid = chat.conversation(alice, "plain chat", project)
    assert alice.get(f"/conversations/{crid}")["spec"] == {}
    runs_with = chat.settings(alice, crid)
    assert runs_with["project"]["rid"] == project
    assert runs_with["agent"]["uri"] == chat.agent_uri(alice) + "@" + runs_with["agent"]["uri"].rsplit("@", 1)[1]
    assert _said(runs_with["agent"]) == "Texera Agent from platform"
    assert runs_with["modelEndpoint"]["from"] == "agent" and runs_with["computingUnit"]["from"] == "platform"
    assert _mounts(runs_with) == [("catalog", "agent", True), ("biomcp", "agent", False)]
    assert "skipped" not in runs_with
    assert runs_with == alice.get(f"/projects/{project}/chat-settings"), "a chat not started yet runs with the same"


def test_the_chats_choice_comes_first_then_the_projects(alice, project):
    crid = chat.conversation(alice, "choosy chat", project)
    endpoint = lambda name: alice.create("model-endpoints", name, {"provider": "anthropic", "model": name}, project=project)["metadata"]["uri"]  # noqa: E731
    server = lambda name: alice.create("mcp-servers", name, {"url": f"http://{name}.test/mcp"}, project=project)["metadata"]["uri"]  # noqa: E731
    project_model, chat_model = endpoint("project-model"), endpoint("chat-model")
    project_server, chat_server = server("project-server"), server("chat-server")
    project_unit, chat_unit = chat.second_unit(alice, project, "project unit"), chat.second_unit(alice, project, "chat unit")

    alice.put(f"/projects/{project}", {"spec": {"defaultModelEndpoint": project_model, "defaultComputingUnit": project_unit, "mcpServers": [project_server]}})
    runs_with = chat.settings(alice, crid)
    assert _said(runs_with["modelEndpoint"]) == "project-model from project" and _said(runs_with["computingUnit"]) == "project unit from project"
    assert _mounts(runs_with) == [("catalog", "agent", True), ("biomcp", "agent", False), ("project-server", "project", False)]

    alice.put(f"/conversations/{crid}", {"spec": {"modelEndpoint": chat_model, "computingUnit": chat_unit, "mcpServers": [chat_server]}})
    runs_with = chat.settings(alice, crid)
    assert _said(runs_with["modelEndpoint"]) == "chat-model from chat" and _said(runs_with["computingUnit"]) == "chat unit from chat"
    # The chat's add-ons take the place of the others; the platform's own server stays.
    assert _mounts(runs_with) == [("catalog", "agent", True), ("chat-server", "chat", False)]
    alice.put(f"/conversations/{crid}", {"spec": {"mcpServers": []}})
    assert _mounts(chat.settings(alice, crid)) == [("catalog", "agent", True)]


def test_a_choice_someone_cannot_use_is_passed_over_for_them(alice, bob, project, grants_guard):
    model = alice.create("model-endpoints", "alice's model", {"provider": "anthropic", "model": "m"}, project=project)["metadata"]["uri"]
    unit = chat.second_unit(alice, project, "alice's unit")
    crid = chat.conversation(alice, "ours", project, modelEndpoint=model, computingUnit=unit)
    grants_guard(crid, bob.pid(), "editor")

    hers = chat.settings(alice, crid)
    assert _said(hers["modelEndpoint"]) == "alice's model from chat" and _said(hers["computingUnit"]) == "alice's unit from chat" and "skipped" not in hers
    his = chat.settings(bob, crid)
    assert his["modelEndpoint"]["from"] == "agent" and his["computingUnit"]["from"] == "platform"
    assert his["project"] == hers["project"], "the chat is where it is, for whoever is in it"
    assert {(s["setting"], s["uri"], s["from"]) for s in his["skipped"]} == {("modelEndpoint", model, "chat"), ("computingUnit", unit, "chat")}
    assert all(s["reason"] for s in his["skipped"])
