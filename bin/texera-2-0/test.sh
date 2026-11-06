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

# The tests of Texera 2.0, in four layers with one runner each (docs/texera-2-0/TESTING.md):
#
#   bin/texera-2-0/test.sh unit        # no stack: catalog, engine, runtime, frontend
#   bin/texera-2-0/test.sh contract    # the adapters against the stack's peers; the engine on the lake
#   bin/texera-2-0/test.sh scenario    # the end-to-end scenarios against the stack (pytest, tests/e2e)
#   bin/texera-2-0/test.sh ui          # Playwright against the stack, without a model
#   bin/texera-2-0/test.sh evals       # the real-agent scenarios: pytest -m model and Playwright's
#   bin/texera-2-0/test.sh cluster     # the scenarios and Playwright against the Kubernetes deployment
#   bin/texera-2-0/test.sh all         # unit, contract, scenario, ui, evals
#   bin/texera-2-0/test.sh gate        # down --wipe, up, all: the close gate
#
# Extra arguments after `scenario`, `evals` or `cluster` go to pytest (-k, -x, a file). The stack is
# bin/texera-2-0/up.sh for everything but `unit`; the model key for `evals` is ANTHROPIC_API_KEY
# or TEXERA_ENV_FILE, as up.sh reads it. Reports: logs/texera-2-0/reports/*.xml (JUnit) and
# logs/texera-2-0/tests/<step>.log; the exit code is the summary's.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
LOGS=${TEXERA2_LOG_DIR:-$ROOT/logs/texera-2-0}
REPORTS=$LOGS/reports
PY=$ROOT/.venv/bin/python
GW_LOCAL=http://localhost:8088
GW_CLUSTER=${TEXERA2_PUBLIC_URL:-http://localhost:28088}
mkdir -p "$LOGS/tests" "$REPORTS"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
export PATH="$HOME/.local/go/bin:$HOME/go/bin:$HOME/.local/bin:$PATH"
cd "$ROOT"

RESULTS=()
FAILED=0
step() {
  local name=$1; shift
  local log="$LOGS/tests/$(echo "$name" | tr -c 'a-zA-Z0-9\n' '-').log"
  printf '%-52s' "$name"
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
skip() { printf '%-52s%s\n' "$1" "skipped: $2"; RESULTS+=("skip  $1"); }
stack_up() { http_ok "http://localhost:8090/healthz" && http_ok "http://localhost:28085/api/health"; }
has_model_key() { [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "$(env_file_value ANTHROPIC_API_KEY)" ]; }
pytest_e2e() { "$PY" -m pytest tests/e2e "$@"; }

unit() {
  echo "== unit (no stack)"
  step "catalog (go vet, go test)" bash -c "cd catalog && go vet ./... && TEXERA_TEST_REQUIRE_DB=1 go test -count=1 -p 1 ./..."
  step "agent runtime (types, lint, bun test)" bash -c "cd agent-runtime && bun run typecheck && bun run lint && bun test"
  step "live service (types, lint, bun test)" bash -c "cd live && bun run typecheck && bun run lint && bun test"
  step "frontend (types, lint, vitest)" bash -c "cd frontend-next && bun run typecheck && bun run lint && bun run test"
  # Every sbt module as CI runs them: results on the stack's Postgres-backed Iceberg catalog,
  # Python workers on the uv environment, integration-tagged suites left to `contract`.
  step "engine and libraries (sbt test)" bash -c "UDF_PYTHON_PATH='$ROOT/.venv/bin/python' AMBER_TEST_FILTER=skip-integration \
    STORAGE_ICEBERG_CATALOG_TYPE=postgres \
    STORAGE_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME=localhost:15432/texera_iceberg_catalog \
    STORAGE_ICEBERG_CATALOG_POSTGRES_USERNAME=texera STORAGE_ICEBERG_CATALOG_POSTGRES_PASSWORD=texera \
    sbt -batch test"
}

contract() {
  echo "== contract (the stack's peers)"
  step "catalog adapters (OpenBao, RustFS, OpenFGA)" bash -c "cd catalog && go test -count=1 -tags integration ./internal/adapters/..."
  # The engine's integration-tagged suites on the dev stack's Lakekeeper and RustFS. They make
  # namespaces of their own, which only the lake's operator may, so they run as the catalog's client.
  step "engine integration suites (REST catalog)" bash -c "UDF_PYTHON_PATH='$ROOT/.venv/bin/python' AMBER_TEST_FILTER=integration-only \
    STORAGE_ICEBERG_CATALOG_TYPE=rest \
    STORAGE_ICEBERG_CATALOG_REST_URI=http://localhost:18181/catalog \
    STORAGE_ICEBERG_CATALOG_REST_CLIENT_ID=texera-services STORAGE_ICEBERG_CATALOG_REST_CLIENT_SECRET=texera-services-secret \
    STORAGE_ICEBERG_CATALOG_REST_TOKEN_URL=http://localhost:18081/auth/realms/texera/protocol/openid-connect/token \
    STORAGE_ICEBERG_CATALOG_REST_WAREHOUSE_NAME=texera STORAGE_S3_ENDPOINT=http://localhost:19001 \
    STORAGE_S3_REGION=us-east-1 STORAGE_S3_AUTH_USERNAME=texera STORAGE_S3_AUTH_PASSWORD=texera-secret \
    sbt -batch WorkflowOperator/test WorkflowExecutionService/test"
}

scenario() {
  echo "== scenario (pytest against $GW_LOCAL)"
  step "scenarios" pytest_e2e --gw "$GW_LOCAL" -m "not model and not cluster and not local and not destructive" --junitxml="$REPORTS/scenario.xml" "$@"
  step "scenarios: the lake, the unit restart, expiry (local, last)" pytest_e2e --gw "$GW_LOCAL" --local --destructive -m "(local or destructive) and not model and not cluster" --junitxml="$REPORTS/scenario-local.xml" "$@"
}

ui() {
  echo "== ui (Playwright against $GW_LOCAL, no model)"
  step "frontend e2e (Playwright, no model)" bash -c "cd frontend-next && TEXERA_E2E_SKIP_MODEL=1 PLAYWRIGHT_JUNIT_OUTPUT_FILE='$REPORTS/ui.xml' bunx playwright test"
}

evals() {
  echo "== evals (real agents, real model, against $GW_LOCAL)"
  if ! has_model_key; then skip "real-agent scenarios" "no ANTHROPIC_API_KEY"; return; fi
  if [ -z "$(listener 23002)" ]; then skip "real-agent scenarios" "agent runtime not running"; return; fi
  step "real-agent scenarios (pytest -m model)" pytest_e2e --gw "$GW_LOCAL" --model -m model --junitxml="$REPORTS/evals.xml" "$@"
  step "frontend e2e with the model (Playwright)" bash -c "cd frontend-next && PLAYWRIGHT_JUNIT_OUTPUT_FILE='$REPORTS/ui-model.xml' bunx playwright test"
}

cluster() {
  echo "== cluster (against $GW_CLUSTER)"
  if ! http_ok "$GW_CLUSTER/catalog/v1/settings/public"; then
    echo "the cluster does not answer on $GW_CLUSTER; run bin/texera-2-0/k8s.sh up first" >&2
    FAILED=1
    return
  fi
  step "scenarios on the cluster" pytest_e2e --gw "$GW_CLUSTER" --cluster -m "not model and not local and not destructive" --junitxml="$REPORTS/cluster.xml" "$@"
  step "frontend e2e on the cluster (Playwright, no model)" bash -c "cd frontend-next && TEXERA_BASE_URL='$GW_CLUSTER' TEXERA_E2E_SKIP_MODEL=1 PLAYWRIGHT_JUNIT_OUTPUT_FILE='$REPORTS/cluster-ui.xml' bunx playwright test"
}

need_stack() {
  if ! stack_up; then
    echo "the stack is not up; run bin/texera-2-0/up.sh first" >&2
    exit 1
  fi
}

what=${1:-all}
shift || true
case "$what" in
  unit) unit ;;
  contract) need_stack; contract ;;
  scenario) need_stack; scenario "$@" ;;
  ui) need_stack; ui ;;
  evals) need_stack; evals "$@" ;;
  cluster) cluster "$@" ;;
  all) need_stack; unit; contract; scenario; ui; evals ;;
  gate)
    echo "== gate: a wiped stack, then everything"
    "$HERE/down.sh" --wipe && "$HERE/up.sh" || { echo "the stack did not come up" >&2; exit 1; }
    unit; contract; scenario; ui; evals
    ;;
  *) echo "usage: $0 unit | contract | scenario [pytest args] | ui | evals [pytest args] | cluster [pytest args] | all | gate" >&2; exit 2 ;;
esac

echo "== summary"
printf '%s\n' "${RESULTS[@]}"
exit $FAILED
