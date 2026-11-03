#!/bin/sh
# Creates Lakekeeper's default project and the `texera` warehouse on RustFS, or refreshes the
# warehouse's S3 endpoint when it exists. S3_ENDPOINT must be reachable from Lakekeeper and from
# the engine (see the lakekeeper-s3 sidecar in docker-compose.yml).
set -e
apk add --no-cache curl jq >/dev/null
BASE=http://lakekeeper:8181
ENDPOINT=${S3_ENDPOINT:-http://127.0.0.1:19001}
CREDENTIAL='{"type":"s3","credential-type":"access-key","aws-access-key-id":"texera","aws-secret-access-key":"texera-secret"}'

code=$(curl -s -o /tmp/p.txt -w "%{http_code}" "$BASE/management/v1/project" || echo 000)
if [ "$code" = "404" ]; then
  curl -sf -X POST -H "Content-Type: application/json" \
    -d '{"project-id":"00000000-0000-0000-0000-000000000000","project-name":"default"}' \
    "$BASE/management/v1/project" >/dev/null
  echo "created default project"
fi

curl -sf "$BASE/management/v1/warehouse" > /tmp/warehouses.json
id=$(jq -r '.warehouses[]? | select(.name == "texera") | .id' /tmp/warehouses.json)
if [ -n "$id" ]; then
  profile=$(jq -c --arg e "$ENDPOINT" '.warehouses[] | select(.name == "texera") | ."storage-profile" | .endpoint = $e' /tmp/warehouses.json)
  curl -sf -X POST -H "Content-Type: application/json" \
    -d "{\"storage-profile\": $profile, \"storage-credential\": $CREDENTIAL}" \
    "$BASE/management/v1/warehouse/$id/storage" >/dev/null
  echo "warehouse texera endpoint set to $ENDPOINT"
  exit 0
fi
curl -sf -X POST -H "Content-Type: application/json" "$BASE/management/v1/warehouse" -d "{
  \"warehouse-name\": \"texera\",
  \"project-id\": \"00000000-0000-0000-0000-000000000000\",
  \"storage-profile\": {
    \"type\": \"s3\", \"bucket\": \"texera\", \"key-prefix\": \"warehouse\", \"region\": \"us-east-1\",
    \"endpoint\": \"$ENDPOINT\", \"path-style-access\": true, \"flavor\": \"s3-compat\", \"sts-enabled\": false
  },
  \"storage-credential\": $CREDENTIAL
}" >/dev/null
echo "created warehouse texera at $ENDPOINT"
