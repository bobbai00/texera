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

# Step 0 proof: Envoy asks the Dashboard service (here a stub) before forwarding a request
# for a computing unit, and routes to the unit the answer names. Checked in three modes:
#
#   compose    Envoy, stub and two fake units as containers on one Docker network
#   local-dev  Envoy in Docker; stub and units as host processes (via host.docker.internal)
#   k8s        Envoy Gateway on the local cluster: SecurityPolicy extAuth + DynamicResolver Backend
#
#   ./run.sh                  all three modes
#   ./run.sh compose k8s      only these
#
# Prints one PASS/FAIL line per check (INFO lines carry versions), tears everything down even
# on failure or Ctrl-C, and exits non-zero if any check failed. Unit keys are generated per run
# and never printed. If no Envoy Gateway controller is running, it is installed with Helm and
# left installed (helm release "eg" in namespace envoy-gateway-system).
#
# Env: KUBE_CONTEXT (default orbstack), WS_SECONDS (default 17), KEEP_IMAGE=1 keeps the
# sce0env-py:step0 image after the run.
#
# Host ports, all on 127.0.0.1 (assigned range 19520-19539):
#   compose    19520 Envoy, 19521 Envoy admin, 19522/19523 unit-a/unit-b admin, 19524 stub
#   local-dev  19525 Envoy, 19526 Envoy admin, 19527 stub, 19528/19529 unit-a app/admin,
#              19530/19531 unit-b app/admin
#   k8s        port-forwards: 19532 Envoy, 19533/19534 unit-a/unit-b admin, 19535 stub,
#              19536 Envoy admin
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/.out"
KCTX="${KUBE_CONTEXT:-orbstack}"
WS_SECONDS="${WS_SECONDS:-17}"
PY="$HERE/.venv/bin/python"
PY_IMAGE="sce0env-py:step0"
ENVOY_IMAGE="envoyproxy/envoy:distroless-v1.36.4"
EG_CHART="oci://docker.io/envoyproxy/gateway-helm"
EG_VERSION="v1.6.3"
NS="sce0-envoy"

PASSES=0
FAILS=0
RAN_MODES=""

# ------------------------------------------------------------------------------ helpers
say() { printf '%s\n' "$*" | tee -a "$OUT/results.txt"; }
note() { printf '.. %s\n' "$*" >&2; }
k() { kubectl --context "$KCTX" "$@"; }

count_line() {
  say "$1"
  case "$1" in
    PASS*) PASSES=$((PASSES + 1)) ;;
    FAIL*) FAILS=$((FAILS + 1)) ;;
  esac
}

# Run a command that prints PASS/FAIL lines; echo and count them as they come. A command that
# exits non-zero without having reported a FAIL (a crash) is a FAIL of its own.
checks() { # mode command...
  local mode="$1" line rc fails_before="$FAILS" label a
  shift
  label="$1"
  for a in "$@"; do case "$a" in *.py) label="$(basename "$a")"; break ;; esac; done
  rm -f "$OUT/.last-rc"
  while IFS= read -r line; do count_line "$line"; done < <(
    "$@" 2>>"$OUT/stderr.log"
    echo "$?" >"$OUT/.last-rc"
  )
  rc="$(cat "$OUT/.last-rc" 2>/dev/null || echo 1)"
  if [ "$rc" != 0 ] && [ "$FAILS" -eq "$fails_before" ]; then
    count_line "FAIL [$mode] $label: exited $rc without reporting (see .out/stderr.log)"
  fi
}

setup_fail() { count_line "FAIL [$1] setup: $2"; }

wait_http() { # url [status] [seconds]
  local url="$1" want="${2:-200}" secs="${3:-60}" code i
  for ((i = 0; i < secs * 4; i++)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null)"
    [ "$code" = "$want" ] && return 0
    sleep 0.25
  done
  note "timed out waiting for $url to answer $want (last: $code)"
  return 1
}

wait_value() { # want seconds command...  (waits until the command prints exactly want)
  local want="$1" secs="$2" i
  shift 2
  for ((i = 0; i < secs; i++)); do
    [ "$("$@" 2>/dev/null)" = "$want" ] && return 0
    sleep 1
  done
  return 1
}

