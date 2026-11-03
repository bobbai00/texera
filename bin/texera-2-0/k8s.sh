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

# Texera 2.0 on the local Kubernetes cluster: builds the images, applies deploy/kubernetes and
# waits until the gateway answers on http://localhost:28088.
#
#   bin/texera-2-0/k8s.sh up [--no-build]   # TEXERA_ENV_FILE=... also hands over ANTHROPIC_API_KEY
#   bin/texera-2-0/k8s.sh status
#   bin/texera-2-0/k8s.sh down              # deletes the namespace, data included
#
# Only the context in TEXERA2_KUBE_CONTEXT (default: orbstack) is touched, and a context that
# looks like a remote cloud cluster is refused. The config maps come from the files the dev stack
# uses, so the two cannot drift: the realm, the gateway (pointed at the cluster's services) and
# the warehouse bootstrap.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
CONTEXT=${TEXERA2_KUBE_CONTEXT:-orbstack}
NS=texera2
TAG=2.0-dev
PUBLIC=http://localhost:28088
case "$CONTEXT" in
  *arn:aws* | *eks* | *gke_* | *aks*) echo "refusing to touch $CONTEXT: this script is for a local cluster" >&2; exit 1 ;;
esac
k() { kubectl --context "$CONTEXT" -n "$NS" "$@"; }
APPS=(catalog unit agent-runtime frontend gateway)

build() {
  for image in catalog agent-runtime frontend computing-unit-master; do
    echo "== image texera/$image:$TAG"
    docker build -q -f "$ROOT/bin/dockerfiles/$image.dockerfile" -t "texera/$image:$TAG" "$ROOT" >/dev/null
  done
}

configure() {
  local tmp key
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  kubectl --context "$CONTEXT" apply -f "$ROOT/deploy/kubernetes/namespace.yaml" >/dev/null
  k create configmap keycloak-realm --from-file=texera-realm.json="$HERE/keycloak/texera-realm.json" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  k create configmap lakekeeper-init --from-file=init.sh="$HERE/lakekeeper/init.sh" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  sed -e "s#issuer: http://localhost:8088/auth/realms/texera#issuer: $PUBLIC/auth/realms/texera#" \
    -e 's#uri: http://host.docker.internal:8090#uri: http://catalog:8090#' \
    -e 's#address: host.docker.internal, port_value: 8090#address: catalog, port_value: 8090#' \
    -e 's#address: host.docker.internal, port_value: 23002#address: agent-runtime, port_value: 23002#' \
    -e 's#address: host.docker.internal, port_value: 28085#address: unit, port_value: 8085#' \
    -e 's#address: host.docker.internal, port_value: 5174#address: frontend, port_value: 8080#' \
    "$HERE/envoy/envoy.yaml" >"$tmp/envoy.yaml"
  if grep -q "host.docker.internal\|localhost:8088" "$tmp/envoy.yaml"; then
    echo "the gateway config still points at the host; update the substitutions in $0" >&2
    exit 1
  fi
  k create configmap gateway-config --from-file=envoy.yaml="$tmp/envoy.yaml" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  # The model key goes straight from the env file into a Secret, through a private temp file.
  key=${ANTHROPIC_API_KEY:-}
  if [ -z "$key" ] && [ -n "${TEXERA_ENV_FILE:-}" ] && [ -f "$TEXERA_ENV_FILE" ]; then
    key=$(grep -E '^ANTHROPIC_API_KEY=' "$TEXERA_ENV_FILE" | head -1 | cut -d= -f2-)
  fi
  if [ -n "$key" ]; then
    (umask 077 && printf 'ANTHROPIC_API_KEY=%s\n' "$key" >"$tmp/llm.env")
    k create secret generic texera2-llm --from-env-file="$tmp/llm.env" --dry-run=client -o yaml | k apply -f - >/dev/null
    echo "model key: from ${TEXERA_ENV_FILE:-the environment}"
  else
    echo "model key: none (set TEXERA_ENV_FILE or ANTHROPIC_API_KEY to chat)"
  fi
}

wait_ready() {
  k wait --for=condition=complete job/rustfs-buckets job/lakekeeper-warehouse --timeout=900s >/dev/null
  for app in postgres rustfs; do k rollout status "statefulset/$app" --timeout=900s >/dev/null; done
  for app in keycloak openfga lakekeeper "${APPS[@]}"; do
    k rollout status "deploy/$app" --timeout=900s >/dev/null
    echo "$app: ready"
  done
  for _ in $(seq 1 120); do
    curl -sf -o /dev/null "$PUBLIC/auth/realms/texera" && curl -sf -o /dev/null "$PUBLIC/" && return 0
    sleep 2
  done
  echo "the gateway does not answer on $PUBLIC" >&2
  exit 1
}

case "${1:-}" in
  up)
    [ "${2:-}" = "--no-build" ] || build
    configure
    kubectl --context "$CONTEXT" apply -k "$ROOT/deploy/kubernetes" >/dev/null
    # Same tags, new images or config: restart what already runs so it picks them up.
    for app in "${APPS[@]}"; do k rollout restart "deploy/$app" >/dev/null 2>&1 || true; done
    wait_ready
    echo "== up: $PUBLIC (alice/alice, bob/bob)"
    ;;
  status) k get pods,svc,jobs ;;
  down) kubectl --context "$CONTEXT" delete namespace "$NS" ;;
  *) echo "usage: $0 up [--no-build] | status | down" >&2; exit 2 ;;
esac
