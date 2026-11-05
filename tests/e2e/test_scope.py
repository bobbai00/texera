"""A project is the scope of what a person sees: its own resources and what it inherits, the
platform's built-ins. A call made in a chat is scoped to the chat's project when it names no
scope, and what it makes goes into that project: an agent works where the chat is."""
import json

from texera_e2e import chat

SKILL = {"name": "a-skill", "description": "d", "body": "b"}
SHIPPED = "texera-workflows"


def _names(api, path, headers=None):
    status, page = api.call("GET", path, headers=headers) if headers else api.call("GET", path)
    assert status == 200, (path, status, page)
    return {r["metadata"]["name"] for r in (page["items"] if isinstance(page, dict) else page)}


def test_a_scope_is_a_project_and_what_it_inherits(alice, bob, project, run_id):
    home, here, there = alice.home(), f"here {run_id}", f"at home {run_id}"
    alice.create("skills", here, SKILL, project=project)
    at_home = alice.create("skills", there, SKILL)["metadata"]["rid"]
    try:
        assert {here, there, SHIPPED} <= _names(alice, "/skills?limit=200")
        for path in ("/skills?limit=200", "/resources?kind=skill&limit=200"):
            scoped = _names(alice, f"{path}&scope={project}")
            assert {here, SHIPPED} <= scoped and there not in scoped, path
            scoped = _names(alice, f"{path}&scope={home}")
            assert {there, SHIPPED} <= scoped and here not in scoped, path
        # An exact project inherits nothing; projects themselves are never narrowed.
        assert _names(alice, f"/skills?project={project}") == {here}
        assert "Built-in" in _names(alice, f"/projects?limit=200&scope={project}")
        # A scope names a project, and shows someone else only what they may read of it.
        assert alice.status("GET", f"/skills?scope={at_home}") == 400
        theirs = _names(bob, f"/skills?limit=200&scope={project}")
        assert SHIPPED in theirs and here not in theirs
    finally:
        alice.call("DELETE", f"/skills/{at_home}")


def test_a_call_in_a_chat_works_in_the_chats_project(alice, project, service, run_id):
    here, there = f"here {run_id}", f"at home {run_id}"
    alice.create("skills", here, SKILL, project=project)
    at_home = alice.create("skills", there, SKILL)["metadata"]["rid"]
    crid = chat.conversation(alice, "scoped chat", project)
    assert chat.settings(alice, crid)["project"]["rid"] == project
    turn, in_chat = chat.in_turn(alice, crid, service)
    made = None
    try:
        # What an agent's search sees: the chat's project and the built-ins.
        failed, text = chat.tool(alice, "search_resources", headers=in_chat, kind="skill", limit=200)
        found = {r["metadata"]["name"] for r in json.loads(text)["items"]}
        assert not failed and {here, SHIPPED} <= found and there not in found
        # Another project, by naming it.
        failed, text = chat.tool(alice, "search_resources", headers=in_chat, kind="skill", limit=200, scope=alice.home())
        found = {r["metadata"]["name"] for r in json.loads(text)["items"]}
        assert not failed and there in found and here not in found
        # What it makes lands in the chat's project.
        failed, text = chat.tool(alice, "create_workflow", headers=in_chat, name=f"made in a chat {run_id}", spec={"operators": [], "links": []})
        made = json.loads(text)
        assert not failed and made["metadata"]["project"] == project, text[:600]
        assert made["metadata"]["origin"]["conversation"] == crid
    finally:
        alice.call("DELETE", f"/conversations/{crid}/turns/{turn}")
        alice.call("DELETE", f"/skills/{at_home}")
