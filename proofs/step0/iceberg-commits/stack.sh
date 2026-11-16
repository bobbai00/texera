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

# The lake for this proof: Lakekeeper v0.11.0 + Postgres 15 + RustFS 1.0.0, set up the
# way bin/single-node/docker-compose.yml sets them up (default project, an s3-compat
# warehouse with sts disabled, so clients use remote signing).
#
# Usage: stack.sh up | down | env | objects <s3-location> | info
#
# One network namespace for all three containers. RustFS owns it and listens on
# the same port inside as outside (19541), so the warehouse's single S3 endpoint
# (http://127.0.0.1:19541) works both for Lakekeeper, which writes metadata.json
# itself, and for the JVM on the host, which writes data files through remote
# signing. Everything is published on 127.0.0.1 only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX=sce0ice
NET="${PREFIX}-net"
RUSTFS="${PREFIX}-rustfs"
PG="${PREFIX}-postgres"
LK="${PREFIX}-lakekeeper"
LK_PORT=19540 # Lakekeeper REST + management API
S3_PORT=19541 # RustFS S3 API (same port inside the shared namespace)
REGION=us-west-2
WAREHOUSE=texera
BUCKET=texera-iceberg
KEY_PREFIX=shared
STATE="${HERE}/.state" # per-run secrets (0600), removed by `down`
# Stdlib-only Python from the folder's uv venv (run.sh creates it), else the system one.
PY="${HERE}/.venv/bin/python"
[[ -x "$PY" ]] || PY=python3

RUSTFS_IMAGE=rustfs/rustfs:1.0.0
RC_IMAGE=rustfs/rc:v0.1.35
PG_IMAGE=postgres:15
LK_IMAGE=vakamo/lakekeeper:v0.11.0

log() { echo "[stack] $*" >&2; }

secrets() {
  # Generated once per `up`; never printed.
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  if [[ ! -f "$STATE/secrets.env" ]]; then
    umask 077
    {
      echo "S3_ACCESS_KEY=sce0ice$(openssl rand -hex 6)"
      echo "S3_SECRET_KEY=$(openssl rand -hex 20)"
      echo "PG_PASSWORD=$(openssl rand -hex 16)"
      echo "LK_ENCRYPTION_KEY=$(openssl rand -hex 24)"
    } >"$STATE/secrets.env"
  fi
  # shellcheck disable=SC1091
  source "$STATE/secrets.env"
}

wait_for() { # name, command...
  local name="$1"
  shift
  for _ in $(seq 1 90); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  log "timed out waiting for $name"
  return 1
}

