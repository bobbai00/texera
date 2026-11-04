"""Environments: a Python UDF that imports a package the unit lacks fails without an
environment and completes in one that lists the package; the environment records its build."""
import pytest

from texera_e2e import workflows as w


@pytest.mark.slow
def test_a_udf_needs_its_environment(alice, project, iris, unit):
    env = alice.create("environments", "py-humanize", {"python": {"packages": ["humanize==4.11.0"]}}, project=project)
    env_uri = env["metadata"]["uri"]
    udf = {"code": w.UDF_RANK, "workers": 1, "retainInputColumns": True, "defaultEnv": True,
           "outputColumns": [{"attributeName": "rank", "attributeType": "string"}]}
    wf = alice.create("workflows", "humanize ranks", w.with_operator(iris.file, "PythonUDFV2", udf, opid="udf"), project=project)
    rid = wf["metadata"]["rid"]
    validated = alice.post(f"/workflows/{rid}/validate", {})
    assert validated["ok"], validated["operatorErrors"]

    plain = w.run(alice, rid, "no environment", computingUnit=unit)
    # The engine names the missing module when its Python is 3.11 or newer; the cluster image's
    # 3.10 cannot (`add_note`), so the message is a bare ModuleNotFoundError there.
    assert plain["status"]["phase"] == "failed" and w.missing_module(plain, "humanize")

    with_env = w.run(alice, rid, "with environment", wait=600, computingUnit=unit, environment=env_uri)
    assert with_env["status"]["phase"] == "completed", w.error_text(with_env)
    assert with_env["spec"]["environment"] == f"{env_uri}@1", "the execution pins the environment version"
    page = w.rows(alice, rid, with_env["metadata"]["rid"], opid="udf", limit=3)
    assert page["rows"][0][w.column(page, "rank")] == "1st"
    builds = alice.get(f"/environments/{env['metadata']['rid']}")["status"].get("builds", [])
    assert any(b["state"] == "ready" for b in builds)
