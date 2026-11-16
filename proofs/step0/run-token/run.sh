#!/usr/bin/env bash
# Step 0 proof "run-token": a token made for one run reaches only that run's
# namespace in the lake, and stops working once its access is removed.
#
# Brings up Lakekeeper (OpenFGA authz) + Postgres + OpenFGA + RustFS (STS) + a
# Python OIDC issuer standing in for the Dashboard service, runs the checks
# (one PASS/FAIL line each), and tears everything down again.
#
# Usage: ./run.sh
#   SCE0TOK_KEEP=1             leave the stack running afterwards (debugging)
#   SCE0TOK_WAIT_STS_EXPIRY=1  also wait (~15 min) for pre-revocation STS credentials to expire
#   SCE0TOK_STS_VALIDITY=900   sts-token-validity-seconds of the main warehouse
#   SCE0TOK_FGA_DATASTORE=memory  OpenFGA in memory instead of Postgres (variant run)
#   SCE0TOK_FGA_CHECK_CACHE=true  turn on OpenFGA's check cache (variant run; delays revocation)
#   SCE0TOK_FGA_CACHE_CONTROLLER=true  OpenFGA's cache controller (variant run, with the check cache)
#
# Containers, network and image are named sce0tok-*; host ports 127.0.0.1:19500-19505.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
PROJECT=sce0tok
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
VARIANT="default"
[ "${SCE0TOK_FGA_DATASTORE:-postgres}" = "memory" ] && VARIANT="fga-memory"
[ "${SCE0TOK_FGA_CHECK_CACHE:-false}" = "true" ] && VARIANT="fga-check-cache"
[ "${SCE0TOK_FGA_CHECK_CACHE:-false}" = "true" ] && [ "${SCE0TOK_FGA_CACHE_CONTROLLER:-false}" = "true" ] \
  && VARIANT="fga-check-cache-controller"
[ "${SCE0TOK_WAIT_STS_EXPIRY:-0}" = "1" ] && VARIANT="$VARIANT-long"
mkdir -p results
LOG="results/$STAMP-$VARIANT.log"
[ "${1:-}" = "--down" ] && LOG=/dev/null   # a bare teardown leaves no log behind
export SCE0TOK_REPORT="results/$STAMP-$VARIANT.json"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"; }

compose() {
  docker compose -p "$PROJECT" -f "$HERE/compose.yaml" --env-file "$HERE/state/secrets.env" "$@"
}

remove_by_name() {
  local ids
  ids="$(docker ps -aq --filter name=^sce0tok)"
  if [ -n "$ids" ]; then docker rm -f $ids >/dev/null 2>&1 || true; fi
  ids="$(docker network ls -q --filter name=^sce0tok)"
  if [ -n "$ids" ]; then docker network rm $ids >/dev/null 2>&1 || true; fi
  ids="$(docker volume ls -q --filter name=^sce0tok)"
  if [ -n "$ids" ]; then docker volume rm $ids >/dev/null 2>&1 || true; fi
  docker image rm sce0tok-issuer:step0 >/dev/null 2>&1 || true
}

teardown() {
  if [ "${SCE0TOK_KEEP:-0}" = "1" ]; then
    log "SCE0TOK_KEEP=1: leaving the stack up (remove it with: SCE0TOK_KEEP=0 ./run.sh --down)"
    return
  fi
  log "tearing down"
  if [ -f state/secrets.env ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  remove_by_name
  rm -rf state
  local c n v
  c="$(docker ps -aq --filter name=^sce0tok | wc -l | tr -d ' ')"
  n="$(docker network ls -q --filter name=^sce0tok | wc -l | tr -d ' ')"
  v="$(docker volume ls -q --filter name=^sce0tok | wc -l | tr -d ' ')"
  log "teardown done: $c containers, $n networks, $v volumes named sce0tok* left"
}

if [ "${1:-}" = "--down" ]; then
  SCE0TOK_KEEP=0 teardown
  exit 0
fi

# ---------------------------------------------------------------- preflight
log "run-token proof, log $LOG"
docker info >/dev/null 2>&1 || { log "FAIL docker is not reachable"; exit 2; }
if [ -n "$(docker ps -aq --filter name=^sce0tok)" ]; then
  log "leftover sce0tok containers found; removing them first"
  remove_by_name
fi
for p in 19500 19501 19502 19504 19505; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then log "FAIL port $p is in use"; exit 2; fi
done

# ---------------------------------------------------------------- python env (uv)
if [ ! -x .venv/bin/python ]; then
  uv venv -q --python 3.12 .venv
fi
uv pip install -q --python .venv/bin/python -r requirements.txt

# ---------------------------------------------------------------- per-run secrets (never printed)
rm -rf state
mkdir -p state
chmod 700 state
(
  umask 077
  .venv/bin/python -I -c '
import secrets
print("SCE0TOK_PG_PASSWORD=" + secrets.token_hex(16))
print("SCE0TOK_LK_ENCRYPTION_KEY=" + secrets.token_hex(24))
print("SCE0TOK_S3_ROOT_USER=sce0tokroot")
print("SCE0TOK_S3_ROOT_PASSWORD=" + secrets.token_hex(16))
print("SCE0TOK_S3_LK_USER=lakekeeper")
print("SCE0TOK_S3_LK_PASSWORD=" + secrets.token_hex(16))
' > state/secrets.env
)
trap teardown EXIT

# ---------------------------------------------------------------- versions
{
  echo "versions:"
  echo "  docker $(docker version --format '{{.Server.Version}}') ($(docker info --format '{{.OperatingSystem}}')), $(docker compose version --short 2>/dev/null | sed 's/^/compose /')"
  for img in vakamo/lakekeeper:v0.11.0 openfga/openfga:v1.11.2 rustfs/rustfs:1.0.0 rustfs/rc:v0.1.35 postgres:15 python:3.12.14-slim-bookworm; do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img" >/dev/null
    echo "  $img $(docker image inspect "$img" --format '{{index .RepoDigests 0}}' 2>/dev/null | sed 's/.*@//' | cut -c1-19)"
  done
  echo "  runner: $(.venv/bin/python -I -c 'import sys, pyiceberg, pyarrow, boto3; print("python %s, pyiceberg %s, pyarrow %s, boto3 %s" % (sys.version.split()[0], pyiceberg.__version__, pyarrow.__version__, boto3.__version__))')"
} | tee -a "$LOG"

# ---------------------------------------------------------------- up
log "starting the stack"
t0=$(date +%s)
if ! compose up -d --build --wait --wait-timeout 300 >>"$LOG" 2>&1; then
  log "FAIL the stack did not become healthy"
  compose ps -a | tee -a "$LOG"
  exit 1
fi
log "stack healthy after $(( $(date +%s) - t0 ))s; RustFS init: $(docker logs sce0tok-rustfs-init 2>&1 | tail -1)"

# ---------------------------------------------------------------- checks
set +e
.venv/bin/python -I runner/run_checks.py 2>&1 | tee -a "$LOG"
rc=${PIPESTATUS[0]}
set -e
log "checks finished with exit code $rc"
exit "$rc"
