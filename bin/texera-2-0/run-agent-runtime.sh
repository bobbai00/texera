#!/usr/bin/env bash
# Runs the agent runtime on the host at :23002 against the dev stack. The model key comes from the
# environment, or from the file named by TEXERA_ENV_FILE (a KEY=VALUE file kept outside the repo).
set -euo pipefail
cd "$(dirname "$0")/../../agent-runtime"
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -n "${TEXERA_ENV_FILE:-}" ] && [ -f "$TEXERA_ENV_FILE" ]; then
  ANTHROPIC_API_KEY=$(grep -E '^ANTHROPIC_API_KEY=' "$TEXERA_ENV_FILE" | head -1 | cut -d= -f2-)
  export ANTHROPIC_API_KEY
fi
[ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "ANTHROPIC_API_KEY is not set (or set TEXERA_ENV_FILE)"; exit 1; }
export TEXERA_AGENT_PORT=${TEXERA_AGENT_PORT:-23002}
export TEXERA_PUBLIC_URL=${TEXERA_PUBLIC_URL:-http://localhost:8088}
export TEXERA_CATALOG_URL=${TEXERA_CATALOG_URL:-http://localhost:8088}
export TEXERA_OIDC_JWKS_URL=${TEXERA_OIDC_JWKS_URL:-http://localhost:18081/auth/realms/texera/protocol/openid-connect/certs}
export TEXERA_OIDC_TOKEN_URL=${TEXERA_OIDC_TOKEN_URL:-http://localhost:18081/auth/realms/texera/protocol/openid-connect/token}
exec bun src/main.ts