render_envoy() { # authz-host authz-port out-file
  sed -e "s/__AUTHZ_HOST__/$1/g" -e "s/__AUTHZ_PORT__/$2/g" "$HERE/envoy/envoy.yaml.tmpl" >"$3"
}

envoy_version() { curl -s --max-time 3 "$1/server_info" | jq -r '.version' | cut -d/ -f2; }

# ------------------------------------------------------------------------------ setup
setup() {
  mkdir -p "$OUT"
  : >"$OUT/results.txt"
  : >"$OUT/stderr.log"
  local tool
  for tool in uv docker curl jq openssl sed; do
    command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
  done
  note "python venv (uv) and the stub/unit image"
  [ -x "$PY" ] || uv venv -q --python 3.13 "$HERE/.venv" || exit 2
  uv pip install -q --python "$PY" --require-hashes -r "$HERE/requirements.lock" || exit 2
  docker build -q -t "$PY_IMAGE" "$HERE" >>"$OUT/stderr.log" 2>&1 || { echo "docker build failed" >&2; exit 2; }
  # Fresh unit keys for this run; only child processes see them.
  UNIT_A_KEY="$(openssl rand -hex 24)"
  UNIT_B_KEY="$(openssl rand -hex 24)"
  export UNIT_A_KEY UNIT_B_KEY
  say "INFO run $(date -u +%Y-%m-%dT%H:%M:%SZ): docker $(docker version --format '{{.Server.Version}}'), \
$(docker compose version --short 2>/dev/null | sed 's/^/compose /'), $(orb version 2>/dev/null | head -1 | sed 's/Version: /orbstack /'), \
python $("$PY" -I -c 'import sys, aiohttp; print(sys.version.split()[0], "aiohttp", aiohttp.__version__)')"
}

# ------------------------------------------------------------------------------ compose
compose() { docker compose -f "$HERE/compose/docker-compose.yaml" "$@"; }

compose_down() {
  ENVOY_CONFIG=/dev/null UNIT_A_KEY=x UNIT_B_KEY=x compose down -v --remove-orphans -t 2 >/dev/null 2>&1 || true
}

