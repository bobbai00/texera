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
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

# Brings the whole Texera 2.0 dev stack up: the infrastructure containers, then the catalog, the
# computing unit, the agent runtime and the frontend on the host. A service already running from
# this worktree is kept; a port held by anything else stops the script.
#
#   bin/texera-2-0/up.sh
#
# The model key is ANTHROPIC_API_KEY from the environment, from the file TEXERA_ENV_FILE names, or
# from a gitignored .env at the repo root; without one everything but the agent runtime starts.
# Logs: logs/texera-2-0/<service>.log. Stop with bin/texera-2-0/down.sh.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
LOGS=${TEXERA2_LOG_DIR:-$ROOT/logs/texera-2-0}
mkdir -p "$LOGS"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

echo "== prerequisites"
for t in docker go bun sbt java uv lsof; do
  command -v "$t" >/dev/null || { echo "$t is not installed (see bin/texera-2-0/README.md)" >&2; exit 1; }
done
ensure_python_env

echo "== infrastructure (compose project texera2)"
docker compose -f "$HERE/docker-compose.yml" up -d
# The one-shot containers must have succeeded (`docker compose wait` ignores ones that already
# exited, so it is not usable here).
for init in openfga-migrate openbao-init rustfs-init lakekeeper-migrate; do
  code=$(docker wait "texera2-$init")
  [ "$code" = "0" ] || { echo "$init failed (exit $code); see: docker logs texera2-$init" >&2; exit 1; }
done
wait_for keycloak 180 http_ok "http://localhost:8088/auth/realms/texera/.well-known/openid-configuration"
wait_for openfga 60 http_ok "http://localhost:18082/healthz"
wait_for openbao 60 http_ok "http://localhost:18200/v1/sys/health"
wait_for lakekeeper 120 http_ok "http://localhost:18181/health"
# The platform's model key goes into the secret store, never into a service's environment or
# the database; the catalog seeds a credential that points at it and the agent runtime leases it.
model_key=${ANTHROPIC_API_KEY:-$(env_file_value ANTHROPIC_API_KEY)}
if [ -n "$model_key" ]; then
  printf '%s' "$model_key" | docker compose -f "$HERE/docker-compose.yml" exec -T -e BAO_TOKEN=texera-dev-root openbao \
    bao kv put -mount=texera platform/anthropic value=- >/dev/null
  echo "openbao: the platform model key is loaded"
  model_key_loaded=1
fi
unset model_key
# Volumes made before init.sql listed them lack the test databases; create what is missing.
for db in catalog_test texera_iceberg_catalog; do
  if ! docker compose -f "$HERE/docker-compose.yml" exec -T postgres \
    psql -U texera -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    docker compose -f "$HERE/docker-compose.yml" exec -T postgres psql -U texera -d postgres -c "CREATE DATABASE $db" >/dev/null
    echo "postgres: created database $db"
  fi
done

echo "== host services"
start catalog 8090 "$ROOT/catalog" "go build -o bin/catalog ./cmd/catalog && exec ./bin/catalog"
wait_for catalog 120 http_ok "http://localhost:8090/healthz"

start unit 28085 "$ROOT" "exec '$HERE/run-unit.sh'"
wait_for unit 900 http_ok "http://localhost:28085/api/health"

# The bio MCP server (PubMed, genes, variants, proteins) behind the gateway at /bio-mcp; its
# API key is a credential the catalog seeds, so agents reach it through a lease.
start bio-mcp 23010 "$ROOT/bio-mcp-service" "PORT=23010 MCP_PATH=/bio-mcp BIOMCP_API_KEY=\${TEXERA2_BIOMCP_KEY:-texera-bio-dev-key} exec bun run src/index.ts"
wait_for bio-mcp 60 http_ok "http://localhost:23010/healthcheck"

start agent-runtime 23002 "$ROOT" "exec '$HERE/run-agent-runtime.sh'"
wait_for agent-runtime 60 lsof -nP -iTCP:23002 -sTCP:LISTEN
if [ -z "$model_key_loaded" ]; then
  echo "agent-runtime: up, but no model key was loaded; put ANTHROPIC_API_KEY in the environment or in $ROOT/.env to chat"
fi

# The live service: the sessions in which people are on a resource together, behind the gateway
# at /live/. It asks the catalog who may join and saves what they edit into its versions.
start live 23003 "$ROOT/live" "TEXERA_LIVE_PORT=23003 TEXERA_CATALOG_URL=http://localhost:8088 TEXERA_OIDC_TOKEN_URL=http://localhost:18081/auth/realms/texera/protocol/openid-connect/token exec bun src/main.ts"
wait_for live 60 http_ok "http://localhost:23003/live/health"

start frontend 5174 "$ROOT/frontend-next" "exec bun run dev"
wait_for frontend 60 http_ok "http://localhost:8088/"

echo "== up: http://localhost:8088 (alice/alice, bob/bob)"
