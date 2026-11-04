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

# Texera 2.0 on a local Kubernetes cluster, in one command:
#
#   bin/texera-2-0/k8s.sh up            # cluster if missing, images, config, workloads, wait
#   bin/texera-2-0/k8s.sh up --no-build # reuse the images already built
#   bin/texera-2-0/k8s.sh check         # test.sh cluster: the scenarios and Playwright against the cluster
#   bin/texera-2-0/k8s.sh status        # pods, services, jobs
#   bin/texera-2-0/k8s.sh down          # delete the namespace (the cluster stays)
#   bin/texera-2-0/k8s.sh destroy       # delete the kind cluster
#
# On Linux the cluster is kind (Kubernetes in Docker), created here with node port 30088 mapped
# to localhost:28088, the stack's public URL. Another local cluster works with
# TEXERA2_KUBE_CONTEXT set (OrbStack: `orbstack`); then reach the gateway's node port yourself.
# The model key goes from ANTHROPIC_API_KEY or TEXERA_ENV_FILE into a Secret and from there
# into OpenBao; it is never written into a manifest. Remote clusters are refused.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
export PATH=$HOME/.local/bin:$PATH
# shellcheck source=lib.sh
source "$HERE/lib.sh"
CLUSTER=${TEXERA2_KIND_CLUSTER:-texera2}
# Kubernetes 1.33: its kubelet still runs on cgroup v1 hosts (Ubuntu 20.04); newer node images refuse.
KIND_IMAGE=${TEXERA2_KIND_IMAGE:-kindest/node:v1.33.4}
CONTEXT=${TEXERA2_KUBE_CONTEXT:-kind-$CLUSTER}
NS=texera2
TAG=2.0-dev
PUBLIC=${TEXERA2_PUBLIC_URL:-http://localhost:28088}
case "$CONTEXT" in
  *arn:aws* | *eks* | *gke_* | *aks*) echo "refusing to touch $CONTEXT: this script is for a local cluster" >&2; exit 1 ;;
esac
k() { kubectl --context "$CONTEXT" -n "$NS" "$@"; }
IMAGES=(catalog agent-runtime frontend bio-mcp computing-unit-master)
APPS=(catalog unit agent-runtime bio-mcp frontend gateway)

need() { command -v "$1" >/dev/null || { echo "$1 is required; see bin/texera-2-0/README.md" >&2; exit 1; }; }

# cluster makes the kind cluster when the context is kind's and the cluster does not exist.
cluster() {
  need kubectl
  if [ "$CONTEXT" != "kind-$CLUSTER" ]; then return 0; fi
  need kind
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then return 0; fi
  echo "== kind cluster $CLUSTER (node port 30088 -> localhost:28088)"
  kind create cluster --name "$CLUSTER" --image "$KIND_IMAGE" --wait 300s --config - <<CONFIG
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30088
        hostPort: 28088
        listenAddress: 127.0.0.1
CONFIG
}

build() {
  for image in "${IMAGES[@]}"; do
    echo "== image texera/$image:$TAG"
    docker build -q -f "$ROOT/bin/dockerfiles/$image.dockerfile" -t "texera/$image:$TAG" "$ROOT" >/dev/null
  done
}

# load puts the images on the cluster's node; kind has no registry.
load() {
  if [ "$CONTEXT" != "kind-$CLUSTER" ]; then return 0; fi
  for image in "${IMAGES[@]}"; do
    kind load docker-image --name "$CLUSTER" "texera/$image:$TAG" >/dev/null
  done
  echo "== images loaded into $CLUSTER"
}

