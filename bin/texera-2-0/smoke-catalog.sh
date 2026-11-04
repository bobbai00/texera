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

# Smoke test of the catalog through the gateway: the seeds, a workflow's versions and edits,
# sharing, dataset files and references, a conversation with a turn and an origin, and the
# two MCP servers. Needs the stack (bin/texera-2-0/up.sh).
set -euo pipefail
STAMP=$(date +%H%M%S)
GW=${GW:-http://localhost:8088}

token() {
  curl -sf -d "grant_type=password&client_id=texera-app&username=$1&password=$2" "$GW/auth/realms/texera/protocol/openid-connect/token" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}
service_token() {
  curl -sf -d "grant_type=client_credentials&client_id=texera-services&client_secret=texera-services-secret" "$GW/auth/realms/texera/protocol/openid-connect/token" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}
j() { python3 -c 'import json,sys; d=json.load(sys.stdin); print('"$1"')'; }
fail() { echo "FAIL: $*" >&2; exit 1; }
expect() { [ "$1" = "$2" ] || fail "$3: got $1, expected $2"; }

TOK=$(token alice alice)
auth=(-H "Authorization: Bearer $TOK" -H "Content-Type: application/json")
API=$GW/catalog/v1

echo "== whoami and the public settings"
ME=$(curl -sf "${auth[@]}" "$API/me")
echo "$ME" | j 'd["principal"]["displayName"], d["homeProject"][:8], d["systemProject"][:8], d["admin"]'
curl -sf "$API/settings/public" | j 'd["branding"]["name"], d["auth"]["clientId"]'

echo "== seeds"
curl -sf "${auth[@]}" "$API/agent-templates" | j 'sorted(i["metadata"]["name"] for i in d["items"])'
curl -sf "${auth[@]}" "$API/computing-units/available" | j '[(i["metadata"]["name"], i["status"]["phase"]) for i in d]'
curl -sf "${auth[@]}" "$API/mcp-servers" | j 'sorted((i["metadata"]["name"], i["spec"]["url"]) for i in d["items"])'
curl -sf "${auth[@]}" "$API/model-endpoints" | j '[(i["metadata"]["name"], i["spec"]["provider"], i["spec"]["model"]) for i in d["items"]]'
curl -sf "${auth[@]}" "$API/credentials" | j '[(i["metadata"]["name"], i["status"].get("hasSecret")) for i in d["items"]]'
for _ in $(seq 1 30); do
  OPS=$(curl -sf "${auth[@]}" "$API/operators?limit=5" | j 'len(d["items"])')
  [ "$OPS" -gt 0 ] && break
  sleep 3
done
echo "operators listed: $OPS (compact)"
curl -sf "${auth[@]}" "$API/operators?q=CSVFileScan" | j '[(i["spec"]["operatorType"], "propertiesSchema" in i["spec"], i["status"].get("builtin")) for i in d["items"]]'

echo "== workflow: create, edit by patch, versions, resolve"
WF=$(curl -sf "${auth[@]}" -X POST "$API/workflows" -d '{"name": "smoke '"$STAMP"'", "spec": {"operators": [{"operatorID": "a", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": "x.csv"}}], "links": []}}')
RID=$(echo "$WF" | j 'd["metadata"]["rid"]')
URI=$(echo "$WF" | j 'd["metadata"]["uri"]')
echo "rid=$RID uri=$URI head=$(echo "$WF" | j 'd["metadata"]["head"]')"
V2=$(curl -sf "${auth[@]}" -X POST "$API/workflows/$RID/edit" -d '{"patch": [{"op": "add", "path": "/operators/-", "value": {"operatorID": "b", "operatorType": "Filter", "operatorProperties": {}}},
  {"op": "add", "path": "/links/-", "value": {"linkID": "l1", "source": {"operatorID": "a", "portID": "output-0"}, "target": {"operatorID": "b", "portID": "input-0"}}}], "message": "add a filter"}')
echo "edited -> $(echo "$V2" | j 'd["uri"]') operators=$(echo "$V2" | j 'len(d["content"]["operators"])')"
curl -sf "${auth[@]}" "$API/workflows/$RID/versions" | j '[v["vno"] for v in d["items"]]'
curl -s "${auth[@]}" -X POST "$API/workflows/$RID/edit" -d '{"patch": [{"op": "replace", "path": "/operators", "value": "nope"}]}' | j 'd["code"]'
curl -sf "${auth[@]}" "$API/resources/resolve?uri=$URI@1" | j 'd["resource"]["kind"], d["version"]["vno"], len(d["version"]["content"]["operators"])'
expect "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X PUT "$API/workflows/$RID" -d '{"spec": {"operators": [], "links": []}, "expectedHead": 1}')" 409 "stale head"

echo "== sharing: bob cannot read until granted"
BOB=$(token bob bob)
expect "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BOB" "$API/workflows/$RID")" 403 "bob before the grant"
BOBPID=$(curl -sf -H "Authorization: Bearer $BOB" "$API/me" | j 'd["principal"]["pid"]')
curl -sf "${auth[@]}" -X PUT "$API/resources/$RID/grants/$BOBPID" -d '{"relation":"viewer"}' | j 'd["relation"]'
expect "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BOB" "$API/workflows/$RID")" 200 "bob after the grant"
expect "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BOB" -H "Content-Type: application/json" -X POST "$API/workflows/$RID/edit" -d '{"spec": {"operators": [], "links": []}}')" 403 "bob edits as viewer"
expect "$(curl -sf -H "Authorization: Bearer $BOB" "$API/resources?q=smoke" | j 'len(d["items"])')" 1 "bob finds it in search"
curl -sf -o /dev/null "${auth[@]}" -X DELETE "$API/resources/$RID/grants/$BOBPID"
expect "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BOB" "$API/workflows/$RID")" 403 "bob after the revoke"

