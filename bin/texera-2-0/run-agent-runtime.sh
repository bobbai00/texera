#!/usr/bin/env bash
# Runs the agent runtime on the host at :23002 against the dev stack. The model key comes from the
# environment, from the file named by TEXERA_ENV_FILE, or from the repo-root .env (gitignored);
# lines may read KEY=VALUE or `export KEY=VALUE`.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"
cd "$ROOT/agent-runtime"
# The runtime holds no model key: the platform model endpoint names a credential whose value
# up.sh loads into the secret store, and the runtime leases it per turn.
export TEXERA_AGENT_PORT=${TEXERA_AGENT_PORT:-23002}
export TEXERA_PUBLIC_URL=${TEXERA_PUBLIC_URL:-http://localhost:8088}
export TEXERA_CATALOG_URL=${TEXERA_CATALOG_URL:-http://localhost:8088}
export TEXERA_OIDC_JWKS_URL=${TEXERA_OIDC_JWKS_URL:-http://localhost:18081/auth/realms/texera/protocol/openid-connect/certs}
export TEXERA_OIDC_TOKEN_URL=${TEXERA_OIDC_TOKEN_URL:-http://localhost:18081/auth/realms/texera/protocol/openid-connect/token}
exec bun src/main.ts
