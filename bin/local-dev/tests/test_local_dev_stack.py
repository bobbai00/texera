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

"""Tests for how local-dev runs bin/single-node's containers beside the services it runs on the
host: which containers `up` starts before the build, how Lakekeeper and the gateway reach the
host's services, and that the dashboard (tui.py), main.sh and the dev server's proxy agree on the
services and their ports. They read the files only; nothing here starts a container."""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlparse

import pytest

yaml = pytest.importorskip("yaml")

REPO_ROOT = Path(__file__).resolve().parents[3]
MAIN_SH = (REPO_ROOT / "bin" / "local-dev" / "main.sh").read_text()
SINGLE_NODE = REPO_ROOT / "bin" / "single-node"


def _bash_array(name: str) -> list[str]:
    m = re.search(rf"^{name}=\(([^)]*)\)", MAIN_SH, re.MULTILINE)
    assert m, f"main.sh has no {name}=(...)"
    return [w for w in re.sub(r"#.*", "", m.group(1)).split()]


def _amap(key: str) -> dict[str, str]:
    """main.sh's `amap_set <key> <service> <value>` rows (the docker rows share a line, split by
    semicolons)."""
    return dict(re.findall(rf"amap_set\s+{key}\s+([^\s;]+)\s+([^\s;]+)", MAIN_SH))


@pytest.fixture(scope="module")
def compose() -> dict:
    return yaml.safe_load((SINGLE_NODE / "docker-compose.yml").read_text())["services"]


@pytest.fixture(scope="module")
def overlay() -> dict:
    path = REPO_ROOT / "bin" / "local-dev" / "docker-compose.override.yml"
    return yaml.safe_load(path.read_text())["services"]


def _depends_on(service: dict) -> list[str]:
    deps = service.get("depends_on", {})
    return list(deps) if isinstance(deps, (list, dict)) else []


def test_tui_and_main_sh_list_the_same_services(tui):
    types, ports = _amap("SVC_TYPE"), _amap("SVC_PORT")
    in_main = {s: (types[s], int(ports[s])) for s in _bash_array("SERVICES")}
    in_tui = {s.name: (s.type, s.port) for s in tui.SERVICES}
    assert in_tui == in_main


def test_infra_lists_name_compose_services(compose):
    docker_rows = {s for s in _bash_array("SERVICES") if _amap("SVC_TYPE")[s] == "docker"}
    for name in _bash_array("DOCKER_INFRA_SERVICES") + _bash_array("DOCKER_INFRA_LONGLIVED"):
        assert name in compose, f"{name} is not a service of bin/single-node"
    # Every docker row of the dashboard is a long-lived container infra_state counts.
    assert set(_bash_array("DOCKER_INFRA_LONGLIVED")) == docker_rows
    assert "lakekeeper-init" not in MAIN_SH


def test_infra_started_before_the_build_needs_none_of_the_hosts_services(compose):
    # `docker compose up -d <these>` starts their dependencies too: none may be a Texera service
    # local-dev runs on the host instead (jupyter is Texera's image, but runs in docker here).
    docker_rows = {s for s in _bash_array("SERVICES") if _amap("SVC_TYPE")[s] == "docker"}

    def closure(name: str, seen: set[str]) -> set[str]:
        for dep in _depends_on(compose[name]):
            if dep not in seen:
                seen.add(dep)
                closure(dep, seen)
        return seen

    for name in _bash_array("DOCKER_INFRA_SERVICES"):
        for dep in {name} | closure(name, set()):
            if "${IMAGE_REGISTRY" in compose[dep].get("image", ""):
                assert dep in docker_rows, f"starting {name} would start the containerized {dep}"
    # Both depend on such services, so main.sh starts them on their own (--no-deps).
    for name in ("lakekeeper", "gateway"):
        assert name not in _bash_array("DOCKER_INFRA_SERVICES")
        assert re.search(rf"infra_compose up -d --no-deps {name}\b", MAIN_SH), name


def test_lakekeeper_reads_the_catalog_issuer_on_the_host(overlay):
    env = dict(
        re.findall(r"^([A-Z][A-Z0-9_]*)=(.*)$", (SINGLE_NODE / ".env").read_text(), re.MULTILINE)
    )
    in_docker = urlparse(env["LAKEKEEPER__OPENID_PROVIDER_URI"])
    in_local_dev = overlay["lakekeeper"]["environment"]["LAKEKEEPER__OPENID_PROVIDER_URI"]
    acs_port = _amap("SVC_PORT")["access-control-service"]
    assert in_local_dev == f"http://${{HOST_LAN_IP}}:{acs_port}{in_docker.path}"
    assert in_docker.port == int(acs_port)
    assert "lakekeeper-init" not in overlay


def test_the_gateway_reaches_every_service_on_the_host(overlay):
    envoy = yaml.safe_load((SINGLE_NODE / "envoy.yaml").read_text())
    upstreams = {
        lb["endpoint"]["address"]["socket_address"]["address"]
        for cluster in envoy["static_resources"]["clusters"]
        if cluster.get("type") == "STRICT_DNS"
        for endpoints in cluster["load_assignment"]["endpoints"]
        for lb in endpoints["lb_endpoints"]
    }
    mapped = dict(entry.split(":", 1) for entry in overlay["gateway"]["extra_hosts"])
    assert set(mapped) == upstreams
    assert set(mapped.values()) == {"${HOST_LAN_IP}"}
    # extra_hosts lands in /etc/hosts, which only the system's resolver reads.
    for cluster in envoy["static_resources"]["clusters"]:
        if cluster.get("type") == "STRICT_DNS":
            resolver = cluster["typed_dns_resolver_config"]["name"]
            assert resolver == "envoy.network.dns_resolver.getaddrinfo", cluster["name"]


def test_the_dev_proxy_sends_the_units_websocket_to_the_gateway(compose):
    proxy = json.loads((REPO_ROOT / "frontend" / "proxy.config.json").read_text())["/wsapi"]
    gateway_port = _amap("SVC_PORT")["gateway"]
    assert proxy["target"] == f"http://localhost:{gateway_port}"
    assert proxy["ws"] is True
    # gateway_up moves the gateway off texera-web's 8080 through this variable.
    assert compose["gateway"]["ports"] == ["${TEXERA_PORT:-8080}:8080"]
    assert _amap("SVC_PORT")["texera-web"] == "8080"
