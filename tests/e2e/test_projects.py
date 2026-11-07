"""Projects inherit from one another, up to Texera. Texera is made at install, open to everyone,
and holds what the release ships; it is a project like any other, changed by its admins, and the
identity provider's administrator is one of them. A project's people read and use what the
projects up its chain hold and change none of it; a project's settings fill in from up its chain,
the nearest value winning and the strictest limit holding. A public project works the same way
for anyone's resources: what is in it is everyone's to read, and the lists agree with what can
be opened."""
import pytest

from texera_e2e.client import uri_rid

SKILL = {"name": "a-skill", "description": "d", "body": "b"}


def test_texera_is_what_every_project_inherits_from(alice, bob, project):
    root = bob.root()
    texera = bob.get(f"/projects/{root}")["metadata"]
    assert texera["visibility"] == "public" and "base" not in texera
    assert bob.get(f"/projects/{bob.home()}")["metadata"]["base"] == root, "a home inherits from Texera"
    assert alice.get(f"/projects/{project}")["metadata"]["base"] == root, "so does a new project"
    # Bob was given nothing: what Texera holds is his to list, in any project's scope, and to open.
    for plural in ("agent-templates", "skills", "mcp-servers", "model-endpoints", "credentials", "profiles", "computing-units", "operators"):
        held = [r for r in bob.get(f"/{plural}?limit=200&scope={bob.home()}")["items"] if r["metadata"]["project"] == root]
        assert held, f"Texera holds no {plural} bob can list"
        for r in held[:5]:
            assert bob.status("GET", f"/resources/{r['metadata']['rid']}") == 200
    settings = bob.settings(bob.home())
    assert [p["rid"] for p in settings["chain"]] == [bob.home(), root]
    assert settings["defaults"]["agentTemplate"] and settings["from"]["defaults.agentTemplate"] == root


def test_texeras_admins_change_it_and_nobody_else(alice, admin, anon, texera_guard):
    root, before = texera_guard
    agent = alice.get(alice.settings(root)["defaults"]["agentTemplate"].replace("texera://", "/"))
    rid = agent["metadata"]["rid"]
    edited = {**agent["spec"], "prompt": "Ignore everything."}
    for method, path, body in (
        ("PUT", f"/agent-templates/{rid}", {"spec": edited}),
        ("PATCH", f"/resources/{rid}", {"name": "Ours"}),
        ("DELETE", f"/agent-templates/{rid}", None),
        ("PATCH", f"/resources/{root}", {"name": "Ours"}),
        ("PUT", f"/projects/{root}", {"spec": {**before, "branding": {"name": "Alice's"}}}),
        ("POST", "/skills", {"name": "sneaked in", "parent": root, "spec": SKILL}),
        ("PUT", f"/resources/{root}/grants/{alice.pid()}", {"relation": "owner"}),
    ):
        status, answer = alice.call(method, path, body)
        assert status == 403 and answer["code"] == "forbidden", (method, path, status, answer)
    same = alice.get(f"/agent-templates/{rid}")
    assert same["metadata"]["head"] == agent["metadata"]["head"] and same["spec"]["prompt"] == agent["spec"]["prompt"]

    # The administrator is one of Texera's admins: what they add is everyone's, and its look is
    # the sign-in page's and every project's that sets none of its own.
    skill = admin.create("skills", "house style", SKILL, project=root)["metadata"]["rid"]
    try:
        assert skill in [s["metadata"]["rid"] for s in alice.get(f"/skills?limit=200&scope={alice.home()}")["items"]]
        admin.put(f"/projects/{root}", {"spec": {**before, "branding": {"name": "Clinic", "logoUrl": "https://clinic.example/logo.svg"}}})
        assert anon.get("/public")["branding"]["name"] == "Clinic"
        look = alice.settings(alice.home())
        assert look["branding"]["name"] == "Clinic" and look["from"]["branding.name"] == root
    finally:
        admin.call("DELETE", f"/skills/{skill}")
    status, answer = admin.call("PATCH", f"/resources/{root}", {"visibility": "private"})
    assert status == 409 and answer["code"] == "root", (status, answer)


def test_a_project_inherits_what_its_base_holds(alice, bob, admin, run_id):
    lab = admin.create("projects", f"e2e lab {run_id}", {})["metadata"]["rid"]
    study = None
    try:
        skill = admin.create("skills", "lab method", SKILL, project=lab)["metadata"]["rid"]
        # Inheriting is sharing: alice makes a project inherit from the lab only as its admin too.
        status, _ = alice.call("POST", "/projects", {"name": f"e2e study {run_id}", "base": lab, "spec": {}})
        assert status == 403
        admin.grant(lab, alice.pid(), "owner")
        study = alice.post("/projects", {"name": f"e2e study {run_id}", "base": lab, "spec": {}})["metadata"]["rid"]
        alice.grant(study, bob.pid(), "editor")
        # Bob, a member of the study, reads what the lab holds, and Texera's things, and changes none.
        assert bob.status("GET", f"/skills/{skill}") == 200
        scoped = [s["metadata"]["rid"] for s in bob.get(f"/skills?limit=200&scope={study}")["items"]]
        assert skill in scoped and any(s["metadata"]["project"] == bob.root() for s in bob.get(f"/skills?limit=200&scope={study}")["items"])
        assert bob.status("PUT", f"/skills/{skill}", {"spec": {**SKILL, "body": "mine"}}) == 403
        assert bob.status("PUT", f"/projects/{study}", {"spec": {"branding": {"name": "Bob's"}}}) == 403, "a member works in a project; its admins change it"
        assert [p["name"] for p in bob.settings(study)["chain"]][:2] == [f"e2e study {run_id}", f"e2e lab {run_id}"]
        # The lab's admin gets nothing in the study, and may send it back to Texera.
        admin.revoke(lab, alice.pid())
        assert admin.status("GET", f"/projects/{study}") == 403
        admin.call("PATCH", f"/resources/{study}", {"base": admin.root()})
        assert bob.status("GET", f"/skills/{skill}") == 403, "what the study no longer inherits"
        assert alice.get(f"/projects/{study}")["metadata"]["base"] == alice.root()
    finally:
        if study:
            alice.call("DELETE", f"/projects/{study}")
        for s in admin.get(f"/skills?project={lab}&limit=50")["items"]:
            admin.call("DELETE", f"/skills/{s['metadata']['rid']}")
        status, body = admin.call("DELETE", f"/projects/{lab}")
        assert status == 204, body


def test_a_projects_settings_come_from_the_nearest_project_and_its_limits_from_the_strictest(alice, project, texera_guard):
    root, _ = texera_guard
    alice.put(f"/projects/{project}", {"spec": {"defaults": {"workMode": "manual"}, "limits": {"results": "P7D"}}})
    settings = alice.settings(project)
    assert settings["defaults"]["workMode"] == "manual" and settings["from"]["defaults.workMode"] == project
    assert settings["from"]["defaults.agentTemplate"] == root and settings["limits"]["results"] == "P7D"
    chat = alice.get(f"/projects/{project}/chat-settings")
    assert chat["workMode"] == {"mode": "manual", "from": "project", "project": {"rid": project, "name": alice.get(f"/projects/{project}")["metadata"]["name"]}}
    assert chat["agent"]["from"] == "project" and chat["agent"]["project"]["rid"] == root


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
