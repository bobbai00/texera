#!/usr/bin/env bash
# End-to-end run through the whole stack: a dataset version, a workflow version that scans it,
# compilation on the unit, a run on the unit, results, and lineage reported back to the catalog.
# Needs the dev stack, the catalog (:8090) and the unit (run-unit.sh).
set -euo pipefail
GW=${GW:-http://localhost:8088}
HERE=$(cd "$(dirname "$0")" && pwd)

TOK=$(curl -sf -X POST "$GW/auth/realms/texera/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=texera-app -d username=alice -d password=alice \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
H=(-H "Authorization: Bearer $TOK" -H "Content-Type: application/json")
j() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
fail() { echo "FAIL: $*"; exit 1; }

echo "== unit status"
curl -sf "${H[@]}" "$GW/catalog/v1/computing-units/available" | j '[(u["metadata"]["name"], u["status"]["phase"]) for u in d]'

echo "== dataset iris v1"
DS=$(curl -sf "${H[@]}" -X POST "$GW/catalog/v1/datasets" -d '{"name": "iris", "description": "Fisher iris", "spec": {"format": "csv"}}' | j 'd["metadata"]["rid"]')
curl -sf -H "Authorization: Bearer $TOK" -H "Content-Type: application/octet-stream" -X PUT --data-binary @"$HERE/examples/iris.csv" \
  "$GW/catalog/v1/datasets/$DS/files/iris.csv" | j 'd["path"], d["size"]'
curl -sf "${H[@]}" -X POST "$GW/catalog/v1/datasets/$DS/commit" -d '{"message": "initial upload"}' | j '"version", d["vno"]'

echo "== workflow: scan -> aggregate"
CONTENT=$(cat <<EOF
{"operators": [
  {"operatorID": "scan", "operatorType": "CSVFileScan",
   "operatorProperties": {"fileName": "dataset://$DS@1/iris.csv", "fileEncoding": "UTF_8", "hasHeader": true, "customDelimiter": ","},
   "outputPorts": [{"portID": "output-0"}]},
  {"operatorID": "avg", "operatorType": "Aggregate",
   "operatorProperties": {"groupByKeys": ["Species"], "aggregations": [{"aggFunction": "average", "attribute": "PetalLengthCm", "result attribute": "avg_petal_length"}]},
   "inputPorts": [{"portID": "input-0"}], "outputPorts": [{"portID": "output-0"}], "viewResult": true}
 ],
 "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "avg", "portID": "input-0"}}]}
EOF
)
WF=$(curl -sf "${H[@]}" -X POST "$GW/catalog/v1/workflows/with-content" -d "{\"name\": \"iris petal length by species\", \"content\": $CONTENT}")
RID=$(echo "$WF" | j 'd["workflow"]["metadata"]["rid"]')
echo "workflow $RID v$(echo "$WF" | j 'd["version"]["vno"]')"

echo "== validate on the unit"
VAL=$(curl -sf "${H[@]}" -X POST "$GW/catalog/v1/workflows/$RID/validate" -d '{}')
echo "$VAL" | j '"ok", d["ok"], "errors", d["operatorErrors"]'
echo "$VAL" | j '[(op, port, [a["attributeName"] for a in (attrs or [])]) for op, ports in d["operatorOutputSchemas"].items() for port, attrs in ports.items()]'
[ "$(echo "$VAL" | j 'd["ok"]')" = "True" ] || fail "validation"

echo "== run with wait"
EX=$(curl -sf "${H[@]}" -X POST "$GW/catalog/v1/workflows/$RID/executions" -d '{"waitSeconds": 180, "name": "smoke run"}')
EID=$(echo "$EX" | j 'd["eid"]')
echo "$EX" | j '"execution", d["eid"], d["status"], "workflow", d["workflow"], "inputs", d["inputs"]'
echo "$EX" | j '"operators", d["operators"]'
echo "$EX" | j '"results", [(r["opid"], r["port"], r.get("tupleCount")) for r in d["results"]]'
[ "$(echo "$EX" | j 'd["status"]')" = "completed" ] || fail "execution status $(echo "$EX" | j 'd["status"], str(d.get("error"))[:600]')"

echo "== results of avg/output-0"
curl -sf "${H[@]}" "$GW/catalog/v1/executions/$EID/results/avg/output-0?limit=10" | j '[a["attributeName"] for a in d["schema"]], d["rows"], d.get("total")'

echo "== lineage"
curl -sf "${H[@]}" "$GW/catalog/v1/resources/$RID/lineage?vno=1" | j '[(e["kind"], e["from"], e["to"]) for e in d["upstream"]]'
curl -sf "${H[@]}" "$GW/catalog/v1/resources/$DS/lineage?vno=1" | j '[(e["kind"], e["to"]["rid"][:8], e["to"]["vno"], e.get("execution","")[:8]) for e in d["downstream"]]'
curl -sf "${H[@]}" "$GW/catalog/v1/workflows/$RID/executions" | j '[(e["eid"][:8], e["status"]) for e in d["items"]]'
echo "== save the result as a dataset version, produced by the run"
SAVED=$(curl -sf "${H[@]}" -X POST "$GW/catalog/v1/executions/$EID/results/avg/output-0/save" -d '{"name": "petal length by species"}')
SDS=$(echo "$SAVED" | j 'd["rid"]')
echo "$SAVED" | j '"dataset", d["rid"], "v", d["vno"], d.get("message")'
curl -sf -H "Authorization: Bearer $TOK" "$GW/catalog/v1/datasets/$SDS/versions/1/files/avg.csv"
LIN=$(curl -sf "${H[@]}" "$GW/catalog/v1/resources/$SDS/lineage?vno=1")
echo "$LIN" | j '[(e["kind"], e["from"]["rid"][:8], e["from"]["vno"], e.get("execution","")[:8]) for e in d["upstream"]]'
[ "$(echo "$LIN" | j "[(e['kind'], e['from']['rid'], e.get('execution')) for e in d['upstream']] == [('produced', '$RID', '$EID')]")" = "True" ] \
  || fail "the saved version's lineage should name the workflow version and the execution"

echo "== done: dataset $DS workflow $RID execution $EID saved $SDS"
