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

# Texera 2.0 on AWS, in one command:
#
#   deploy/aws/deploy.sh up           # the cluster, the images, the stack, the model key; prints the URL
#   deploy/aws/deploy.sh cluster      # the AWS side alone: network, EKS, registry, load balancer (cluster/)
#   deploy/aws/deploy.sh images       # build the images for the nodes' architecture and push them
#   deploy/aws/deploy.sh stack        # the stack on the cluster (texera/), then wait for the gateway
#   deploy/aws/deploy.sh model-key    # the platform's model key into the secret store
#   deploy/aws/deploy.sh check        # test.sh cluster: the scenarios and Playwright against the public URL
#   deploy/aws/deploy.sh status       # pods, services, jobs, volumes
#   deploy/aws/deploy.sh kubectl ...  # kubectl in the stack's namespace
#   deploy/aws/deploy.sh plan         # what an apply would change, in both modules
#   deploy/aws/deploy.sh down         # remove the stack; the cluster stays
#   deploy/aws/deploy.sh destroy      # remove everything
#
# Terraform's state stays in cluster/ and texera/ (gitignored). kubectl's access goes to a
# kubeconfig of its own (TEXERA2_AWS_KUBECONFIG, ~/.kube/texera2-aws.yaml by default), never
# the default one, so no other cluster's context is touched. The model key comes from
# ANTHROPIC_API_KEY or TEXERA_ENV_FILE, as for the local stacks, and goes straight into the
# secret store: it is in no manifest, state file or Secret. TEXERA2_LOGIN_LOGO puts a
# deployment's own logo on the sign-in pages; TEXERA2_IMAGE_TAG names the images (the commit
# by default).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
# shellcheck source=../../bin/texera-2-0/lib.sh
source "$ROOT/bin/texera-2-0/lib.sh"
KUBECONFIG_FILE=${TEXERA2_AWS_KUBECONFIG:-$HOME/.kube/texera2-aws.yaml}
NS=texera2
IMAGES=(catalog agent-runtime live frontend bio-mcp computing-unit-master)

need() { command -v "$1" >/dev/null || { echo "$1 is required; see deploy/aws/README.md" >&2; exit 1; }; }
tf() { local dir=$1; shift; terraform -chdir="$HERE/$dir" "$@"; }
init() { tf "$1" init -input=false >/dev/null; }
stack_vars() { echo "-var=login_logo=${TEXERA2_LOGIN_LOGO:-}"; }

# load reads the cluster's facts from its state, which a new checkout can do once Terraform is
# initialized there. No state here does not mean no cluster: it may be another machine's.
load() {
  need terraform
  init cluster
  # An empty state is no error to Terraform: it prints nothing and succeeds.
  CLUSTER=$(tf cluster output -raw cluster_name 2>/dev/null || true)
  if [ -z "$CLUSTER" ]; then
    echo "no cluster in this checkout's state. To make one: $0 cluster (or up). If it exists already, bring its state here first (README, State and access): an apply without it would build a second one." >&2
    exit 1
  fi
  REGION=$(tf cluster output -raw region)
  REGISTRY=$(tf cluster output -raw registry)
  ARCH=$(tf cluster output -raw node_architecture)
  PUBLIC=$(tf cluster output -raw public_url)
  CONTEXT=$CLUSTER-aws
}

# kubeconfig writes the cluster's context to the stack's own kubeconfig file.
kubeconfig() {
  mkdir -p "$(dirname "$KUBECONFIG_FILE")"
  aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION" --kubeconfig "$KUBECONFIG_FILE" --alias "$CONTEXT" >/dev/null
  echo "kubectl: --kubeconfig $KUBECONFIG_FILE --context $CONTEXT -n $NS"
}

kube() {
  [ -f "$KUBECONFIG_FILE" ] || kubeconfig >/dev/null
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$NS" "$@"
}

cluster() {
  need terraform; need aws
  init cluster
  tf cluster apply -input=false -auto-approve
  load
  kubeconfig
}

