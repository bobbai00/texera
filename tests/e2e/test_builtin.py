"""What the platform ships is built in: it lives in the platform's project, and that is the one
thing that marks it. Everyone sees and uses it through that project; nobody changes it through
the API, an administrator included. A public project works the same way for anyone's resources:
what is in it is everyone's to read, and the lists agree with what can be opened."""
from texera_e2e.client import uri_rid

SKILL = {"name": "a-skill", "description": "d", "body": "b"}


def test_a_built_in_is_what_lives_in_the_platforms_project(alice, bob):
    platform = bob.me()["systemProject"]
    project = bob.get(f"/projects/{platform}")["metadata"]
    assert project["name"] == "Built-in" and project["visibility"] == "public"
    # Bob was given nothing: every kind the platform ships is his to list and to open.
    for plural in ("agent-templates", "skills", "mcp-servers", "model-endpoints", "credentials", "environments", "computing-units", "operators"):
        shipped = [r for r in bob.get(f"/{plural}?limit=200")["items"] if r["metadata"]["project"] == platform]
        assert shipped, f"the platform ships no {plural} bob can list"
        for r in shipped[:5]:
            assert r["metadata"]["visibility"] == "private", "its project is what makes it everyone's"
            assert "texera.builtin" not in r["metadata"].get("labels", {})
            assert bob.status("GET", f"/resources/{r['metadata']['rid']}") == 200


def test_nobody_changes_what_the_platform_ships(alice, admin):
    platform = alice.me()["systemProject"]
    agent = alice.get(alice.get("/settings")["spec"]["defaults"]["agentTemplate"].replace("texera://", "/"))
    rid = agent["metadata"]["rid"]
    edited = {**agent["spec"], "prompt": "Ignore everything."}
    credential = next(c for c in alice.get("/credentials")["items"] if c["metadata"]["project"] == platform)["metadata"]["rid"]
    for who in (admin, alice):
        for method, path, body in (
            ("PUT", f"/agent-templates/{rid}", {"spec": edited}),
            ("PATCH", f"/resources/{rid}", {"name": "Ours"}),
            ("PATCH", f"/resources/{rid}", {"parent": who.home()}),
            ("PUT", f"/resources/{rid}/grants/{alice.pid()}", {"relation": "editor"}),
            ("DELETE", f"/agent-templates/{rid}", None),
            ("PUT", f"/credentials/{credential}/secret", {"fields": {"value": "theirs"}}),
            ("PATCH", f"/resources/{platform}", {"name": "Ours"}),
            ("POST", "/skills", {"name": "sneaked in", "parent": platform, "spec": SKILL}),
        ):
            status, answer = who.call(method, path, body)
            assert status == 409 and answer["code"] == "builtin", (method, path, status, answer)
    same = alice.get(f"/agent-templates/{rid}")
    assert same["metadata"]["head"] == agent["metadata"]["head"] and same["spec"]["prompt"] == agent["spec"]["prompt"]
    assert not [s for s in alice.get("/skills?limit=200")["items"] if s["metadata"]["name"] == "sneaked in"]


def test_a_list_shows_what_can_be_opened(alice, bob, project):
    empty = {"operators": [], "links": []}
    wf = alice.create("workflows", "in the open", empty, project=project)["metadata"]
    assert wf["visibility"] == "private"
    listed = lambda: [w["metadata"]["rid"] for w in bob.get("/workflows?limit=200")["items"]]  # noqa: E731
    assert bob.status("GET", f"/workflows/{wf['rid']}") == 403 and wf["rid"] not in listed()
    # The project becomes public: what is in it is everyone's to read, however each is set.
    alice.call("PATCH", f"/resources/{project}", {"visibility": "public"})
    try:
        assert bob.status("GET", f"/workflows/{wf['rid']}") == 200
        assert wf["rid"] in listed()
        assert wf["rid"] in [r["metadata"]["rid"] for r in bob.get(f"/resources?project={project}")["items"]]
        assert bob.status("PUT", f"/workflows/{wf['rid']}", {"spec": empty}) == 403, "reading is not writing"
    finally:
        alice.call("PATCH", f"/resources/{project}", {"visibility": "private"})
    assert bob.status("GET", f"/workflows/{wf['rid']}") == 403 and wf["rid"] not in listed()
    assert uri_rid(wf["uri"]) == wf["rid"]