configure() {
  local tmp key
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  kubectl --context "$CONTEXT" apply -f "$ROOT/deploy/kubernetes/namespace.yaml" >/dev/null
  k create configmap keycloak-realm --from-file=texera-realm.json="$HERE/keycloak/texera-realm.json" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  k create configmap postgres-init --from-file=init.sql="$HERE/postgres/init.sql" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  # The gateway config is the dev stack's with the host services replaced by cluster names.
  sed -e "s#issuer: http://localhost:8088/auth/realms/texera#issuer: $PUBLIC/auth/realms/texera#" \
    -e 's#uri: http://host.docker.internal:8090#uri: http://catalog:8090#' \
    -e 's#address: host.docker.internal, port_value: 8090#address: catalog, port_value: 8090#' \
    -e 's#address: host.docker.internal, port_value: 23002#address: agent-runtime, port_value: 23002#' \
    -e 's#address: host.docker.internal, port_value: 23010#address: bio-mcp, port_value: 23010#' \
    -e 's#address: host.docker.internal, port_value: 28085#address: unit, port_value: 8085#' \
    -e 's#address: host.docker.internal, port_value: 5174#address: frontend, port_value: 8080#' \
    "$HERE/envoy/envoy.yaml" >"$tmp/envoy.yaml"
  if grep -q "host.docker.internal\|localhost:8088" "$tmp/envoy.yaml"; then
    echo "the gateway config still points at the host; update the substitutions in $0" >&2
    exit 1
  fi
  k create configmap gateway-config --from-file=envoy.yaml="$tmp/envoy.yaml" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  # The model key goes straight from the env file into a Secret, through a private temp file;
  # the openbao-init job moves it into the secret store.
  key=${ANTHROPIC_API_KEY:-}
  if [ -z "$key" ]; then key=$(env_file_value ANTHROPIC_API_KEY); fi
  if [ -n "$key" ]; then
    (umask 077 && printf 'ANTHROPIC_API_KEY=%s\n' "$key" >"$tmp/llm.env")
    k create secret generic texera2-llm --from-env-file="$tmp/llm.env" --dry-run=client -o yaml | k apply -f - >/dev/null
    echo "model key: from ${TEXERA_ENV_FILE:-the environment}"
  else
    echo "model key: none (set TEXERA_ENV_FILE or ANTHROPIC_API_KEY to chat)"
  fi
}

wait_ready() {
  k wait --for=condition=complete job/rustfs-buckets job/openbao-init --timeout=900s >/dev/null
  for app in postgres rustfs; do k rollout status "statefulset/$app" --timeout=900s >/dev/null; done
  for app in keycloak openfga openbao lakekeeper "${APPS[@]}"; do
    k rollout status "deploy/$app" --timeout=900s >/dev/null
    echo "$app: ready"
  done
  for _ in $(seq 1 120); do
    curl -sf -o /dev/null "$PUBLIC/auth/realms/texera" && curl -sf -o /dev/null "$PUBLIC/catalog/v1/settings/public" && return 0
    sleep 2
  done
  echo "the gateway does not answer on $PUBLIC" >&2
  exit 1
}

case "${1:-}" in
  up)
    cluster
    [ "${2:-}" = "--no-build" ] || build
    load
    configure
    kubectl --context "$CONTEXT" apply -k "$ROOT/deploy/kubernetes" >/dev/null
    # Jobs are immutable: a rerun recreates them so the key and the mounts are refreshed.
    for job in openbao-init; do k delete job "$job" --ignore-not-found >/dev/null; done
    kubectl --context "$CONTEXT" apply -k "$ROOT/deploy/kubernetes" >/dev/null
    # Same tags, new images or config: restart what already runs so it picks them up.
    for app in "${APPS[@]}"; do k rollout restart "deploy/$app" >/dev/null 2>&1 || true; done
    wait_ready
    echo "== up: $PUBLIC (alice/alice, bob/bob)"
    ;;
  # The end-to-end checks against the cluster's gateway: the scenarios and Playwright, plus the
  # unit made as a resource (test.sh cluster).
  check) TEXERA2_PUBLIC_URL=$PUBLIC exec "$HERE/test.sh" cluster ;;
  status) k get pods,svc,jobs ;;
  down) kubectl --context "$CONTEXT" delete namespace "$NS" --ignore-not-found ;;
  destroy) need kind; kind delete cluster --name "$CLUSTER" ;;
  *) echo "usage: $0 up [--no-build] | check | status | down | destroy" >&2; exit 2 ;;
esac