images() {
  need docker; need jq; need git
  load
  local tag platform digests='{}' image ref digest
  tag=${TEXERA2_IMAGE_TAG:-$(git -C "$ROOT" describe --always --dirty --abbrev=9)}
  case "$ARCH" in arm64) platform=linux/arm64 ;; *) platform=linux/amd64 ;; esac
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  for image in "${IMAGES[@]}"; do
    ref="$REGISTRY/texera/$image:$tag"
    echo "== image $ref ($platform)"
    # No build attestations: they are made anew by every build, so the digest of an image that
    # did not change would, and every workload would start again at every deployment.
    docker build --platform "$platform" --provenance=false --sbom=false -q -f "$ROOT/bin/dockerfiles/$image.dockerfile" -t "$ref" "$ROOT" >/dev/null
    docker push -q "$ref" >/dev/null
    # Pods run the image by this digest, so a tag pushed again is still a change.
    digest=$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" | sed -n "s#^$REGISTRY/texera/$image@##p" | head -1)
    [ -n "$digest" ] || { echo "no digest for $ref after the push" >&2; exit 1; }
    digests=$(jq --arg k "$image" --arg v "$digest" '. + {($k): $v}' <<<"$digests")
  done
  jq -n --arg tag "$tag" --argjson digests "$digests" '{image_tag: $tag, image_digests: $digests}' >"$HERE/texera/images.auto.tfvars.json"
  echo "== images pushed as $tag (texera/images.auto.tfvars.json)"
}

stack() {
  need terraform; need aws; need kubectl
  load
  [ -f "$HERE/texera/images.auto.tfvars.json" ] || { echo "no images yet: run $0 images" >&2; exit 1; }
  init texera
  local before
  before=$(kube get configmap texera2-public -o jsonpath='{.data.public-url}' 2>/dev/null || true)
  apply_stack
  kubeconfig
  if [ -n "$before" ] && [ "$before" != "$PUBLIC" ]; then moved; fi
  wait_ready
}

# moved is what a changed public URL needs beyond the apply (a domain given, say, where the
# load balancer's own name was). Keycloak imported its realm once, with the app sent back to
# the old address: the app's client is given the new one with Keycloak's own admin CLI, in its
# pod, so the administrator's password never leaves it. And what read the old address at its
# start starts again. Nothing that people made is touched.
MOVES=(keycloak gateway catalog unit agent-runtime lakekeeper)
moved() {
  local app
  echo "== the public URL is now $PUBLIC"
  for app in "${MOVES[@]}"; do kube rollout restart "deployment/$app" >/dev/null; done
  kube rollout status deployment/keycloak --timeout=900s >/dev/null
  kube exec deployment/keycloak -- sh -c '
    set -e
    kc=/opt/keycloak/bin/kcadm.sh
    $kc config credentials --server http://localhost:8080/auth --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null 2>&1
    id=$($kc get clients -r texera -q clientId=texera-app --fields id --format csv --noquotes)
    $kc update "clients/$id" -r texera -s "redirectUris=[\"$1/*\"]"
    echo "realm: the app is sent back to $1"
  ' sh "$PUBLIC"
  for app in "${MOVES[@]}"; do kube rollout status "deployment/$app" --timeout=900s >/dev/null; done
}

# apply_stack applies the stack. An object an earlier apply made but did not record, because
# the wait for it timed out, makes the next apply fail as "already exists": such objects are
# adopted into the state and the apply runs once more.
apply_stack() {
  local log ids id
  log=$(mktemp)
  if tf texera apply -input=false -auto-approve "$(stack_vars)" 2>&1 | tee "$log"; then rm -f "$log"; return 0; fi
  grep -q 'already exists' "$log" || { rm -f "$log"; return 1; }
  ids=$(sed -n 's/.*with kustomization_resource\.p1\["\([^"]*\)"\].*/\1/p' "$log" | sort -u)
  rm -f "$log"
  for id in $ids; do
    echo "== adopting $id, made by an earlier apply"
    tf texera import -input=false "$(stack_vars)" "kustomization_resource.p1[\"$id\"]" "$id" >/dev/null
  done
  tf texera apply -input=false -auto-approve "$(stack_vars)"
}

