"""An execution runs on a computing unit and keeps its results in a warehouse. A warehouse is a
resource like a unit: Texera holds the deployment's, a project can have its own (on the
deployment's store, or on a store Texera's admins allow and the lake has tried), the one an
execution uses is chosen the same way, along the project's chain, using one is a permission of
its own, and one goes only when nothing keeps results in it."""
import os

import pytest

from texera_e2e import kube
from texera_e2e import workflows as w
from texera_e2e.client import Api


def lake_name(api: Api, warehouse: dict) -> str:
    return api.get(f"/warehouses/{warehouse['metadata']['rid']}")["status"]["name"]


def platform_warehouse(api: Api) -> dict:
    """The deployment's warehouse: Texera's default, which every project inherits."""
    uri = api.settings(api.root())["defaults"]["warehouse"]
    return api.get(f"/warehouses/{uri.rsplit('/', 1)[-1]}")


def test_an_execution_keeps_its_results_in_a_warehouse_chosen_like_a_unit(alice, project, iris, unit):
    platform = platform_warehouse(alice)
    assert platform["metadata"]["project"] == alice.root(), "the deployment's warehouse is Texera's"
    assert alice.status("DELETE", f"/warehouses/{platform['metadata']['rid']}") == 403, "Texera's admins'"
    assert alice.settings(project)["from"]["defaults.warehouse"] == alice.root(), "the project inherits it"
    wf = alice.create("workflows", "petal lengths", w.average_by_species(iris.file), project=project)["metadata"]["rid"]

    # Nothing names another: the one the project inherits from Texera.
    first = w.run(alice, wf, "to Texera's", computingUnit=unit)
    assert first["status"]["phase"] == "completed", w.error_text(first)
    assert first["spec"]["warehouse"] == platform["metadata"]["uri"]

    # A warehouse of the project's own, with no store of its own: a place on the deployment's store.
    own = alice.create("warehouses", "lab results", {}, project=project)
    name = lake_name(alice, own)
    assert name == "w_" + own["metadata"]["rid"].replace("-", "") and own["spec"] == {}
    alice.put(f"/projects/{project}", {"spec": {"defaults": {"warehouse": own["metadata"]["uri"]}}})
    second = w.run(alice, wf, "to the lab's", computingUnit=unit)
    assert second["status"]["phase"] == "completed", w.error_text(second)
    assert second["spec"]["warehouse"] == own["metadata"]["uri"]
    # The unit wrote there and reads from there: the catalog opened the execution's namespace in
    # that warehouse alone, so rows mean the engine went where it was told.
    assert len(w.rows(alice, wf, second["metadata"]["rid"])["rows"]) == 3
    assert len(w.rows(alice, wf, first["metadata"]["rid"])["rows"]) == 3, "the earlier execution is read from its own"

    # The request's choice wins over the project's; what it names must be a warehouse.
    third = w.run(alice, wf, "back to Texera's", computingUnit=unit, warehouse=platform["metadata"]["uri"])
    assert third["spec"]["warehouse"] == platform["metadata"]["uri"]
    assert alice.status("POST", f"/workflows/{wf}/run", {"warehouse": unit}) == 400


@pytest.mark.cluster
def test_the_lake_holds_an_execution_in_its_own_warehouse(alice, service, project, iris, unit):
    """Asked inside the cluster, the lake lists the execution's namespace in the warehouse it
    names, and not in the deployment's."""
    wf = alice.create("workflows", "petal lengths", w.average_by_species(iris.file), project=project)["metadata"]["rid"]
    own = alice.create("warehouses", "lab results", {}, project=project)
    run = w.run(alice, wf, "to the lab's", computingUnit=unit, warehouse=own["metadata"]["uri"])
    assert run["status"]["phase"] == "completed", w.error_text(run)
    namespace = "e_" + run["metadata"]["rid"].replace("-", "")
    assert kube.lake_namespaces(lake_name(alice, own), service) == [namespace]
    assert namespace not in kube.lake_namespaces(lake_name(alice, platform_warehouse(alice)), service)
    # A person's own token gets nothing from the lake, whichever warehouse.
    assert kube.lake_namespaces(lake_name(alice, own), alice.token) is None


