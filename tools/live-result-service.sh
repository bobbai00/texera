#!/usr/bin/env bash
# tools/live-result-service.sh <dist-zip> <worktree> [scenario]
# On the running sce stack: runs the result service's dist in a container on the stack's network,
# with the Dashboard's database, catalog and object-store settings; runs one driver scenario
# (default a); once its execution is closed, prints the rows the Dashboard recorded for it and
# reads it through the result service (the latest finished execution, its results, a first page
# and the column statistics of each), before the stack's short retention expires the results.
# The container is removed afterwards. Source the stack's env first (SCE_BASE; the stack is the
# Compose project `sce`), and build the dist with `sbt ResultService/dist` in <worktree>.
set -euo pipefail
ZIP=$1; WT=$2; SCENARIO=${3:-a}
H=$(cd "$(dirname "$0")/.." && pwd)
SCE_BASE=${SCE_BASE:-http://localhost:8080}
PG=(docker exec sce-texera-postgres psql -U texera -d texera_db -Atc)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/rs-live.XXXXXX")
unzip -q "$ZIP" -d "$WORK"
APP=$(ls -d "$WORK"/*/ | head -1)
DASH=$(docker ps --format '{{.Names}}' | grep -E '^sce-dashboard-service$')
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$DASH" | awk '{print $1}')
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DASH" \
  | grep -E '^(STORAGE_|AUTH_|USER_SYS_|JWT_)' > "$WORK/env"
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$DASH")
docker rm -f sce-result-service-live >/dev/null 2>&1 || true
trap 'docker rm -f sce-result-service-live >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
# The Dashboard's own image has the JRE; the dist reads its config under $TEXERA_HOME.
docker run -d --name sce-result-service-live --network "$NET" --env-file "$WORK/env" \
  -e TEXERA_HOME=/texera -v "$APP:/rs:ro" \
  -v "$WT/result-service/src/main/resources:/texera/result-service/src/main/resources:ro" \
  -p 127.0.0.1:39102:9102 --entrypoint /rs/bin/result-service "$IMAGE" >/dev/null
TOKEN=$(cd "$H" && .venv/bin/python driver/e2e.py --base "$SCE_BASE" --print-token 2>/dev/null | tail -1)
get() { curl -s -w '\n%{http_code}\n' "http://127.0.0.1:39102$1" -H "Authorization: Bearer $TOKEN"; }
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:39102/api/results/executions/0 \
    -H "Authorization: Bearer $TOKEN" || true)
  [[ "$code" =~ ^(403|404|200)$ ]] && break
  sleep 1
done
echo "result service up: GET /api/results/executions/0 -> $code"
BEFORE=$("${PG[@]}" "select coalesce(max(eid), 0) from texera_db.workflow_executions")
(cd "$H" && .venv/bin/python driver/e2e.py --base "$SCE_BASE" --transport create-ws --scenario "$SCENARIO" \
  --report "$WORK/report.json" > "$WORK/driver.log" 2>&1) &
DRIVER=$!
EID=""
for _ in $(seq 1 600); do
  EID=$("${PG[@]}" "select eid from texera_db.workflow_executions where eid > $BEFORE and ended_at is not null order by eid desc limit 1")
  [ -n "$EID" ] && break
  sleep 0.5
done
[ -n "$EID" ] || { echo "no execution closed"; exit 1; }
WID=$("${PG[@]}" "select v.wid from texera_db.workflow_executions e join texera_db.workflow_version v on v.vid = e.vid where e.eid = $EID")
echo "== execution $EID of workflow $WID: $("${PG[@]}" "select outcome, ended_at, results_expired_at from texera_db.workflow_executions where eid = $EID")"
echo "== the rows the Dashboard recorded for it at create"
"${PG[@]}" "select global_port_id, output_mode, result_uri from texera_db.operator_port_executions where workflow_execution_id = $EID order by 1"
echo "== GET /api/results/workflows/$WID/latest-execution"; get "/api/results/workflows/$WID/latest-execution"
echo "== GET /api/results/executions/$EID"; RESULTS=$(get "/api/results/executions/$EID"); echo "$RESULTS"
for OP in $(echo "$RESULTS" | head -1 | python3 -c 'import json,sys; [print(r["operatorId"]) for r in json.load(sys.stdin)]'); do
  echo "== first page of $OP"; get "/api/results/executions/$EID/operators/$OP/pages?pageSize=5" | cut -c1-700
  echo "== statistics of $OP"; get "/api/results/executions/$EID/operators/$OP/statistics" | cut -c1-500
done
wait "$DRIVER" || true
echo "== driver: $(grep -E 'PASS|FAIL' "$WORK/driver.log" | tail -2 | tr '\n' ' ')"