wait_ready() {
  local _
  for _ in $(seq 1 200); do
    if curl -sf -o /dev/null "$PUBLIC/auth/realms/texera" && curl -sf -o /dev/null "$PUBLIC/catalog/v1/public"; then
      echo "gateway: answering on $PUBLIC"
      return 0
    fi
    sleep 3
  done
  echo "the gateway does not answer on $PUBLIC; see $0 status" >&2
  exit 1
}

# model_key puts the platform's model key where the catalog reads it, through the store's own
# CLI in its pod: the token and the key travel on stdin, never in an argument or a file.
model_key() {
  need kubectl; need jq
  load
  local key token
  key=${ANTHROPIC_API_KEY:-}
  if [ -z "$key" ]; then key=$(env_file_value ANTHROPIC_API_KEY); fi
  [ -n "$key" ] || { echo "no model key: set TEXERA_ENV_FILE or ANTHROPIC_API_KEY" >&2; exit 1; }
  token=$(tf texera output -json secrets | jq -r .secrets_token)
  printf '%s\n%s' "$token" "$key" | kube exec -i deploy/openbao -c openbao -- \
    sh -c 'read -r BAO_TOKEN; export BAO_TOKEN; bao kv put -mount=texera platform/anthropic value=- >/dev/null && echo "platform model key loaded"'
}

# check runs the cluster checks against the public URL, as this deployment's service clients.
check() {
  need jq
  load
  local secrets
  secrets=$(tf texera output -json secrets)
  [ -f "$KUBECONFIG_FILE" ] || kubeconfig >/dev/null
  # TEXERA_E2E_STORE is empty: the store here is S3 through identities, so there is no key for
  # the scenario that puts a warehouse of its own on the deployment's store; it is skipped.
  TEXERA_E2E_SERVICES_CLIENT_SECRET=$(jq -r .services_client_secret <<<"$secrets") \
    TEXERA_E2E_UNIT_CLIENT_SECRET=$(jq -r .unit_client_secret <<<"$secrets") \
    TEXERA_E2E_SECRETS_TOKEN=$(jq -r .secrets_token <<<"$secrets") \
    TEXERA_E2E_STORE="" \
    TEXERA2_PUBLIC_URL=$PUBLIC TEXERA2_KUBE_CONTEXT=$CONTEXT KUBECONFIG=$KUBECONFIG_FILE \
    exec "$ROOT/bin/texera-2-0/test.sh" cluster "$@"
}

case "${1:-}" in
  up)
    cluster
    images
    stack
    # The model key is loaded when one is configured; without it everything but the chat works.
    if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "$(env_file_value ANTHROPIC_API_KEY)" ]; then
      model_key
    else
      echo "model key: none (set TEXERA_ENV_FILE or ANTHROPIC_API_KEY and run $0 model-key to chat)"
    fi
    echo "== up: $PUBLIC (alice/alice, bob/bob)"
    ;;
  cluster) cluster ;;
  images) images ;;
  stack) stack ;;
  model-key) model_key ;;
  kubeconfig) load; kubeconfig ;;
  status) load; kube get pods,svc,jobs,pvc ;;
  kubectl) shift; load; kube "$@" ;;
  check) shift; check "$@" ;;
  plan)
    init cluster
    tf cluster plan -input=false
    if [ -f "$HERE/texera/images.auto.tfvars.json" ]; then
      init texera
      tf texera plan -input=false "$(stack_vars)"
    fi
    ;;
  down) load; init texera; tf texera destroy -input=false -auto-approve "$(stack_vars)" ;;
  destroy) "$0" down; tf cluster destroy -input=false -auto-approve ;;
  *) echo "usage: $0 up | cluster | images | stack | model-key | check [pytest args] | status | kubectl ... | plan | down | destroy" >&2; exit 2 ;;
esac
