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

# Smoke test of a run through the unit: a dataset version, a workflow that scans it and
# aggregates, validation, an execution with its ports and rows, the lineage, and the saved
# result as a dataset version derived from the port. Needs the stack (bin/texera-2-0/up.sh).
set -euo pipefail
STAMP=$(date +%H%M%S)
HERE=$(cd "$(dirname "$0")" && pwd)
GW=${GW:-http://localhost:8088}
API=$GW/catalog/v1

token() {
  curl -sf -d "grant_type=password&client_id=texera-app&username=$1&password=$2" "$GW/auth/realms/texera/protocol/openid-connect/token" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}
j() { python3 -c 'import json,sys; d=json.load(sys.stdin); print('"$1"')'; }
fail() { echo "FAIL: $*" >&2; exit 1; }

TOK=$(token alice alice)
H=(-H "Authorization: Bearer $TOK" -H "Content-Type: application/json")

echo "== dataset iris v1"
DS=$(curl -sf "${H[@]}" -X POST "$API/datasets" -d '{"name": "iris", "description": "Fisher iris", "spec": {"format": "csv"}}' 2>/dev/null \
  || curl -sf "${H[@]}" "$API/datasets?q=iris" | j '[i for i in d["items"] if i["metadata"]["name"] == "iris"][0]' | python3 -c 'import sys,ast,json; print(json.dumps(ast.literal_eval(sys.stdin.read())))')
DSRID=$(echo "$DS" | j 'd["metadata"]["rid"]')
DSURI=$(echo "$DS" | j 'd["metadata"]["uri"]')
curl -sf -H "Authorization: Bearer $TOK" -H "Content-Type: text/csv" -X PUT --data-binary @"$HERE/examples/iris.csv" "$API/datasets/$DSRID/files/iris.csv" | j 'd["path"], d["size"]'
DSV=$(curl -sf "${H[@]}" -X POST "$API/datasets/$DSRID/commit" -d '{"message": "upload"}' | j 'd["vno"]')
echo "dataset $DSURI@$DSV"

echo "== workflow: scan -> aggregate"
SPEC=$(cat <<EOF
{"operators": [
  {"operatorID": "scan", "operatorType": "CSVFileScan",
   "operatorProperties": {"fileName": "$DSURI@$DSV/files/iris.csv", "fileEncoding": "UTF_8", "hasHeader": true, "customDelimiter": ","},
   "outputPorts": [{"portID": "output-0"}]},
  {"operatorID": "avg", "operatorType": "Aggregate",
   "operatorProperties": {"groupByKeys": ["Species"], "aggregations": [{"aggFunction": "average", "attribute": "PetalLengthCm", "result attribute": "avg_petal_length"}]},
   "inputPorts": [{"portID": "input-0"}], "outputPorts": [{"portID": "output-0"}], "viewResult": true}
 ],
 "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "avg", "portID": "input-0"}}]}
EOF
)
WF=$(curl -sf "${H[@]}" -X POST "$API/workflows" -d "{\"name\": \"iris petal length by species $(date +%H%M%S)\", \"spec\": $SPEC}")
RID=$(echo "$WF" | j 'd["metadata"]["rid"]')
echo "workflow $(echo "$WF" | j 'd["metadata"]["uri"]')@$(echo "$WF" | j 'd["metadata"]["head"]')"

echo "== validate on the unit"
VAL=$(curl -sf "${H[@]}" -X POST "$API/workflows/$RID/validate" -d '{}')
echo "$VAL" | j '"ok", d["ok"], "errors", d["operatorErrors"]'
echo "$VAL" | j '[(op, port, [a["attributeName"] for a in (attrs or [])]) for op, ports in d["operatorOutputSchemas"].items() for port, attrs in ports.items()]'
[ "$(echo "$VAL" | j 'd["ok"]')" = "True" ] || fail "validation"

echo "== run with wait"
EX=$(curl -sf "${H[@]}" -X POST "$API/workflows/$RID/run" -d '{"waitSeconds": 180, "name": "smoke run '"$STAMP"'"}')
EID=$(echo "$EX" | j 'd["metadata"]["rid"]')
echo "$EX" | j '"execution", d["metadata"]["uri"], d["status"]["phase"], "spec", d["spec"]'
echo "$EX" | j '"operators", d["status"].get("operators")'
echo "$EX" | j '"ports", [(p["operatorID"], p["portID"], p.get("rows")) for p in d["status"].get("ports", [])]'
[ "$(echo "$EX" | j 'd["status"]["phase"]')" = "completed" ] || fail "execution phase $(echo "$EX" | j 'd["status"]["phase"], str(d["status"].get("error"))[:600]')"
EXP=$API/workflows/$RID/executions/$EID

echo "== the port and its rows"
curl -sf "${H[@]}" "$EXP/operators/avg/ports/output-0" | j 'd["direction"], d["result"]["rows"], d["result"]["table"]'
curl -sf "${H[@]}" "$EXP/operators/avg/ports/input-0" | j 'd["direction"], d["boundTo"][-30:]'
curl -sf "${H[@]}" "$EXP/operators/avg/ports/output-0/rows?limit=10" | j '[a["attributeName"] for a in d["schema"]], d["rows"], d.get("total")'

echo "== lineage of the execution: what it used and produced"
curl -sf "${H[@]}" "$API/resources/$EID/lineage?direction=upstream" | j '[(e["relation"], e["to"][-30:]) for e in d["edges"]]'
curl -sf "${H[@]}" "$API/resources/$DSRID/lineage?direction=downstream" | j '[(e["relation"], e["from"][-40:]) for e in d["edges"]]'
curl -sf "${H[@]}" "$API/workflows/$RID/executions" | j '[(e["metadata"]["rid"][:8], e["status"]["phase"]) for e in d["items"]]'
curl -sf "${H[@]}" "$API/executions?phase=completed&limit=3" | j 'len(d["items"])'

echo "== save the result as a dataset version derived from the port"
SAVED=$(curl -sf "${H[@]}" -X POST "$EXP/operators/avg/ports/output-0/save" -d '{"name": "petal length by species '"$STAMP"'"}')
SRID=$(echo "$SAVED" | j 'd["rid"]')
echo "$SAVED" | j '"dataset", d["uri"], d.get("message")'
curl -sf -H "Authorization: Bearer $TOK" "$API/datasets/$SRID/versions/1/files/avg.csv"
LIN=$(curl -sf "${H[@]}" "$API/resources/$SRID/lineage?vno=1&direction=upstream")
echo "$LIN" | j '[(e["relation"], e["from"][-30:], e["to"][-30:]) for e in d["edges"]]'
echo "$LIN" | j 'sorted(set(e["relation"] for e in d["edges"])) == ["derivedFrom", "produced", "used"]' | grep -q True || fail "the saved version's lineage should reach the port, its execution and the file it read"

echo "== done: dataset $DSRID workflow $RID execution $EID saved $SRID"