echo "== dataset: upload, commit, files, download, references"
DS=$(curl -sf "${auth[@]}" -X POST "$API/datasets" -d '{"name": "iris-smoke '"$STAMP"'", "spec": {"format": "csv"}}')
DSRID=$(echo "$DS" | j 'd["metadata"]["rid"]')
DSURI=$(echo "$DS" | j 'd["metadata"]["uri"]')
printf 'sepal_length,species\n5.1,setosa\n4.9,setosa\n' | curl -sf -H "Authorization: Bearer $TOK" -H "Content-Type: text/csv" -X PUT --data-binary @- "$API/datasets/$DSRID/files/iris.csv" | j 'd["path"], d["size"], d["sha256"][:16]'
curl -sf "${auth[@]}" -X POST "$API/datasets/$DSRID/commit" -d '{"message": "first"}' | j 'd["uri"], d["contentKind"]'
curl -sf "${auth[@]}" "$API/datasets/$DSRID/versions/1/files" | j '[f["path"] for f in d["files"]]'
expect "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" "$API/datasets/$DSRID/versions/1/files/iris.csv?maxBytes=10")" 206 "a bounded read is partial"
curl -sf -H "Authorization: Bearer $TOK" "$API/datasets/$DSRID/versions/1/files/iris.csv"
curl -sf "${auth[@]}" "$API/datasets/$DSRID/versions/1/links/iris.csv" | j 'd["url"][:40], d["expiresInSeconds"]'
curl -sf -o /dev/null "${auth[@]}" -X POST "$API/workflows/$RID/edit" -d "{\"spec\": {\"operators\": [{\"operatorID\": \"a\", \"operatorType\": \"CSVFileScan\", \"operatorProperties\": {\"fileName\": \"$DSURI@1/files/iris.csv\"}}], \"links\": []}, \"message\": \"read the smoke file\"}"
curl -sf "${auth[@]}" "$API/resources/$DSRID/dependents" | j '[(e["relation"], e["from"][-3:], e["field"]) for e in d]'
expect "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X DELETE "$API/datasets/$DSRID")" 409 "a referenced dataset cannot be deleted"

echo "== conversation: default template, a turn, a message, an origin"
CONV=$(curl -sf "${auth[@]}" -X POST "$API/conversations" -d '{"name": "smoke chat '"$STAMP"'", "spec": {}}')
CRID=$(echo "$CONV" | j 'd["metadata"]["rid"]')
echo "conversation $CRID template $(echo "$CONV" | j 'd["spec"]["template"][-10:]')"
TURN=$(curl -sf "${auth[@]}" -X POST "$API/conversations/$CRID/turns" -d '{}')
TID=$(echo "$TURN" | j 'd["turn"]')
TPL=$(echo "$TURN" | j 'd["template"]')
expect "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X POST "$API/conversations/$CRID/turns" -d '{}')" 409 "a second turn"
curl -sf "${auth[@]}" -X POST "$API/conversations/$CRID/messages" -d "{\"turn\": \"$TID\", \"role\": \"user\", \"parts\": [{\"type\": \"text\", \"text\": \"hello\"}]}" | j 'd["seq"]'
SVC=$(service_token)
curl -sf "${auth[@]}" -H "X-Texera-Service-Token: $SVC" -H "X-Texera-Origin: conversation=$CRID;turn=$TID;template=$TPL" -X POST "$API/workflows" -d '{"name": "from chat '"$STAMP"'", "spec": {"operators": [], "links": []}}' | j 'd["metadata"]["origin"]["turn"] == "'"$TID"'"'
curl -sf -o /dev/null "${auth[@]}" -X DELETE "$API/conversations/$CRID/turns/$TID"
curl -sf "${auth[@]}" "$API/conversations/$CRID/resources" | j '[(r["kind"], r["metadata"]["name"]) for r in d]'
curl -sf "${auth[@]}" "$API/conversations/$CRID" | j 'd["status"].get("activeTurn"), d["status"]["messages"]'

echo "== MCP: the catalog and dataflow servers"
mcp() {
  curl -s -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -X POST "$GW/mcp/$1" -d "$2" \
    | sed 's/^data: //' | grep -v '^event:' | grep -v '^$' | head -1
}
mcp catalog '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | j 'd["result"]["serverInfo"]["name"]'
mcp catalog '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | j 'sorted(t["name"] for t in d["result"]["tools"])'
mcp dataflow '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}' | j 'sorted(t["name"] for t in d["result"]["tools"])'
mcp dataflow "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"get_workflow\",\"arguments\":{\"rid\":\"$RID\"}}}" | j 'd["result"]["structuredContent"]["metadata"]["head"], len(d["result"]["structuredContent"]["spec"]["operators"])'
mcp catalog "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"resolve_uri\",\"arguments\":{\"uri\":\"$DSURI@1\"}}}" | j 'd["result"]["structuredContent"]["version"]["vno"]'
expect "$(curl -s -o /dev/null -w '%{http_code}' -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -X POST "$GW/mcp/catalog" -d '{"jsonrpc":"2.0","id":6,"method":"tools/list","params":{}}')" 401 "mcp without a token"
echo "== done"
