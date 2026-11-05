"""Fixtures: the stack by URL, the people, a project per test that goes away with it, the iris
dataset, a ready unit, and guards that put shared settings back."""
from __future__ import annotations

import os
import pathlib
import random
import string
import time
import warnings

import pytest

from texera_e2e import kube
from texera_e2e.client import Api, ApiError, token

IRIS = pathlib.Path(__file__).resolve().parents[2] / "bin" / "texera-2-0" / "examples" / "iris.csv"
PEOPLE = {"alice": "alice", "bob": "bob", "texera-admin": "admin"}


def pytest_addoption(parser):
    parser.addoption("--gw", default=os.environ.get("GW", "http://localhost:8088"), help="the gateway of the stack under test")
    parser.addoption("--model", action="store_true", help="run the scenarios that drive a real model")
    parser.addoption("--cluster", action="store_true", help="run the scenarios that need the Kubernetes deployment")
    parser.addoption("--local", action="store_true", help="run the scenarios that need the Compose stack's host processes")
    parser.addoption("--destructive", action="store_true", help="run the scenarios that change what other tests see")


def pytest_collection_modifyitems(config, items):
    gates = {"model": "--model", "cluster": "--cluster", "local": "--local", "destructive": "--destructive"}
    for item in items:
        for marker, flag in gates.items():
            if marker in item.keywords and not config.getoption(flag):
                item.add_marker(pytest.mark.skip(reason=f"needs {flag}"))


@pytest.fixture(scope="session")
def gw(request) -> str:
    return request.config.getoption("--gw").rstrip("/")


@pytest.fixture(scope="session")
def run_id() -> str:
    """Tells this run's resources apart from a previous run's leftovers."""
    return time.strftime("%H%M%S") + "".join(random.choices(string.ascii_lowercase, k=3))


@pytest.fixture(scope="session")
def people(gw) -> dict[str, Api]:
    return {user: Api(gw, token(gw, user, password)) for user, password in PEOPLE.items()}


@pytest.fixture(scope="session")
def alice(people) -> Api:
    return people["alice"]


@pytest.fixture(scope="session")
def bob(people) -> Api:
    return people["bob"]


@pytest.fixture(scope="session")
def admin(people) -> Api:
    return people["texera-admin"]


@pytest.fixture(scope="session")
def anon(gw) -> Api:
    return Api(gw)


@pytest.fixture(scope="session")
def service(gw) -> str:
    """The catalog's own client token, for what only a service may do."""
    from texera_e2e.client import client_token
    status, tok = client_token(f"{gw}/auth/realms/texera/protocol/openid-connect/token", "texera-services", "texera-services-secret")
    assert status == 200, "the service client's token"
    return tok


# Kinds a project may hold, in the order their references allow deleting them.
KINDS = ["conversations", "workflows", "operators", "credentials", "environments", "datasets", "mcp-servers", "model-endpoints", "agent-templates", "skills", "computing-units"]


def _delete_execution(api: Api, workflow: str, eid: str, phase: str) -> None:
    path = f"/workflows/{workflow}/executions/{eid}"
    if phase in ("pending", "provisioning", "running"):
        api.call("POST", f"{path}/cancel", {})
    api.call("DELETE", path)


def _clear(api: Api, project: str) -> None:
    """Best effort: what the project's chats made, wherever it landed (an agent's workflow goes
    to the person's home project unless the tool names a parent), then the project's executions,
    then the resources in reference order, twice."""
    # The project's own defaults may name what is in it; a resource still named cannot go.
    api.call("PUT", f"/projects/{project}", {"spec": {}})
    made: list = []
    for c in api.get(f"/conversations?project={project}&limit=500")["items"]:
        made += api.get(f"/conversations/{c['metadata']['rid']}/resources")
    for r in made:
        if r["kind"] == "execution":
            _delete_execution(api, r["metadata"]["parent"], r["metadata"]["rid"], r["status"]["phase"])
    workflows = [r for r in made if r["kind"] == "workflow"] + api.get(f"/workflows?project={project}&limit=500")["items"]
    for wf in workflows:
        for ex in api.get(f"/workflows/{wf['metadata']['rid']}/executions?limit=500")["items"]:
            _delete_execution(api, wf["metadata"]["rid"], ex["metadata"]["rid"], ex["status"]["phase"])
    for _ in range(2):
        for plural in KINDS:
            kind = plural[:-1]
            rids = [r["metadata"]["rid"] for r in made if r["kind"] == kind]
            rids += [r["metadata"]["rid"] for r in api.get(f"/{plural}?project={project}&limit=500")["items"]]
            for rid in rids:
                api.call("DELETE", f"/resources/{rid}")


@pytest.fixture
def project(alice, run_id, request) -> str:
    """A project of alice's for this test alone; everything in it goes at the end. What stays
    behind is reported as a warning, never hidden: a leftover misleads the next test."""
    name = f"e2e {request.node.name[:40]} {run_id}"
    rid = alice.create("projects", name, {})["metadata"]["rid"]
    yield rid
    try:
        _clear(alice, rid)
    except ApiError as e:
        warnings.warn(f"clearing {name}: {e}", stacklevel=1)
    status, body = alice.call("DELETE", f"/projects/{rid}")
    if status != 204:
        warnings.warn(f"{name} stays ({status}): {body}", stacklevel=1)


class Iris(dict):
    """The iris dataset of a test: rid, uri, head and the URI of its file."""

    @property
    def rid(self) -> str:
        return self["metadata"]["rid"]

    @property
    def uri(self) -> str:
        return self["metadata"]["uri"]

    @property
    def file(self) -> str:
        return f"{self.uri}@{self['metadata']['head']}/files/iris.csv"


def make_iris(api: Api, project: str, name: str = "iris") -> Iris:
    ds = api.create("datasets", name, {"format": "csv"}, project=project, description="Fisher's iris flowers")
    rid = ds["metadata"]["rid"]
    api.upload(f"/datasets/{rid}/files/iris.csv", IRIS.read_bytes())
    api.post(f"/datasets/{rid}/commit", {"message": "initial upload"})
    return Iris(api.get(f"/datasets/{rid}"))


@pytest.fixture
def iris(alice, project) -> Iris:
    return make_iris(alice, project)


@pytest.fixture(scope="session")
def unit(alice) -> str:
    """The URI of a ready unit everyone may run on: one of the platform's own, whatever units
    of their own the people of a long-lived stack have made."""
    platform = alice.me()["systemProject"]
    for _ in range(60):
        ready = [u for u in alice.get(f"/computing-units/available?scope={platform}") if u["status"]["phase"] == "ready"]
        if ready:
            return ready[0]["metadata"]["uri"]
        time.sleep(5)
    pytest.fail("no computing unit is ready")


@pytest.fixture
def settings_guard(admin):
    """Puts the platform settings back as they were."""
    before = admin.get("/settings")["spec"]
    yield before
    admin.put("/settings", {"spec": before})


@pytest.fixture
def grants_guard(alice):
    """Revokes at the end what the test granted through it."""
    given: list[tuple[str, str]] = []

    def grant(rid: str, pid: str, relation: str) -> None:
        alice.grant(rid, pid, relation)
        if (rid, pid) not in given:
            given.append((rid, pid))

    yield grant
    for rid, pid in given:
        alice.revoke(rid, pid)


@pytest.fixture(scope="session")
def kubectl() -> bool:
    return kube.available()
