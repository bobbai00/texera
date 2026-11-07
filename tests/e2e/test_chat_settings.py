"""A chat stores choices of how its agent works and nothing else: the agent, the model the agent
uses, its add-on MCP servers. A turn runs with the chat's choice, else the default of the nearest
project up the chat's project's chain, Texera's at the top, else the agent's own, and the catalog
is the one place that says which. A choice
someone may not use is passed over for them, so a shared chat still works. Where an execution
runs is not among a chat's choices."""
from texera_e2e import chat


def _said(setting):
    """A setting as "name from": the chat, the agent, or the project whose default it is."""
    source = setting["project"]["name"] if setting.get("project") else setting["from"]
    return f"{setting['name']} from {source}"


def _mounts(settings):
    return [(m["name"], m["from"], m["platform"]) for m in settings["mcpServers"]]


def test_a_new_chat_stores_nothing_and_runs_with_the_defaults(alice, project):
    crid = chat.conversation(alice, "plain chat", project)
    assert alice.get(f"/conversations/{crid}")["spec"] == {}
    runs_with = chat.settings(alice, crid)
    assert runs_with["project"]["rid"] == project
    assert runs_with["agent"]["uri"] == chat.agent_uri(alice) + "@" + runs_with["agent"]["uri"].rsplit("@", 1)[1]
    texera = alice.get(f"/projects/{alice.root()}")["metadata"]["name"]
    assert _said(runs_with["agent"]) == f"Texera Agent from {texera}"
    assert runs_with["modelEndpoint"]["from"] == "agent" and "computingUnit" not in runs_with
    assert _mounts(runs_with) == [("catalog", "agent", True), ("biomcp", "agent", False)]
    assert "skipped" not in runs_with
    assert runs_with == alice.get(f"/projects/{project}/chat-settings"), "a chat not started yet runs with the same"


def test_the_chats_choice_comes_first_then_the_projects(alice, project):
    crid = chat.conversation(alice, "choosy chat", project)
    endpoint = lambda name: alice.create("model-endpoints", name, {"provider": "anthropic", "model": name}, project=project)["metadata"]["uri"]  # noqa: E731
    server = lambda name: alice.create("mcp-servers", name, {"url": f"http://{name}.test/mcp"}, project=project)["metadata"]["uri"]  # noqa: E731
    project_model, chat_model = endpoint("project-model"), endpoint("chat-model")
    project_server, chat_server = server("project-server"), server("chat-server")

    alice.put(f"/projects/{project}", {"spec": {"defaults": {"modelEndpoint": project_model, "mcpServers": [project_server]}}})
    runs_with = chat.settings(alice, crid)
    name = alice.get(f"/projects/{project}")["metadata"]["name"]
    assert _said(runs_with["modelEndpoint"]) == f"project-model from {name}"
    assert _mounts(runs_with) == [("catalog", "agent", True), ("biomcp", "agent", False), ("project-server", "project", False)]

    alice.put(f"/conversations/{crid}", {"spec": {"modelEndpoint": chat_model, "mcpServers": [chat_server]}})
    runs_with = chat.settings(alice, crid)
    assert _said(runs_with["modelEndpoint"]) == "chat-model from chat"
    # The chat's add-ons take the place of the others; the catalog's own server stays.
    assert _mounts(runs_with) == [("catalog", "agent", True), ("chat-server", "chat", False)]
    alice.put(f"/conversations/{crid}", {"spec": {"mcpServers": []}})
    assert _mounts(chat.settings(alice, crid)) == [("catalog", "agent", True)]


def test_a_choice_someone_cannot_use_is_passed_over_for_them(alice, bob, project, grants_guard):
    model = alice.create("model-endpoints", "alice's model", {"provider": "anthropic", "model": "m"}, project=project)["metadata"]["uri"]
    crid = chat.conversation(alice, "ours", project, modelEndpoint=model)
    grants_guard(crid, bob.pid(), "editor")

    hers = chat.settings(alice, crid)
    assert _said(hers["modelEndpoint"]) == "alice's model from chat" and "skipped" not in hers
    his = chat.settings(bob, crid)
    assert his["modelEndpoint"]["from"] == "agent"
    assert his["project"] == hers["project"], "the chat is where it is, for whoever is in it"
    assert {(s["setting"], s["uri"], s["from"]) for s in his["skipped"]} == {("modelEndpoint", model, "chat")}
    assert all(s["reason"] for s in his["skipped"])