run_compose() {
  local mode=compose
  note "compose: starting Envoy, stub and units on network sce0env-net"
  compose_down
  render_envoy sce0env-stub 9000 "$OUT/envoy-compose.yaml"
  if ! ENVOY_CONFIG="$OUT/envoy-compose.yaml" compose up -d >>"$OUT/stderr.log" 2>&1; then
    setup_fail $mode "docker compose up failed (see .out/stderr.log)"
    compose_down
    return
  fi
  if ! { wait_http http://127.0.0.1:19521/ready && wait_http http://127.0.0.1:19522/_admin/health &&
    wait_http http://127.0.0.1:19523/_admin/health && wait_http http://127.0.0.1:19524/_stub/health; }; then
    setup_fail $mode "containers did not become ready"
    compose_down
    return
  fi
  say "INFO [$mode] envoy $(envoy_version http://127.0.0.1:19521) ($ENVOY_IMAGE)"
  note "compose: checks"
  checks $mode "$PY" -I "$HERE/app/checks.py" --mode $mode --envoy http://127.0.0.1:19520 \
    --unit-a-admin http://127.0.0.1:19522 --unit-b-admin http://127.0.0.1:19523 \
    --stub-admin http://127.0.0.1:19524 --unit-a-address sce0env-unit-a:8080 \
    --unit-b-address sce0env-unit-b:8080 --ws-seconds "$WS_SECONDS" --json-out "$OUT/$mode.json"
  # Another container on the same network (unit-b) calls unit-a directly, bypassing Envoy.
  checks $mode docker exec sce0env-unit-b python -I /app/probe_direct.py --mode $mode http://sce0env-unit-a:8080
  note "compose: stopping the stub, checking Envoy fails closed"
  docker stop -t 2 sce0env-stub >/dev/null
  checks $mode "$PY" -I "$HERE/app/checks.py" --mode $mode --phase authz-down --envoy http://127.0.0.1:19520 \
    --unit-a-admin http://127.0.0.1:19522 --unit-b-admin http://127.0.0.1:19523 \
    --unit-a-address sce0env-unit-a:8080 --unit-b-address sce0env-unit-b:8080 --json-out "$OUT/$mode-down.json"
  local c
  for c in envoy stub unit-a unit-b; do docker logs "sce0env-$c" >"$OUT/$mode-$c.log" 2>&1; done
  compose_down
}

# ------------------------------------------------------------------------------ local-dev
local_down() {
  docker rm -f sce0env-local-envoy >/dev/null 2>&1 || true
  local p
  for p in stub unit-a unit-b; do
    if [ -f "$OUT/local/$p.pid" ]; then
      kill "$(cat "$OUT/local/$p.pid")" 2>/dev/null || true
      rm -f "$OUT/local/$p.pid"
    fi
  done
}

start_bg() { # name command...
  local name="$1"
  shift
  nohup "$@" >"$OUT/local/$name.log" 2>&1 &
  echo $! >"$OUT/local/$name.pid"
}

run_local() {
  local mode=local-dev
  note "local-dev: stub and units as host processes on 127.0.0.1, Envoy in Docker"
  local_down
  mkdir -p "$OUT/local"
  start_bg unit-a env UNIT_NAME=unit-a UNIT_KEY="$UNIT_A_KEY" UNIT_HOST=127.0.0.1 APP_PORT=19528 \
    ADMIN_PORT=19529 "$PY" -I "$HERE/app/unit.py"
  start_bg unit-b env UNIT_NAME=unit-b UNIT_KEY="$UNIT_B_KEY" UNIT_HOST=127.0.0.1 APP_PORT=19530 \
    ADMIN_PORT=19531 "$PY" -I "$HERE/app/unit.py"
  start_bg stub env UNIT_A_NAME=unit-a UNIT_A_ADDR=host.docker.internal:19528 UNIT_B_NAME=unit-b \
    UNIT_B_ADDR=host.docker.internal:19530 STUB_HOST=127.0.0.1 STUB_PORT=19527 "$PY" -I "$HERE/app/stub.py"
  render_envoy host.docker.internal 19527 "$OUT/envoy-local.yaml"
  if ! docker run -d --name sce0env-local-envoy -p 127.0.0.1:19525:10080 -p 127.0.0.1:19526:9901 \
    -v "$OUT/envoy-local.yaml:/etc/envoy/envoy.yaml:ro" "$ENVOY_IMAGE" -c /etc/envoy/envoy.yaml \
    --log-level warn >>"$OUT/stderr.log" 2>&1; then
    setup_fail $mode "docker run of Envoy failed"
    local_down
    return
  fi
  if ! { wait_http http://127.0.0.1:19526/ready && wait_http http://127.0.0.1:19529/_admin/health &&
    wait_http http://127.0.0.1:19531/_admin/health && wait_http http://127.0.0.1:19527/_stub/health; }; then
    setup_fail $mode "processes did not become ready"
    local_down
    return
  fi
  say "INFO [$mode] envoy $(envoy_version http://127.0.0.1:19526) ($ENVOY_IMAGE)"
  note "local-dev: checks"
  checks $mode "$PY" -I "$HERE/app/checks.py" --mode $mode --envoy http://127.0.0.1:19525 \
    --unit-a-admin http://127.0.0.1:19529 --unit-b-admin http://127.0.0.1:19531 \
    --stub-admin http://127.0.0.1:19527 --unit-a-address host.docker.internal:19528 \
    --unit-b-address host.docker.internal:19530 --ws-seconds "$WS_SECONDS" --json-out "$OUT/$mode.json"
  # Any local process can reach a unit's port on the host; only the unit key keeps it out.
  checks $mode "$PY" -I "$HERE/app/probe_direct.py" --mode $mode http://127.0.0.1:19528
  note "local-dev: stopping the stub, checking Envoy fails closed"
  kill "$(cat "$OUT/local/stub.pid")" 2>/dev/null
  rm -f "$OUT/local/stub.pid"
  sleep 0.5
  checks $mode "$PY" -I "$HERE/app/checks.py" --mode $mode --phase authz-down --envoy http://127.0.0.1:19525 \
    --unit-a-admin http://127.0.0.1:19529 --unit-b-admin http://127.0.0.1:19531 \
    --unit-a-address host.docker.internal:19528 --unit-b-address host.docker.internal:19530 \
    --json-out "$OUT/$mode-down.json"
  docker logs sce0env-local-envoy >"$OUT/local/envoy.log" 2>&1
  local_down
}

# ------------------------------------------------------------------------------ k8s
port_forward() { # name namespace target local:remote
  nohup kubectl --context "$KCTX" -n "$2" port-forward --address 127.0.0.1 "$3" "$4" \
    >"$OUT/k8s/pf-$1.log" 2>&1 &
  echo $! >"$OUT/k8s/pf-$1.pid"
}

k8s_down() {
  local f i
  for f in "$OUT"/k8s/pf-*.pid; do
    [ -f "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  if k get ns "$NS" >/dev/null 2>&1; then
    k delete ns "$NS" --wait=true --timeout=180s >/dev/null 2>&1 || note "namespace $NS still deleting"
  fi
  if k get gatewayclass "$NS" >/dev/null 2>&1; then
    # Envoy Gateway removes its finalizer once no Gateway uses the class. Never leave the
    # class stuck the way the old "eg" one was: drop the finalizer if the controller does not.
    k delete gatewayclass "$NS" --wait=true --timeout=60s >/dev/null 2>&1 ||
      k patch gatewayclass "$NS" --type=json -p '[{"op":"remove","path":"/metadata/finalizers"}]' >/dev/null 2>&1
  fi
  # Envoy Gateway runs the proxy for our Gateway in its own namespace; wait until it is gone.
  for ((i = 0; i < 90; i++)); do
    [ -z "$(k get deploy,svc -A -l "gateway.envoyproxy.io/owning-gateway-namespace=$NS" -o name 2>/dev/null)" ] && return 0
    sleep 1
  done
  note "the Envoy proxy for gateway $NS/sce0-gw is still being removed"
}

ensure_envoy_gateway() {
  local ready
  ready="$(k get deploy -A -l control-plane=envoy-gateway \
    -o jsonpath='{range .items[*]}{.status.readyReplicas}{"\n"}{end}' 2>/dev/null | grep -c '^[1-9]')"
  if [ "$ready" -ge 1 ]; then
    EG_STATE="controller already running"
    return 0
  fi
  if [ -n "$(k get crd gatewayclasses.gateway.networking.k8s.io -o jsonpath='{.metadata.deletionTimestamp}' 2>/dev/null)" ]; then
    EG_STATE="CRD gatewayclasses.gateway.networking.k8s.io is stuck deleting; Helm 4 cannot install over it (see RESULTS.md)"
    return 1
  fi
  note "k8s: installing the Envoy Gateway controller $EG_VERSION with Helm (left installed afterwards)"
  if helm upgrade --install eg "$EG_CHART" --version "$EG_VERSION" --kube-context "$KCTX" \
    -n envoy-gateway-system --create-namespace -f "$HERE/k8s/eg-values.yaml" --wait --timeout 5m \
    >>"$OUT/stderr.log" 2>&1; then
    EG_STATE="controller installed by this run (helm release eg in envoy-gateway-system)"
    return 0
  fi
  EG_STATE="helm install failed (see .out/stderr.log)"
  return 1
}

save_xds_pieces() { # config_dump.json -> the pieces the real deployment needs
  jq --arg listener "$NS/sce0-gw/http" '{
    http_connection_manager: (.configs[] | select(."@type" | endswith("ListenersConfigDump"))
      | .dynamic_listeners[] | select(.name == $listener) | .active_state.listener
      | (.default_filter_chain // .filter_chains[0]) | .filters[0].typed_config
      | {http_filters, normalize_path, merge_slashes, path_with_escaped_slashes_action,
         early_header_mutation_extensions, use_remote_address}),
    routes: [.configs[] | select(."@type" | endswith("RoutesConfigDump")) | (.dynamic_route_configs // [])[]
      | .route_config.virtual_hosts[].routes[] | del(.metadata)],
    clusters: [.configs[] | select(."@type" | endswith("ClustersConfigDump")) | (.dynamic_active_clusters // [])[]
      | .cluster | select(.name | test("units|extauth")) | del(.metadata)]
  }' "$1"
}

run_k8s() {
  local mode=k8s proxy_svc proxy_pod proxy_deploy d
  mkdir -p "$OUT/k8s"
  command -v kubectl >/dev/null && command -v helm >/dev/null || { setup_fail $mode "kubectl and helm are needed"; return; }
  if ! k version >/dev/null 2>&1; then setup_fail $mode "cluster $KCTX not reachable"; return; fi
  k8s_down
  if ! ensure_envoy_gateway; then setup_fail $mode "Envoy Gateway: $EG_STATE"; return; fi
  say "INFO [$mode] envoy gateway: $EG_STATE; $(k get deploy -A -l control-plane=envoy-gateway \
    -o jsonpath='{.items[0].spec.template.spec.containers[0].image}'); gateway api CRDs \
$(k get crd httproutes.gateway.networking.k8s.io -o jsonpath='{.metadata.annotations.gateway\.networking\.k8s\.io/bundle-version} {.metadata.annotations.gateway\.networking\.k8s\.io/channel}'); \
kubernetes $(k version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion'); $(helm version --short 2>/dev/null | sed 's/^/helm /')"

  note "k8s: namespace $NS with stub, units, Gateway, HTTPRoute, Backend, SecurityPolicy, ClientTrafficPolicy"
  k apply -f "$HERE/k8s/workloads.yaml" >>"$OUT/stderr.log" 2>&1
  # Keys go in through stdin, never through arguments or files.
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: unit-keys\n  namespace: %s\ntype: Opaque\nstringData:\n  unit-a: "%s"\n  unit-b: "%s"\n' \
    "$NS" "$UNIT_A_KEY" "$UNIT_B_KEY" | k apply -f - >>"$OUT/stderr.log" 2>&1
  k apply -f "$HERE/k8s/gateway.yaml" >>"$OUT/stderr.log" 2>&1
  for d in authz-stub unit-a unit-b; do
    k -n "$NS" rollout status "deploy/$d" --timeout=120s >>"$OUT/stderr.log" 2>&1 ||
      { setup_fail $mode "deployment $d not ready"; k8s_down; return; }
  done
  wait_value True 120 k -n "$NS" get gateway sce0-gw -o jsonpath='{.status.conditions[?(@.type=="Programmed")].status}' ||
    { setup_fail $mode "Gateway not programmed"; k8s_down; return; }
  wait_value True 60 k -n "$NS" get httproute units -o jsonpath='{.status.parents[0].conditions[?(@.type=="ResolvedRefs")].status}' ||
    { setup_fail $mode "HTTPRoute refs not resolved (is the Backend API enabled?)"; k8s_down; return; }
  wait_value True 60 k -n "$NS" get securitypolicy units-ext-auth -o jsonpath='{.status.ancestors[0].conditions[?(@.type=="Accepted")].status}' ||
    { setup_fail $mode "SecurityPolicy not accepted"; k8s_down; return; }
  wait_value True 60 k -n "$NS" get clienttrafficpolicy strip-unit-headers -o jsonpath='{.status.ancestors[0].conditions[?(@.type=="Accepted")].status}' ||
    { setup_fail $mode "ClientTrafficPolicy not accepted"; k8s_down; return; }
  local sel="gateway.envoyproxy.io/owning-gateway-name=sce0-gw,gateway.envoyproxy.io/owning-gateway-namespace=$NS"
  proxy_deploy="$(k get deploy -A -l "$sel" -o jsonpath='{.items[0].metadata.namespace}/{.items[0].metadata.name}')"
  k -n "${proxy_deploy%%/*}" rollout status "deploy/${proxy_deploy#*/}" --timeout=120s >>"$OUT/stderr.log" 2>&1 ||
    { setup_fail $mode "Envoy proxy not ready"; k8s_down; return; }
  proxy_svc="$(k get svc -A -l "$sel" -o jsonpath='{.items[0].metadata.name}')"
  proxy_pod="$(k get pod -A -l "$sel" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')"
  local proxy_ns="${proxy_deploy%%/*}"

  port_forward envoy "$proxy_ns" "svc/$proxy_svc" 19532:8080
  port_forward envoy-admin "$proxy_ns" "pod/$proxy_pod" 19536:19000
  port_forward unit-a "$NS" svc/unit-a 19533:8081
  port_forward unit-b "$NS" svc/unit-b 19534:8081
  port_forward stub "$NS" svc/authz-stub 19535:9000
  # Envoy answering 401 to a request without a login means the extAuth wiring is live.
  if ! { wait_http http://127.0.0.1:19532/api/units/1001/echo 401 90 && wait_http http://127.0.0.1:19533/_admin/health &&
    wait_http http://127.0.0.1:19534/_admin/health && wait_http http://127.0.0.1:19535/_stub/health &&
    wait_http http://127.0.0.1:19536/ready; }; then
    setup_fail $mode "gateway or port-forwards not answering"
    k8s_down
    return
  fi
  say "INFO [$mode] envoy proxy $(envoy_version http://127.0.0.1:19536) ($(k -n "$proxy_ns" get pod "$proxy_pod" \
    -o jsonpath='{.spec.containers[?(@.name=="envoy")].image}'))"
  note "k8s: checks"
  checks $mode "$PY" -I "$HERE/app/checks.py" --mode $mode --envoy http://127.0.0.1:19532 \
    --unit-a-admin http://127.0.0.1:19533 --unit-b-admin http://127.0.0.1:19534 \
    --stub-admin http://127.0.0.1:19535 --unit-a-address "unit-a.$NS.svc.cluster.local:8080" \
    --unit-b-address "unit-b.$NS.svc.cluster.local:8080" --ws-seconds "$WS_SECONDS" --json-out "$OUT/$mode.json"
  # A pod next to the unit (unit-b) calls unit-a directly, bypassing Envoy.
  checks $mode k -n "$NS" exec deploy/unit-b -- python -I /app/probe_direct.py --mode $mode \
    "http://unit-a.$NS.svc.cluster.local:8080"
  curl -s 'http://127.0.0.1:19536/config_dump?include_eds' >"$OUT/k8s/config_dump.json"
  save_xds_pieces "$OUT/k8s/config_dump.json" >"$OUT/k8s/eg-xds-pieces.json" 2>>"$OUT/stderr.log"

  note "k8s: scaling the stub to zero, checking Envoy fails closed"
  k -n "$NS" scale deploy/authz-stub --replicas=0 >>"$OUT/stderr.log" 2>&1
  k -n "$NS" wait --for=delete pod -l app=authz-stub --timeout=60s >>"$OUT/stderr.log" 2>&1
  # Envoy Gateway notices the empty Service and marks the policy invalid; give it a moment.
  wait_value False 30 k -n "$NS" get securitypolicy units-ext-auth -o jsonpath='{.status.ancestors[0].conditions[?(@.type=="Accepted")].status}'
  say "INFO [$mode] with no stub endpoints the SecurityPolicy says: $(k -n "$NS" get securitypolicy units-ext-auth \
    -o jsonpath='{.status.ancestors[0].conditions[?(@.type=="Accepted")].status} {.status.ancestors[0].conditions[?(@.type=="Accepted")].message}')"
  checks $mode "$PY" -I "$HERE/app/checks.py" --mode $mode --phase authz-down --envoy http://127.0.0.1:19532 \
    --unit-a-admin http://127.0.0.1:19533 --unit-b-admin http://127.0.0.1:19534 \
    --unit-a-address "unit-a.$NS.svc.cluster.local:8080" --unit-b-address "unit-b.$NS.svc.cluster.local:8080" \
    --json-out "$OUT/$mode-down.json"
  for d in authz-stub unit-a unit-b; do k -n "$NS" logs "deploy/$d" >"$OUT/k8s/$d.log" 2>&1; done
  k8s_down
}

# ------------------------------------------------------------------------------ main
cleanup() {
  case " $RAN_MODES " in *" compose "*) compose_down ;; esac
  case " $RAN_MODES " in *" local-dev "*) local_down ;; esac
  case " $RAN_MODES " in *" k8s "*) k8s_down ;; esac
  [ "${KEEP_IMAGE:-0}" = 1 ] || docker rmi "$PY_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

MODES="${*:-compose local-dev k8s}"
setup
for m in $MODES; do
  RAN_MODES="$RAN_MODES $m"
  case "$m" in
    compose) run_compose ;;
    local-dev) run_local ;;
    k8s) run_k8s ;;
    *) echo "unknown mode: $m (compose, local-dev, k8s)" >&2; exit 2 ;;
  esac
done
say "SUMMARY $PASSES passed, $FAILS failed (modes: $MODES)"
[ "$FAILS" -eq 0 ]
