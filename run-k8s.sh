#!/usr/bin/env bash
# run-k8s.sh -- the e2e scenarios against Texera on OrbStack Kubernetes: start from a
# clean namespace, deploy the worktree's Helm chart with the given images, run every
# scenario through the Envoy gateway on a Kubernetes computing unit the driver creates
# (and terminates), collect logs, and take everything down again unless --keep.
#
#   ./run-k8s.sh [--images <registry>/<tag>] [--source <worktree>] [--port N] [--keep]
#                [--label <text>] [--lock <dir>] [--no-workarounds] [--forward relay|kubectl]
#                [-- <driver args>]
#
#   --images   default ghcr.io/apache/latest (the published images); a branch build from
#              images/build.sh is sce/<tag>
#   --source   worktree whose bin/k8s chart and sql/ DDL are deployed (default $SCE_SOURCE
#              or the self-contained-engine worktree)
#   --port     local port of the gateway port-forward (default 30080)
#   --keep     leave the deployment running afterwards (default: k8s-stack.sh down)
#   --lock     a directory used as a mutex (mkdir) around the whole run, for a machine
#              shared with other stacks; also $SCE_STACK_LOCK. Released on exit.
#   --no-workarounds / --forward   passed to `k8s-stack.sh up` (see its --help)
#   anything after `--` goes to driver/e2e.py (e.g. -- --scenario a,d)
#
# Writes reports/k8s-<UTC time>.json and reports/k8s-<UTC time>-logs/ (every container's
# log, events, descriptions, the unit pods' logs). Exit code: the driver's (0 all pass,
# 1 a scenario failed, 2 setup failed), or 3 if the deployment did not come up.
set -euo pipefail
SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S="$SCE_HOME/stack/k8s-stack.sh"

keep=false; images="ghcr.io/apache/latest"; label=""; port="${SCE_K8S_PORT:-30080}"
lock="${SCE_STACK_LOCK:-}"; source_args=(); driver_args=(); up_args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep) keep=true ;;
        --images) images="$2"; shift ;;
        --source) source_args=(--source "$2"); shift ;;
        --port) port="$2"; shift ;;
        --label) label="$2"; shift ;;
        --lock) lock="$2"; shift ;;
        --) shift; driver_args=("$@"); break ;;
        --no-workarounds) up_args+=(--no-workarounds) ;;
        --forward) up_args+=(--forward "$2"); shift ;;
        -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1 (see --help)" >&2; exit 64 ;;
    esac
    shift
done
[[ -n "$label" ]] || label="k8s images=$images"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
report="$SCE_HOME/reports/k8s-$stamp.json"
logs="$SCE_HOME/reports/k8s-$stamp-logs"
mkdir -p "$SCE_HOME/reports"

have_lock=false
if [[ -n "$lock" ]]; then
    echo "[run-k8s] waiting for the lock $lock"
    until mkdir "$lock" 2>/dev/null; do sleep 30; done
    have_lock=true
    echo "harness-k8s $(date)" > "$lock/owner"
    echo "[run-k8s] lock taken"
fi

follower=""
deployed=false
finish() {
    local rc=$?
    set +e
    if [[ -n "$follower" ]]; then kill "$follower" 2>/dev/null; wait "$follower" 2>/dev/null; fi
    if $deployed; then
        "$K8S" collect-logs "$logs" >/dev/null 2>&1 && echo "[run-k8s] logs in $logs"
    fi
    if ! $keep; then
        echo "[run-k8s] taking the deployment down; pass --keep to leave it up"
        "$K8S" down
    else
        echo "[run-k8s] --keep: deployment left running at http://127.0.0.1:$port (stack/k8s-stack.sh down to remove)"
    fi
    if $have_lock; then rm -rf "$lock"; echo "[run-k8s] lock released"; fi
    exit "$rc"
}
trap finish EXIT

echo "[run-k8s] clean start: removing any previous deployment"
"$K8S" down

echo "[run-k8s] deploying images $images"
deployed=true
mkdir -p "$logs"
{   # what ran: the harness commit and any uncommitted change in it
    echo "harness: $(git -C "$SCE_HOME" rev-parse HEAD 2>/dev/null || echo 'not a git checkout')"
    git -C "$SCE_HOME" status --porcelain 2>/dev/null
} > "$logs/harness-git.txt"
if ! "$K8S" ${source_args[@]+"${source_args[@]}"} up --images "$images" --port "$port" \
        ${up_args[@]+"${up_args[@]}"}; then
    echo "[run-k8s] the deployment did not come up" >&2
    "$K8S" status || true
    exit 3
fi
"$K8S" status

mkdir -p "$logs/units"
"$K8S" follow-units "$logs/units" > "$logs/follow-units.log" 2>&1 &
follower=$!

echo "[run-k8s] running the e2e driver against http://127.0.0.1:$port"
set +e
"$SCE_HOME/driver/run.sh" --target k8s --base "http://127.0.0.1:$port" --report "$report" \
    --label "$label" --stack-manifest "$SCE_HOME/stack/k8s/generated/MANIFEST.json" \
    ${driver_args[@]+"${driver_args[@]}"}
rc=$?
set -e

# The driver terminated its unit; its pod must go away.
gone=false
for _ in $(seq 1 45); do
    if [[ -z "$(kubectl --context "${SCE_K8S_CONTEXT:-orbstack}" -n "${SCE_K8S_NAMESPACE:-sce-k8s}-units" \
            get pods -l type=computing-unit -o name 2>/dev/null)" ]]; then gone=true; break; fi
    sleep 2
done
echo "[run-k8s] unit pods after the run: $($gone && echo 'none (terminated)' || echo 'still present')"
echo "[run-k8s] driver exit code $rc; report $report"
exit "$rc"
