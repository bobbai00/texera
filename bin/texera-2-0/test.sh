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

# Runs the Texera 2.0 tests and prints one line per step.
#
#   bin/texera-2-0/test.sh suites   # unit and integration suites (need the stack's Postgres)
#   bin/texera-2-0/test.sh e2e      # end to end through the gateway (need up.sh)
#   bin/texera-2-0/test.sh          # both
#
# The real-model checks (the chat, the bio researcher's handoff, the Playwright chat) run
# when ANTHROPIC_API_KEY or TEXERA_ENV_FILE is set, and are reported as skipped otherwise.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
LOGS=${TEXERA2_LOG_DIR:-$ROOT/logs/texera-2-0}
mkdir -p "$LOGS/tests"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

RESULTS=()
FAILED=0
step() {
  local name=$1 log
  shift
  log="$LOGS/tests/$(echo "$name" | tr -c 'a-zA-Z0-9\n' '-').log"
  printf '%-44s' "$name"
  local started=$SECONDS
  if "$@" >"$log" 2>&1; then
    echo "pass  $((SECONDS - started))s"
    RESULTS+=("pass  $name")
  else
    echo "FAIL  $((SECONDS - started))s  (log: $log)"
    RESULTS+=("FAIL  $name")
    FAILED=1
  fi
}
skip() { printf '%-44s%s\n' "$1" "skipped: $2"; RESULTS+=("skip  $1"); }

suites() {
  echo "== suites"
  # TEXERA_TEST_REQUIRE_DB turns "postgres not available" from a skip into a failure.
  step "catalog (go vet + go test)" bash -c "cd '$ROOT/catalog' && go vet ./... && TEXERA_TEST_REQUIRE_DB=1 go test -count=1 -p 1 ./..."
  step "agent runtime (types, lint, bun test)" bash -c "cd '$ROOT/agent-runtime' && bun run typecheck && bun run lint && bun test"
  step "frontend (types, lint, vitest)" bash -c "cd '$ROOT/frontend-next' && bun run typecheck && bun run lint && bun run test"
  # Every sbt module, as CI runs them: results on the stack's Postgres-backed Iceberg catalog,
  # Python workers on the uv environment (.venv), integration-tagged suites left to the e2e phase.
  step "engine and libraries (sbt test)" bash -c "cd '$ROOT' && \
    UDF_PYTHON_PATH='$ROOT/.venv/bin/python' AMBER_TEST_FILTER=skip-integration \
    STORAGE_ICEBERG_CATALOG_TYPE=postgres \
    STORAGE_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME=localhost:15432/texera_iceberg_catalog \
    STORAGE_ICEBERG_CATALOG_POSTGRES_USERNAME=texera STORAGE_ICEBERG_CATALOG_POSTGRES_PASSWORD=texera \
    sbt -batch test"
}

# The engine's integration-tagged suites, on the dev stack's Lakekeeper and RustFS like the unit.
engine_integration() {
  step "engine integration suites (REST catalog)" bash -c "cd '$ROOT' && \
    UDF_PYTHON_PATH='$ROOT/.venv/bin/python' AMBER_TEST_FILTER=integration-only \
    STORAGE_ICEBERG_CATALOG_TYPE=rest \
    STORAGE_ICEBERG_CATALOG_REST_URI=http://localhost:18181/catalog \
    STORAGE_ICEBERG_CATALOG_REST_WAREHOUSE_NAME=texera STORAGE_S3_ENDPOINT=http://localhost:19001 \
    STORAGE_S3_REGION=us-east-1 STORAGE_S3_AUTH_USERNAME=texera STORAGE_S3_AUTH_PASSWORD=texera-secret \
    sbt -batch WorkflowOperator/test WorkflowExecutionService/test"
}

e2e() {
  echo "== end to end (gateway http://localhost:8088)"
  if ! http_ok "http://localhost:8090/healthz" || ! http_ok "http://localhost:28085/api/health"; then
    echo "the stack is not up; run bin/texera-2-0/up.sh first" >&2
    FAILED=1
    return
  fi
  engine_integration
  step "catalog: versions, sharing, datasets, MCP" "$HERE/smoke-catalog.sh"
  step "run: compile, execute, results, lineage" "$HERE/smoke-run.sh"
  step "results kept across runs" python3 "$HERE/smoke-retention.py"
  step "environments: UDF with a package" python3 "$HERE/smoke-env.py"
  step "custom operator: pinned environment, delete refused" python3 "$HERE/smoke-operator.py"
  step "sharing a project: a viewer reads and runs" python3 "$HERE/smoke-share.py"
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${TEXERA_ENV_FILE:-}" ]; then
    skip "chat (real model)" "no ANTHROPIC_API_KEY"
    skip "bio researcher, handoff to the analyst (real model)" "no ANTHROPIC_API_KEY"
    step "frontend e2e (Playwright, no model)" bash -c "cd '$ROOT/frontend-next' && TEXERA_E2E_SKIP_MODEL=1 bunx playwright test"
    step "results after a unit restart" python3 "$HERE/smoke-restart.py"
    return
  fi
  if [ -z "$(listener 23002)" ]; then
    skip "chat (real model)" "agent runtime not running"
    return
  fi
  step "chat (real model)" python3 "$HERE/smoke-chat.py"
  step "bio researcher, handoff to the analyst (real model)" python3 "$HERE/smoke-chat.py" --demo
  step "frontend e2e (Playwright)" bash -c "cd '$ROOT/frontend-next' && bunx playwright test"
  # Last: it restarts the unit.
  step "results after a unit restart" python3 "$HERE/smoke-restart.py"
}

case "${1:-all}" in
  suites) suites ;;
  e2e) e2e ;;
  all) suites; e2e ;;
  *) echo "usage: $0 [suites|e2e]" >&2; exit 2 ;;
esac

echo "== summary"
printf '%s\n' "${RESULTS[@]}"
exit $FAILED
