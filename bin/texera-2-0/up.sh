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
#   TEXERA_ENV_FILE=../texera/.env bin/texera-2-0/up.sh    # where ANTHROPIC_API_KEY is read from
#
# Without ANTHROPIC_API_KEY (or TEXERA_ENV_FILE) everything but the agent runtime starts.
# Logs: logs/texera-2-0/<service>.log. Stop with bin/texera-2-0/down.sh.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
LOGS=${TEXERA2_LOG_DIR:-$ROOT/logs/texera-2-0}
mkdir -p "$LOGS"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

echo "== infrastructure (compose project texera2)"
docker compose -f "$HERE/docker-compose.yml" up -d
docker compose -f "$HERE/docker-compose.yml" wait openfga-migrate rustfs-init lakekeeper-init >/dev/null
wait_for keycloak 180 http_ok "http://localhost:8088/auth/realms/texera/.well-known/openid-configuration"
wait_for openfga 60 http_ok "http://localhost:18082/healthz"
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

if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${TEXERA_ENV_FILE:-}" ]; then
  start agent-runtime 23002 "$ROOT" "exec '$HERE/run-agent-runtime.sh'"
  wait_for agent-runtime 60 lsof -nP -iTCP:23002 -sTCP:LISTEN
else
  echo "agent-runtime: skipped; set ANTHROPIC_API_KEY or TEXERA_ENV_FILE to chat"
fi

start frontend 5174 "$ROOT/frontend-next" "exec bun run dev"
wait_for frontend 60 http_ok "http://localhost:8088/"

echo "== up: http://localhost:8088 (alice/alice, bob/bob)"
