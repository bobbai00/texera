#!/usr/bin/env bash
# Runs the computing unit (Amber, ComputingUnitMaster) on the host at :28085 against the dev stack.
# The unit opens no database: it verifies Keycloak tokens, writes results to Lakekeeper/RustFS and
# reports to the catalog through OpenLineage events.
set -euo pipefail
cd "$(dirname "$0")/../.."
# The uv-managed environment at the repo root (`uv sync --all-extras`, see pyproject.toml).
: "${UDF_PYTHON_PATH:=$(pwd)/.venv/bin/python}"
export UDF_PYTHON_PATH
export STORAGE_ICEBERG_CATALOG_TYPE=rest
export STORAGE_ICEBERG_CATALOG_REST_URI=${STORAGE_ICEBERG_CATALOG_REST_URI:-http://localhost:18181/catalog}
export STORAGE_ICEBERG_CATALOG_REST_WAREHOUSE_NAME=texera
export STORAGE_S3_ENDPOINT=${STORAGE_S3_ENDPOINT:-http://localhost:19001}
export STORAGE_S3_REGION=us-east-1
export STORAGE_S3_AUTH_USERNAME=texera
export STORAGE_S3_AUTH_PASSWORD=texera-secret
export TEXERA_OIDC_ISSUER=${TEXERA_OIDC_ISSUER:-http://localhost:8088/auth/realms/texera}
export TEXERA_OIDC_JWKS_URL=${TEXERA_OIDC_JWKS_URL:-http://localhost:18081/auth/realms/texera/protocol/openid-connect/certs}
export TEXERA_UNIT_PORT=${TEXERA_UNIT_PORT:-28085}
export TEXERA_ACTOR_PORT=${TEXERA_ACTOR_PORT:-2652}
export TEXERA_ENV_ROOT=${TEXERA_ENV_ROOT:-$(pwd)/amber/.environments}
exec sbt -batch \
  'set WorkflowExecutionService / Compile / run / fork := true' \
  'set WorkflowExecutionService / Compile / run / javaOptions ++= JdkOptions.jvmFlags((ThisBuild / baseDirectory).value)' \
  "WorkflowExecutionService/runMain org.apache.texera.web.ComputingUnitMaster"
