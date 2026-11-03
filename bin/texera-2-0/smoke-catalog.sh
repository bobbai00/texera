#!/usr/bin/env bash
# Smoke test of the catalog through the gateway: identity, resources, versions, lineage,
# the seeded templates, and the MCP server. Needs the dev stack and a running catalog.
set -euo pipefail
GW=${GW:-http://localhost:8088}
USER_=${USER_:-alice}
PASS=${PASS:-alice}

token() {
  curl -sf -X POST "$GW/auth/realms/texera/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=texera-app -d username="$1" -d password="$2" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])'
}
TOK=$(token "$USER_" "$PASS")
auth=(-H "Authorization: Bearer $TOK" -H "Content-Type: application/json")
j() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

echo "== whoami"
ME=$(curl -sf "${auth[@]}" "$GW/catalog/v1/me")
echo "$ME" | j 'd["principal"]["displayName"], d["homeProject"]'

echo "== seeded templates and units"
curl -sf "${auth[@]}" "$GW/catalog/v1/agent-templates" | j '[i["metadata"]["name"] for i in d["items"]]'
curl -sf "${auth[@]}" "$GW/catalog/v1/computing-units/available" | j '[(i["metadata"]["name"], i["status"]["phase"]) for i in d]'
curl -sf "${auth[@]}" "$GW/catalog/v1/mcp-servers" | j '[(i["metadata"]["name"], i["spec"]["url"]) for i in d["items"]]'

echo "== workflow with content, edit by patch, versions, lineage"
WF=$(curl -sf "${auth[@]}" -X POST "$GW/catalog/v1/workflows/with-content" -d '{
  "name": "smoke", "content": {"operators": [{"operatorID": "a", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": "x.csv"}}], "links": []}}')
RID=$(echo "$WF" | j 'd["workflow"]["metadata"]["rid"]')
echo "rid=$RID v=$(echo "$WF" | j 'd["version"]["vno"]')"
V2=$(curl -sf "${auth[@]}" -X POST "$GW/catalog/v1/workflows/$RID/edit" -d '{"patch": [{"op": "add", "path": "/operators/-", "value": {"operatorID": "b", "operatorType": "Filter", "operatorProperties": {}}},
  {"op": "add", "path": "/links/-", "value": {"linkID": "l1", "source": {"operatorID": "a", "portID": "output-0"}, "target": {"operatorID": "b", "portID": "input-0"}}}], "message": "add a filter"}')
echo "edited -> v$(echo "$V2" | j 'd["vno"]') operators=$(echo "$V2" | j 'len(d["content"]["operators"])')"
curl -sf "${auth[@]}" "$GW/catalog/v1/resources/$RID/versions" | j '[v["vno"] for v in d["items"]]'
curl -s "${auth[@]}" -X POST "$GW/catalog/v1/workflows/$RID/edit" -d '{"patch": [{"op": "add", "path": "/links/-", "value": {"linkID": "bad", "source": {"operatorID": "a", "portID": "output-0"}, "target": {"operatorID": "zzz", "portID": "input-0"}}}]}' | j 'd["code"], d["message"]'
curl -sf "${auth[@]}" "$GW/catalog/v1/resources/$RID/lineage" | j 'd'

echo "== sharing: bob cannot read until granted"
BOB=$(token bob bob)
curl -s -o /dev/null -w "bob read before grant: %{http_code}\n" -H "Authorization: Bearer $BOB" "$GW/catalog/v1/workflows/$RID"
BOBPID=$(curl -sf -H "Authorization: Bearer $BOB" "$GW/catalog/v1/me" | j 'd["principal"]["pid"]')
curl -sf "${auth[@]}" -X PUT "$GW/catalog/v1/resources/$RID/grants/$BOBPID" -d '{"relation":"viewer"}' | j 'd["relation"]'
curl -s -o /dev/null -w "bob read after grant: %{http_code}\n" -H "Authorization: Bearer $BOB" "$GW/catalog/v1/workflows/$RID"
curl -s -o /dev/null -w "bob edit as viewer: %{http_code}\n" -H "Authorization: Bearer $BOB" -H "Content-Type: application/json" -X POST "$GW/catalog/v1/workflows/$RID/edit" -d '{"content": {}}'

echo "== dataset: upload, commit, files, download"
DS=$(curl -sf "${auth[@]}" -X POST "$GW/catalog/v1/datasets" -d '{"name": "iris-smoke", "spec": {}}' | j 'd["metadata"]["rid"]')
printf 'sepal_length,species\n5.1,setosa\n4.9,setosa\n' | curl -sf -H "Authorization: Bearer $TOK" -H "Content-Type: application/octet-stream" -X PUT --data-binary @- "$GW/catalog/v1/datasets/$DS/files/iris.csv" | j 'd["path"], d["size"]'
curl -sf "${auth[@]}" -X POST "$GW/catalog/v1/datasets/$DS/commit" -d '{"message": "first"}' | j 'd["vno"], d["contentKind"]'
curl -sf "${auth[@]}" "$GW/catalog/v1/datasets/$DS/versions/1/files" | j '[f["path"] for f in d["files"]]'
curl -sf -H "Authorization: Bearer $TOK" "$GW/catalog/v1/datasets/$DS/versions/1/files/iris.csv?maxBytes=20"; echo
curl -sf "${auth[@]}" "$GW/catalog/v1/datasets/$DS/versions/1/files/iris.csv/link" | j 'd["url"][:60]'

echo "== conversation, agent, messages, resources from the chat"
TPL=$(curl -sf "${auth[@]}" "$GW/catalog/v1/agent-templates" | j '[i for i in d["items"] if i["metadata"]["name"]=="Data Analyst"][0]["metadata"]["rid"]')
CONV=$(curl -sf "${auth[@]}" -X POST "$GW/catalog/v1/conversations" -d "{\"name\": \"smoke chat\", \"spec\": {\"template\": {\"rid\": \"$TPL\", \"vno\": 1}}}" | j 'd["metadata"]["rid"]')
AGENT=$(curl -sf "${auth[@]}" -X POST "$GW/catalog/v1/agents" -d "{\"template\": {\"rid\": \"$TPL\", \"vno\": 1}, \"conversation\": \"$CONV\"}" | j 'd["pid"]')
echo "conversation=$CONV agent=$AGENT"
curl -sf "${auth[@]}" -X POST "$GW/catalog/v1/conversations/$CONV/messages" -d '{"role": "user", "parts": [{"type": "text", "text": "hello"}]}' | j 'd["seq"]'
curl -sf "${auth[@]}" -X POST "$GW/catalog/v1/workflows/with-content" -d "{\"name\": \"from chat\", \"content\": {\"operators\": [], \"links\": []}, \"origin\": {\"conversation\": \"$CONV\", \"seq\": 1}}" >/dev/null
curl -sf "${auth[@]}" "$GW/catalog/v1/conversations/$CONV/resources" | j '[(r["kind"], r["metadata"]["name"]) for r in d]'

echo "== MCP: initialize and list tools"
INIT=$(curl -s -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -X POST "$GW/mcp" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
echo "$INIT" | sed 's/^data: //' | grep -v '^event:' | grep -v '^$' | head -1 | j 'd["result"]["serverInfo"]["name"], d["result"]["protocolVersion"]'
curl -s -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -X POST "$GW/mcp" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | sed 's/^data: //' | grep -v '^event:' | grep -v '^$' | head -1 | j 'sorted(t["name"] for t in d["result"]["tools"])'
curl -s -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -X POST "$GW/mcp" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_workflow\",\"arguments\":{\"rid\":\"$RID\"}}}" | sed 's/^data: //' | grep -v '^event:' | grep -v '^$' | head -1 | j 'd["result"]["structuredContent"]["vno"], len(d["result"]["structuredContent"]["content"]["operators"])'
curl -s -o /dev/null -w "mcp without token: %{http_code}\n" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -X POST "$GW/mcp" -d '{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}'
echo "== done"
