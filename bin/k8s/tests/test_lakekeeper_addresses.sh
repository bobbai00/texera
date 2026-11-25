#!/usr/bin/env bash
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
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Lakekeeper's values name two of the chart's services by address: the access control
# service, which publishes the key the catalog tokens are signed with, and OpenFGA, which
# keeps the catalog's grants. The subchart renders its values as they are written, so the
# addresses are literals, and a rename on either side installs cleanly: Lakekeeper then does
# not start (it reads the issuer's key when it starts), or refuses every call (no OpenFGA).
# This check ties each address to the service it names.
#
# Needs no helm and no cluster, so it runs anywhere the repo does.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

python3 - "$CHART_DIR" <<'PY'
import os
import re
import sys

chart_dir = sys.argv[1]

try:
    import yaml
except ImportError:
    print(
        "FAIL: PyYAML is required by this check but is not installed.\n"
        "  Install it with: python -m pip install -r amber/dev-requirements.txt",
        file=sys.stderr,
    )
    sys.exit(1)


def read(relative):
    with open(os.path.join(chart_dir, relative), encoding="utf-8") as handle:
        return handle.read()


values = yaml.safe_load(read("values.yaml"))
lakekeeper = values["lakekeeper"]
failures = []


def expect(what, actual, wanted):
    if actual != wanted:
        failures.append(f"{what} is {actual!r}, not {wanted!r}")


def by_name(containers):
    return {container["name"]: container for container in containers or []}


# The issuer: the access control service's Service, which texera.releaseService names
# <name>-svc, and the path its catalog issuer resource is served under.
access = values["accessControlService"]
issuer = f"http://{access['name']}-svc:{access['service']['port']}/api/catalog-issuer"
expect("lakekeeper.auth.oauth2.providerUri", lakekeeper["auth"]["oauth2"]["providerUri"], issuer)
if not lakekeeper["auth"]["oauth2"].get("audience"):
    failures.append("lakekeeper.auth.oauth2.audience is empty: Lakekeeper would not check it")

catalog_init = by_name(lakekeeper["catalog"].get("extraInitContainers"))
migration_init = by_name(lakekeeper["catalog"].get("dbMigrations", {}).get("extraInitContainers"))
issuer_wait = catalog_init.get("wait-catalog-issuer")
if issuer_wait is None:
    failures.append("lakekeeper.catalog.extraInitContainers has no wait-catalog-issuer")
else:
    waited = {variable["name"]: variable.get("value") for variable in issuer_wait.get("env", [])}
    expect("wait-catalog-issuer's PROVIDER_URI", waited.get("PROVIDER_URI"), issuer)

# OpenFGA: the Service in templates/base/openfga, read with its template expressions blanked
# out, since only its literal name and ports matter here.
service = yaml.safe_load(
    re.sub(r"\{\{.*?\}\}", "x", read("templates/base/openfga/openfga-service.yaml"))
)
host = service["metadata"]["name"]
ports = {port["name"]: port["port"] for port in service["spec"]["ports"]}
expect("lakekeeper.authz.backend", lakekeeper["authz"]["backend"], "openfga")
expect("lakekeeper.internalOpenFGA", lakekeeper["internalOpenFGA"], False)
expect(
    "lakekeeper.authz.openfga.endpoint",
    lakekeeper["authz"]["openfga"]["endpoint"],
    f"http://{host}:{ports['grpc']}",
)
health = f"http://{host}:{ports['http']}/healthz"
for where, containers in (
    ("lakekeeper.catalog.extraInitContainers", catalog_init),
    ("lakekeeper.catalog.dbMigrations.extraInitContainers", migration_init),
):
    wait = containers.get("wait-openfga")
    if wait is None:
        failures.append(f"{where} has no wait-openfga")
    elif health not in " ".join(wait.get("command", [])):
        failures.append(f"{where}: wait-openfga does not wait on {health}")

# What OpenFGA keeps of its answers to Lakekeeper: each answer for 2 seconds, so an execution
# whose access ended is refused within that, and never the tuples it reads, which would hide a
# new execution's grant from its first requests.
deployment = read("templates/base/openfga/openfga-deployment.yaml")
openfga_env = dict(re.findall(r'- name: (OPENFGA_\w+)\s*\n\s*value: "([^"]*)"', deployment))
expect(
    "OpenFGA's OPENFGA_CHECK_QUERY_CACHE_ENABLED",
    openfga_env.get("OPENFGA_CHECK_QUERY_CACHE_ENABLED"),
    "true",
)
expect("OpenFGA's OPENFGA_CHECK_QUERY_CACHE_TTL", openfga_env.get("OPENFGA_CHECK_QUERY_CACHE_TTL"), "2s")
for name in ("OPENFGA_CHECK_ITERATOR_CACHE_ENABLED", "OPENFGA_CACHE_CONTROLLER_ENABLED"):
    if name in deployment:
        failures.append(f"the OpenFGA deployment sets {name}, which would hide a new grant")

if failures:
    print(f"FAIL: {len(failures)} problem(s) in how Lakekeeper reaches the issuer and OpenFGA:")
    for failure in failures:
        print(f"  {failure}")
    sys.exit(1)

print(f"PASS: Lakekeeper reaches the issuer at {issuer} and OpenFGA at {host}")
PY