up() {
  secrets
  docker network create "$NET" >/dev/null
  docker volume create "${PREFIX}-rustfs-data" >/dev/null
  docker volume create "${PREFIX}-pg-data" >/dev/null

  umask 077
  cat >"$STATE/rustfs.env" <<EOF
RUSTFS_ADDRESS=0.0.0.0:${S3_PORT}
RUSTFS_ACCESS_KEY=${S3_ACCESS_KEY}
RUSTFS_SECRET_KEY=${S3_SECRET_KEY}
RUSTFS_REGION=${REGION}
RUSTFS_CONSOLE_ENABLE=false
RUSTFS_OBS_LOG_DIRECTORY=
RUSTFS_OBS_LOGGER_LEVEL=warn
EOF
  log "starting RustFS (owns the shared network namespace)"
  docker run -d --name "$RUSTFS" --network "$NET" \
    -p "127.0.0.1:${LK_PORT}:8181" -p "127.0.0.1:${S3_PORT}:${S3_PORT}" \
    --env-file "$STATE/rustfs.env" \
    -v "${PREFIX}-rustfs-data:/data" \
    "$RUSTFS_IMAGE" >/dev/null

  cat >"$STATE/pg.env" <<EOF
POSTGRES_PASSWORD=${PG_PASSWORD}
EOF
  log "starting Postgres for Lakekeeper"
  docker run -d --name "$PG" --network "container:${RUSTFS}" \
    --env-file "$STATE/pg.env" \
    -v "${PREFIX}-pg-data:/var/lib/postgresql/data" \
    "$PG_IMAGE" >/dev/null
  wait_for postgres docker exec "$PG" pg_isready -h 127.0.0.1 -U postgres
  wait_for rustfs curl -sf "http://127.0.0.1:${S3_PORT}/health"

  cat >"$STATE/lakekeeper.env" <<EOF
LAKEKEEPER__PG_DATABASE_URL_READ=postgres://postgres:${PG_PASSWORD}@127.0.0.1:5432/postgres
LAKEKEEPER__PG_DATABASE_URL_WRITE=postgres://postgres:${PG_PASSWORD}@127.0.0.1:5432/postgres
LAKEKEEPER__PG_ENCRYPTION_KEY=${LK_ENCRYPTION_KEY}
LAKEKEEPER__BASE_URI=http://127.0.0.1:${LK_PORT}
EOF
  log "migrating Lakekeeper's database"
  docker run --rm --name "${PREFIX}-lakekeeper-migrate" --network "container:${RUSTFS}" \
    --env-file "$STATE/lakekeeper.env" "$LK_IMAGE" migrate >/dev/null
  log "starting Lakekeeper"
  docker run -d --name "$LK" --network "container:${RUSTFS}" \
    --env-file "$STATE/lakekeeper.env" "$LK_IMAGE" serve >/dev/null
  wait_for lakekeeper curl -sf "http://127.0.0.1:${LK_PORT}/health"

  log "creating bucket ${BUCKET}"
  cat >"$STATE/rc.env" <<EOF
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}
EOF
  docker run --rm --name "${PREFIX}-rc" --network "container:${RUSTFS}" \
    --env-file "$STATE/rc.env" --entrypoint /bin/sh "$RC_IMAGE" -c \
    "rc alias set local http://127.0.0.1:${S3_PORT} \"\$S3_ACCESS_KEY\" \"\$S3_SECRET_KEY\" --region ${REGION} --bucket-lookup path >/dev/null && rc bucket create --ignore-existing local/${BUCKET} >/dev/null"

  # Same two calls as the lakekeeper-init job in bin/single-node/docker-compose.yml.
  log "creating Lakekeeper's default project and warehouse '${WAREHOUSE}'"
  local code
  code=$(curl -s -o "$STATE/resp.txt" -w "%{http_code}" -X POST -H "Content-Type: application/json" \
    -d '{"project-id": "00000000-0000-0000-0000-000000000000", "project-name": "default"}' \
    "http://127.0.0.1:${LK_PORT}/management/v1/project")
  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    log "project creation failed: HTTP $code"
    return 1
  fi
  cat >"$STATE/warehouse.json" <<EOF
{
  "warehouse-name": "${WAREHOUSE}",
  "project-id": "00000000-0000-0000-0000-000000000000",
  "storage-profile": {
    "type": "s3",
    "bucket": "${BUCKET}",
    "key-prefix": "${KEY_PREFIX}",
    "region": "${REGION}",
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
  code=$(curl -s -o "$STATE/resp.txt" -w "%{http_code}" -X POST -H "Content-Type: application/json" \
    -d @"$STATE/warehouse.json" "http://127.0.0.1:${LK_PORT}/management/v1/warehouse")
  rm -f "$STATE/warehouse.json"
  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    log "warehouse creation failed: HTTP $code"
    return 1
  fi
  log "lake is up: catalog http://127.0.0.1:${LK_PORT}/catalog, S3 http://127.0.0.1:${S3_PORT}"
}

down() {
  for c in "${PREFIX}-rc" "${PREFIX}-lakekeeper-migrate" "$LK" "$PG" "$RUSTFS"; do
    docker rm -f -v "$c" >/dev/null 2>&1 || true
  done
  docker volume rm "${PREFIX}-rustfs-data" "${PREFIX}-pg-data" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$STATE"
}

# Environment for the benchmark JVM: Texera's own storage.conf overrides. The JVM
# gets no S3 keys; it reaches the store only through Lakekeeper's remote signing.
env_for_jvm() {
  cat <<EOF
export STORAGE_ICEBERG_CATALOG_TYPE=rest
export STORAGE_ICEBERG_CATALOG_REST_URI=http://127.0.0.1:${LK_PORT}/catalog
export STORAGE_ICEBERG_CATALOG_REST_WAREHOUSE_NAME=${WAREHOUSE}
export STORAGE_ICEBERG_CATALOG_REST_S3_BUCKET=${BUCKET}
export LAKEKEEPER_MANAGEMENT_URI=http://127.0.0.1:${LK_PORT}/management
EOF
}

# Count what a table left in the store, by kind, with the store's root key (inside
# the container; the key is never printed). Prints one CSV row:
# objects,bytes,data_files,data_bytes,manifests,manifest_lists,metadata_files,metadata_bytes
objects() {
  secrets
  local loc="$1" path
  path="local/${loc#s3://}"
  docker run --rm --name "${PREFIX}-rc" --network "container:${RUSTFS}" \
    --env-file "$STATE/rc.env" --entrypoint /bin/sh "$RC_IMAGE" -c \
    "rc alias set local http://127.0.0.1:${S3_PORT} \"\$S3_ACCESS_KEY\" \"\$S3_SECRET_KEY\" --region ${REGION} --bucket-lookup path >/dev/null && rc object list --recursive --json '${path%/}/'" |
    "$PY" -I -c '
import json, sys
doc = json.load(sys.stdin)
items = [i for i in doc.get("items", []) if not i.get("is_dir")]
c = dict(objects=0, bytes=0, data=0, data_bytes=0, manifests=0, lists=0, meta=0, meta_bytes=0)
for it in items:
    key, size = it["key"], int(it.get("size_bytes", 0))
    name = key.rsplit("/", 1)[-1]
    c["objects"] += 1
    c["bytes"] += size
    if "/metadata/" not in key:
        c["data"] += 1
        c["data_bytes"] += size
    elif name.endswith(".metadata.json"):
        c["meta"] += 1
        c["meta_bytes"] += size
    elif name.startswith("snap-"):
        c["lists"] += 1
    else:
        c["manifests"] += 1
print(",".join(str(c[k]) for k in ("objects", "bytes", "data", "data_bytes", "manifests", "lists", "meta", "meta_bytes")))
'
}

info() {
  curl -s "http://127.0.0.1:${LK_PORT}/management/v1/info" || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  env) env_for_jvm ;;
  objects) objects "$2" ;;
  info) info ;;
  *)
    echo "usage: $0 up|down|env|objects <s3-location>|info" >&2
    exit 2
    ;;
esac
