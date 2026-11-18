#!/usr/bin/env bash
# stack.sh -- a throwaway lake for the benchmark of an execution's record
# (record-bench.sh): Lakekeeper v0.11.0, its Postgres 15 and RustFS 1.0.0, set up the
# way the step 0 proof's stack.sh sets them up (sce-step0-proofs,
# proofs/step0/iceberg-commits): Lakekeeper's default project, and an s3-compat
# warehouse with STS off, so clients write through remote signing and hold no keys.
#
#   bench/stack.sh up      # start the lake and create the warehouse
#   bench/stack.sh down    # remove its containers, volumes, network and secrets
#   bench/stack.sh env     # the environment that points Texera's storage.conf at it
#   bench/stack.sh info    # Lakekeeper's own description of itself (JSON)
#   bench/stack.sh status  # what exists under the name sce-bench
#
# It is a Compose project of its own, `sce-bench` (docker-compose.yml beside this
# file): containers sce-bench-*, volumes sce-bench-*-data, network sce-bench-net, and
# two ports on 127.0.0.1 only: 36000 (Lakekeeper) and 36001 (RustFS). It shares
# nothing with the `sce` stack or any other. `up` refuses to start when anything is
# already named sce-bench* or a port is taken; `down` removes what carries the
# project's label, and never anything else.
#
# Secrets (the store's keys, Postgres' password, Lakekeeper's encryption key) are made
# for each `up`, kept in bench/.state/ (mode 600), never printed, and deleted by `down`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT=sce-bench
COMPOSE_FILE="$HERE/docker-compose.yml"
STATE="$HERE/.state"

# What docker-compose.yml reads, apart from the secrets.
export LAKEKEEPER_PORT=36000
export S3_PORT=36001
export S3_REGION=us-west-2
export S3_BUCKET=texera-iceberg
WAREHOUSE=texera
KEY_PREFIX=shared
LAKEKEEPER="http://127.0.0.1:${LAKEKEEPER_PORT}"

log() { echo "[bench-stack] $*" >&2; }

compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

# Everything Docker has under the project's name, ours or not: "<kind> <name>" lines.
named() {
    docker ps -a --format 'container {{.Names}}' | grep -E "^container ${PROJECT}([-_]|$)" || true
    docker volume ls --format 'volume {{.Name}}' | grep -E "^volume ${PROJECT}([-_]|$)" || true
    docker network ls --format 'network {{.Name}}' | grep -E "^network ${PROJECT}([-_]|$)" || true
}

port_taken() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

secrets() {
    mkdir -p "$STATE"
    chmod 700 "$STATE"
    if [[ ! -f "$STATE/secrets.env" ]]; then
        (
            umask 077
            {
                echo "S3_ACCESS_KEY=scebench$(openssl rand -hex 6)"
                echo "S3_SECRET_KEY=$(openssl rand -hex 20)"
                echo "PG_PASSWORD=$(openssl rand -hex 16)"
                echo "LAKEKEEPER_ENCRYPTION_KEY=$(openssl rand -hex 24)"
            } >"$STATE/secrets.env"
        )
    fi
    set -a
    # shellcheck disable=SC1091
    source "$STATE/secrets.env"
    set +a
}

wait_for() { # <what> <command...>
    local what="$1"
    shift
    for _ in $(seq 1 90); do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    log "timed out waiting for $what"
    return 1
}

# POSTs the JSON on stdin to Lakekeeper's management API; fails unless it answers 2xx.
manage() { # <path> <what>
    local code
    code=$(curl -s -o "$STATE/response.txt" -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' --data-binary @- "$LAKEKEEPER/management/v1/$1")
    if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
        log "$2 failed: HTTP $code $(head -c 400 "$STATE/response.txt" 2>/dev/null)"
        return 1
    fi
}

up() {
    local existing
    existing="$(named)"
    if [[ -n "$existing" ]]; then
        log "refusing to start: these already exist under the name $PROJECT (run '$0 down' if they are this stack's):"
        echo "$existing" >&2
        return 1
    fi
    for port in "$LAKEKEEPER_PORT" "$S3_PORT"; do
        if port_taken "$port"; then
            log "refusing to start: something listens on 127.0.0.1:$port"
            return 1
        fi
    done
    secrets

    log "starting RustFS, Postgres and Lakekeeper (project $PROJECT)"
    if ! compose up -d --quiet-pull >"$STATE/up.log" 2>&1; then
        cat "$STATE/up.log" >&2
        return 1
    fi
    wait_for "Lakekeeper" curl -sf "$LAKEKEEPER/health"
    if [[ "$(docker wait "${PROJECT}-bucket")" != 0 ]]; then
        log "the bucket could not be made: $(docker logs --tail 5 "${PROJECT}-bucket" 2>&1)"
        return 1
    fi

    # The two calls of lakekeeper-init in bin/single-node/docker-compose.yml.
    log "creating Lakekeeper's default project and the warehouse '$WAREHOUSE'"
    manage project "creating the project" <<EOF
{"project-id": "00000000-0000-0000-0000-000000000000", "project-name": "default"}
EOF
    manage warehouse "creating the warehouse" <<EOF
{
  "warehouse-name": "${WAREHOUSE}",
  "project-id": "00000000-0000-0000-0000-000000000000",
  "storage-profile": {
    "type": "s3",
    "bucket": "${S3_BUCKET}",
    "key-prefix": "${KEY_PREFIX}",
    "region": "${S3_REGION}",
    "endpoint": "http://127.0.0.1:${S3_PORT}",
    "flavor": "s3-compat",
    "path-style-access": true,
    "sts-enabled": false
  },
  "storage-credential": {
    "type": "s3",
    "credential-type": "access-key",
    "aws-access-key-id": "${S3_ACCESS_KEY}",
    "aws-secret-access-key": "${S3_SECRET_KEY}"
  }
}
EOF
    rm -f "$STATE/response.txt"
    log "the lake is up: catalog $LAKEKEEPER/catalog, S3 http://127.0.0.1:${S3_PORT}"
}

down() {
    # Compose removes what carries this project's label: containers, the volumes and the
    # network the file names. Nothing else is touched, whatever its name.
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$STATE"
    local left
    left="$(named)"
    if [[ -n "$left" ]]; then
        log "still there under the name $PROJECT, and not this stack's to remove:"
        echo "$left" >&2
        return 1
    fi
}

# The environment for a JVM that reads Texera's storage.conf. It gets no S3 keys: it
# reaches the store only through Lakekeeper's remote signing.
env_for_jvm() {
    cat <<EOF
export STORAGE_ICEBERG_CATALOG_TYPE=rest
export STORAGE_ICEBERG_CATALOG_REST_URI=${LAKEKEEPER}/catalog
export STORAGE_ICEBERG_CATALOG_REST_WAREHOUSE_NAME=${WAREHOUSE}
export STORAGE_ICEBERG_CATALOG_REST_S3_BUCKET=${S3_BUCKET}
EOF
}

case "${1:-}" in
    up) up ;;
    down) down ;;
    env) env_for_jvm ;;
    info) curl -s "$LAKEKEEPER/management/v1/info" || true ;;
    status) named ;;
    -h | --help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//' ;;
    *)
        echo "usage: $0 up|down|env|info|status" >&2
        exit 64
        ;;
esac
