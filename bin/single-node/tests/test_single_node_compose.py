# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""Structural tests for bin/single-node: the compose file, its .env and the SQL it initializes
Postgres with. They pin how the lake's catalog is set up: Lakekeeper checks every request's token
with the key the access control service publishes and asks OpenFGA what the caller may do,
OpenFGA stays off the computing unit's network, and the DashboardService, not a setup job,
creates the shared warehouse. Nothing here starts a container."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlparse

import pytest

yaml = pytest.importorskip("yaml")

REPO_ROOT = Path(__file__).resolve().parents[3]
SINGLE_NODE = REPO_ROOT / "bin" / "single-node"


@pytest.fixture(scope="module")
def services() -> dict:
    return yaml.safe_load((SINGLE_NODE / "docker-compose.yml").read_text())["services"]


@pytest.fixture(scope="module")
def env() -> dict[str, str]:
    values = {}
    for line in (SINGLE_NODE / ".env").read_text().splitlines():
        m = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line)
        if m:
            values[m.group(1)] = m.group(2)
    return values


def _depends_on(service: dict) -> dict[str, str]:
    """A service's dependencies with their conditions, in either of compose's two forms."""
    deps = service.get("depends_on", {})
    if isinstance(deps, list):
        return {name: "service_started" for name in deps}
    return {name: spec.get("condition", "service_started") for name, spec in deps.items()}


def test_every_dependency_is_a_service_and_there_is_no_cycle(services):
    for name, service in services.items():
        for dep in _depends_on(service):
            assert dep in services, f"{name} depends on {dep}, which is not a service"
    done: set[str] = set()

    def visit(name: str, path: tuple[str, ...]) -> None:
        assert name not in path, f"dependency cycle: {' -> '.join(path + (name,))}"
        if name in done:
            return
        for dep in _depends_on(services[name]):
            visit(dep, path + (name,))
        done.add(name)

    for name in services:
        visit(name, ())


def test_no_job_sets_the_catalog_up(services):
    # The DashboardService makes the shared warehouse; no setup job, and nothing waiting on one.
    assert "lakekeeper-init" not in services
    for name, service in services.items():
        assert "lakekeeper-init" not in _depends_on(service), name


def test_lakekeeper_starts_after_openfga_and_the_access_control_service(services):
    # Lakekeeper reads the key it checks tokens with when it starts, and stops when it cannot.
    deps = _depends_on(services["lakekeeper"])
    assert deps["openfga"] == "service_healthy"
    assert deps["access-control-service"] == "service_healthy"
    assert deps["lakekeeper-migrate"] == "service_completed_successfully"
    # Its migration writes the authorization model into OpenFGA.
    assert _depends_on(services["lakekeeper-migrate"])["openfga"] == "service_healthy"
    assert _depends_on(services["openfga"]) == {"openfga-migrate": "service_completed_successfully"}
    # The access control service needs nothing Lakekeeper needs, or the order would be a cycle.
    assert set(_depends_on(services["access-control-service"])) == {"postgres"}


def test_the_dashboard_starts_after_the_catalog_and_its_bucket(services):
    deps = _depends_on(services["dashboard-service"])
    assert deps["lakekeeper"] == "service_healthy"
    # It creates the shared warehouse, whose files go in the bucket rustfs-init makes.
    assert deps["rustfs-init"] == "service_completed_successfully"


def test_only_lakekeeper_reaches_openfga(services):
    # OpenFGA asks for no credential: it is on a network of its own, which holds only it, its
    # one caller and their migrations, and the Postgres it keeps its data in. So neither a
    # computing unit nor JupyterLab, where users run their own code, reaches it.
    for name in ("openfga", "openfga-migrate"):
        assert services[name]["networks"] == ["authz"], name
    on_authz = {name for name, svc in services.items() if "authz" in svc.get("networks", ["default"])}
    assert on_authz == {"openfga", "openfga-migrate", "lakekeeper", "lakekeeper-migrate", "postgres"}


def test_openfga_keeps_its_answers_briefly_and_no_tuple_reads(env):
    # Answers are kept 2 seconds, so an execution whose access ended is refused within that. A
    # cache of tuple reads would hide a new execution's grant from its first requests.
    assert env["OPENFGA_CHECK_QUERY_CACHE_ENABLED"] == "true"
    assert env["OPENFGA_CHECK_QUERY_CACHE_TTL"] == "2s"
    for name in ("OPENFGA_CHECK_ITERATOR_CACHE_ENABLED", "OPENFGA_CACHE_CONTROLLER_ENABLED"):
        assert name not in env, name


def test_openfga_is_healthy_by_its_grpc_port(services, env):
    probe = services["openfga"]["healthcheck"]["test"]
    assert probe[:2] == ["CMD", "/usr/local/bin/grpc_health_probe"]
    endpoint = urlparse(env["LAKEKEEPER__OPENFGA__ENDPOINT"])
    assert endpoint.hostname == services["openfga"]["container_name"]
    assert f"-addr=localhost:{endpoint.port}" in probe
    for name in ("openfga", "openfga-migrate"):
        assert services[name]["image"] == "openfga/openfga:v1.11.2"


def test_lakekeeper_checks_tokens_and_asks_openfga(env):
    assert env["LAKEKEEPER__AUTHZ_BACKEND"] == "openfga"
    assert env["LAKEKEEPER__OPENID_AUDIENCE"] == "texera-catalog"
    issuer = urlparse(env["LAKEKEEPER__OPENID_PROVIDER_URI"])
    assert (issuer.hostname, issuer.port, issuer.path) == (
        "access-control-service", 9096, "/api/catalog-issuer"
    )


def test_both_lakekeeper_services_read_the_catalog_settings(services):
    # lakekeeper-migrate writes OpenFGA's model, so it needs the same authorizer settings.
    for name in ("lakekeeper", "lakekeeper-migrate"):
        assert ".env" in services[name]["env_file"], name


def test_openfga_keeps_its_data_in_the_database_postgres_creates_for_it(services, env):
    assert env["OPENFGA_DATASTORE_ENGINE"] == "postgres"
    datastore = urlparse(env["OPENFGA_DATASTORE_URI"])
    assert datastore.hostname == services["postgres"]["container_name"]
    database = datastore.path.lstrip("/")
    sql = (REPO_ROOT / "sql" / "texera_openfga.sql").read_text()
    assert f"CREATE DATABASE {database};" in sql
    # Postgres runs every file in sql/ on a new volume.
    assert "../../sql:/docker-entrypoint-initdb.d" in services["postgres"]["volumes"]


def test_a_computing_unit_gets_no_catalog_credential(services):
    unit = services["workflow-runtime-coordinator-service"]
    assert "env_file" not in unit
    names = [str(e).split("=", 1)[0] for e in unit.get("environment", [])]
    for name in names:
        assert not name.startswith(("LAKEKEEPER", "OPENFGA", "AUTH_")), name
        assert "TOKEN" not in name and "SECRET" not in name, name
    assert unit["networks"] == ["unit"]