def test_using_a_warehouse_is_a_permission_of_its_own(alice, bob, project, iris, unit, grants_guard):
    wf = alice.create("workflows", "petal lengths", w.average_by_species(iris.file), project=project)["metadata"]["rid"]
    own = alice.create("warehouses", "lab results", {}, project=project)
    grants_guard(project, bob.pid(), "viewer")
    # A viewer runs the project's workflow into the warehouse it inherits from Texera, which is everyone's.
    run = w.run(bob, wf, "bob's", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    # The project's own is not his to fill, until he is given the use of it.
    assert bob.status("POST", f"/workflows/{wf}/run", {"computingUnit": unit, "warehouse": own["metadata"]["uri"]}) == 403
    grants_guard(own["metadata"]["rid"], bob.pid(), "user")
    run = w.run(bob, wf, "bob's, in the lab's", computingUnit=unit, warehouse=own["metadata"]["uri"])
    assert run["status"]["phase"] == "completed" and run["spec"]["warehouse"] == own["metadata"]["uri"], w.error_text(run)


def test_a_warehouse_on_a_store_of_its_own(alice, admin, project, iris, unit, texera_guard, request):
    """A store the owner names: the deployment's own here, in a place of the test's, with the
    key in a credential. The lake tries it before it takes it."""
    # The deployment's store as the lake and the units reach it; a warehouse may always be on it.
    on_cluster = request.config.getoption("--cluster")
    endpoint = os.environ.get("TEXERA_E2E_STORE", "http://rustfs:9000" if on_cluster else "http://127.0.0.1:19001")
    place = {"endpoint": endpoint, "region": "us-east-1", "bucket": "texera", "keyPrefix": f"e2e/{project}"}
    key = alice.create("credentials", "bucket key", {"kind": "api_key"}, project=project)
    wrong = alice.create("credentials", "a wrong key", {"kind": "api_key"}, project=project)
    alice.put(f"/credentials/{key['metadata']['rid']}/secret", {"fields": {"accessKeyId": "texera", "secretAccessKey": "texera-secret"}})
    alice.put(f"/credentials/{wrong['metadata']['rid']}/secret", {"fields": {"accessKeyId": "texera", "secretAccessKey": "not-the-secret"}})

    def make(storage: dict, name: str = "ours") -> tuple[int, dict]:
        return alice.call("POST", "/warehouses", {"name": name, "parent": project, "spec": {"storage": storage}})

    # An address nobody listed: the lake and the units would connect to it. The project's own
    # list does not open it either: it narrows what Texera allows, which is nothing.
    status, body = make({**place, "endpoint": "http://somewhere.example:9000", "credential": key["metadata"]["uri"]})
    assert status == 400 and "limits" in body["message"], body
    alice.put(f"/projects/{project}", {"spec": {"limits": {"warehouseEndpoints": ["http://somewhere.example:9000"]}}})
    status, body = make({**place, "endpoint": "http://somewhere.example:9000", "credential": key["metadata"]["uri"]})
    assert status == 400 and "limits" in body["message"], body
    # A key the store does not take: the lake's own refusal, and nothing is made.
    status, body = make({**place, "credential": wrong["metadata"]["uri"]})
    assert status == 400 and body["details"]["field"] == "/storage", body
    assert alice.get(f"/warehouses?project={project}")["items"] == []

    status, own = make({**place, "credential": key["metadata"]["uri"]})
    assert status == 201, own
    assert "texera-secret" not in str(own), "the key is not in the resource"
    wf = alice.create("workflows", "petal lengths", w.average_by_species(iris.file), project=project)["metadata"]["rid"]
    run = w.run(alice, wf, "to our own store", computingUnit=unit, warehouse=own["metadata"]["uri"])
    assert run["status"]["phase"] == "completed", w.error_text(run)
    assert len(w.rows(alice, wf, run["metadata"]["rid"])["rows"]) == 3

    # Its place cannot change; the credential stays while the warehouse uses it; a listed store is taken.
    moved = {"spec": {"storage": {**place, "bucket": "elsewhere", "credential": key["metadata"]["uri"]}}}
    assert alice.status("PUT", f"/warehouses/{own['metadata']['rid']}", moved) == 400
    assert alice.status("DELETE", f"/credentials/{key['metadata']['rid']}") == 409
    root, texeras = texera_guard
    admin.put(f"/projects/{root}", {"spec": {**texeras, "limits": {"warehouseEndpoints": ["http://somewhere.example:9000"]}}})
    status, body = make({**place, "endpoint": "http://somewhere.example:9000", "credential": key["metadata"]["uri"]}, "listed")
    assert status == 400 and "limits" not in body["message"], "listed by Texera and the project, the address is the lake's to try"


def test_a_warehouse_goes_only_when_nothing_keeps_results_in_it(alice, project, iris, unit):
    wf = alice.create("workflows", "petal lengths", w.average_by_species(iris.file), project=project)["metadata"]["rid"]
    own = alice.create("warehouses", "lab results", {}, project=project)
    rid = own["metadata"]["rid"]
    run = w.run(alice, wf, "kept", computingUnit=unit, warehouse=own["metadata"]["uri"])
    assert run["status"]["phase"] == "completed", w.error_text(run)

    status, body = alice.call("DELETE", f"/warehouses/{rid}")
    assert status == 409 and body["code"] == "in_use", body
    # Named as the project's default it is referenced; with the execution gone and nothing naming it, it goes.
    alice.put(f"/projects/{project}", {"spec": {"defaults": {"warehouse": own["metadata"]["uri"]}}})
    alice.delete(f"/workflows/{wf}/executions/{run['metadata']['rid']}")
    status, body = alice.call("DELETE", f"/warehouses/{rid}")
    assert status == 409 and body["code"] == "referenced", body
    alice.put(f"/projects/{project}", {"spec": {}})
    # The lake clears the dropped tables first, for some seconds; the catalog waits for it.
    assert alice.status("DELETE", f"/warehouses/{rid}") == 204
    assert alice.status("GET", f"/warehouses/{rid}") == 404
