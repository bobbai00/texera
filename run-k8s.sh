#!/usr/bin/env bash
# run-k8s.sh -- the e2e scenarios against Texera on OrbStack Kubernetes: take the stack
# lock, start from a clean namespace, deploy the worktree's Helm chart with the given
# images, run every scenario through the Envoy gateway on a Kubernetes computing unit the
# driver creates (and terminates), check what the run left behind, collect logs, take
# everything down again unless --keep, and release the lock. The run is bounded in time.
#
#   ./run-k8s.sh --lock <dir> [--images <registry>/<tag>] [--source <worktree>] [--port N] [--keep]
#                [--label <text>] [--time-limit MIN] [--no-workarounds] [--forward relay|kubectl]
#                [--allow-crd-drift] [-- <driver args>]
#   ./run-k8s.sh --no-lock ...
#
#   --lock        the stack lock: a directory taken with mkdir (waiting while another run holds
#                 it) and removed at the end; also $SCE_STACK_LOCK. Required: the run starts with
#                 `down`, so without the lock it would tear down another run's deployment, and it
#                 shares the Docker VM with the single-node stack. --no-lock only on a machine
#                 where nothing else deploys
#   --time-limit  minutes from taking the lock to the end of the run (default 50, or
#                 $SCE_K8S_TIME_LIMIT). At the limit the running step is stopped; logs are then
#                 collected and the deployment taken down (a minute or two more), exit 5
#   --images      default ghcr.io/apache/latest (the published images); a branch build from
#                 images/build.sh is sce/<tag>
#   --source      worktree whose bin/k8s chart and sql/ DDL are deployed (default $SCE_SOURCE
#                 or the self-contained-engine worktree)
#   --port        local port of the gateway forward (default 30080)
#   --keep        leave the deployment running afterwards (default: k8s-stack.sh down); the
#                 lock is released all the same
#   --no-workarounds / --forward / --allow-crd-drift   passed to `k8s-stack.sh up` (see its --help)
#   anything after `--` goes to driver/e2e.py (e.g. -- --scenario a,d)
#
# Writes reports/k8s-<UTC time>.json and reports/k8s-<UTC time>-logs/ (every container's
# log, events, descriptions, the unit pods' logs, post-run.json). Exit code: the driver's
# (0 all pass, 1 a scenario failed, 2 setup failed), 3 if the deployment did not come up,
# 4 if the post-run check failed (a unit pod left behind, or a refusal probe that ext-authz
# did not refuse), 5 if the time limit was reached, 64 for a usage error.
set -euo pipefail
SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S="$SCE_HOME/stack/k8s-stack.sh"

keep=false; images="ghcr.io/apache/latest"; label=""; port="${SCE_K8S_PORT:-30080}"
lock="${SCE_STACK_LOCK:-}"; no_lock=false; limit_min="${SCE_K8S_TIME_LIMIT:-50}"
source_args=(); driver_args=(); up_args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep) keep=true ;;
        --images) images="$2"; shift ;;
        --source) source_args=(--source "$2"); shift ;;
        --port) port="$2"; shift ;;
        --label) label="$2"; shift ;;
        --lock) lock="$2"; shift ;;
        --no-lock) no_lock=true ;;
        --time-limit) limit_min="$2"; shift ;;
        --) shift; driver_args=("$@"); break ;;
        --no-workarounds|--allow-crd-drift) up_args+=("$1") ;;
        --forward) up_args+=(--forward "$2"); shift ;;
        -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1 (see --help)" >&2; exit 64 ;;
    esac
    shift
done
if [[ -z "$lock" ]] && ! $no_lock; then
    echo "run-k8s.sh starts with \`down\` and shares the Docker VM with other stacks: pass --lock <dir>" >&2
    echo "(the stack lock, see the README) or set SCE_STACK_LOCK; --no-lock only where nothing else deploys" >&2
    exit 64
fi
if ! [[ "$limit_min" =~ ^[0-9]+$ ]] || (( limit_min < 5 )); then
    echo "--time-limit takes whole minutes, at least 5 (got '$limit_min')" >&2
    exit 64
fi
[[ -n "$label" ]] || label="k8s images=$images"
keep_unit=false
for x in ${driver_args[@]+"${driver_args[@]}"}; do [[ "$x" == "--keep-unit" ]] && keep_unit=true; done

# ------------------------------------------------------------------ lock and clock
have_lock=false; lock_t0=0; deployed=false; follower=""; watchdog=""; cur=""; timed_out=false

kill_tree() {  # stop a step and everything it started (helm, kubectl, the driver)
    local pid=$1 child
    kill -STOP "$pid" 2>/dev/null || true
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
    kill -TERM "$pid" 2>/dev/null || true
    kill -CONT "$pid" 2>/dev/null || true
}

run_step() {  # a long step, run in the background so a signal can interrupt the wait for it
    if $timed_out; then exit 5; fi  # the limit passed during a short foreground command
    "$@" &
    cur=$!
    local rc=0
    wait "$cur" || rc=$?
    if $timed_out; then
        kill_tree "$cur"
        wait "$cur" 2>/dev/null || true
        cur=""
        exit 5
    fi
    cur=""
    return "$rc"
}

on_time_limit() {
    timed_out=true
    echo "[run-k8s] TIME LIMIT: ${limit_min} min since the lock was taken; stopping the run" >&2
}

on_signal() {
    echo "[run-k8s] interrupted; cleaning up" >&2
    if [[ -n "$cur" ]]; then kill_tree "$cur"; wait "$cur" 2>/dev/null || true; fi
    exit 130
}

finish() {
    local rc=$?
    set +e
    trap '' INT TERM USR1  # the cleanup below runs to the end; the lock is released last
    if [[ -n "$watchdog" ]]; then kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null; fi
    if [[ -n "$follower" ]]; then kill "$follower" 2>/dev/null; wait "$follower" 2>/dev/null; fi
    if $deployed; then
        "$K8S" collect-logs "$logs" >/dev/null 2>&1 &
        wait $! && echo "[run-k8s] logs in $logs"
    fi
    if ! $keep; then
        echo "[run-k8s] taking the deployment down; pass --keep to leave it up"
        "$K8S" down &
        wait $!
    else
        echo "[run-k8s] --keep: deployment left running at http://127.0.0.1:$port (stack/k8s-stack.sh down to remove)"
    fi
    if $have_lock; then
        rm -rf "$lock"
        echo "[run-k8s] lock released after $(( ($(date +%s) - lock_t0) / 60 )) min"
    fi
    exit "$rc"
}
trap finish EXIT
trap on_signal INT TERM
trap on_time_limit USR1

if [[ -n "$lock" ]]; then
    echo "[run-k8s] waiting for the lock $lock ($(cat "$lock/owner" 2>/dev/null || echo 'free'))"
    until mkdir "$lock" 2>/dev/null; do sleep 30; done
    have_lock=true
    echo "harness-k8s run-k8s.sh pid $$ $(date)" > "$lock/owner"
    echo "[run-k8s] lock taken"
fi
lock_t0=$(date +%s)
main_pid=$$
( sleep $((limit_min * 60)) & sp=$!
  trap 'kill $sp 2>/dev/null; exit 0' TERM
  wait $sp && kill -USR1 "$main_pid" ) &
watchdog=$!
echo "[run-k8s] time limit ${limit_min} min (until $(date -r $((lock_t0 + limit_min * 60)) +%H:%M:%S))"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
report="$SCE_HOME/reports/k8s-$stamp.json"
logs="$SCE_HOME/reports/k8s-$stamp-logs"
mkdir -p "$SCE_HOME/reports"

# ------------------------------------------------------------------------- run
echo "[run-k8s] clean start: removing any previous deployment"
run_step "$K8S" down

echo "[run-k8s] deploying images $images"
deployed=true
mkdir -p "$logs"
# What ran: the harness commit and any uncommitted change in it. A `git archive` copy has
# no .git; it can name its commit in .harness-commit.
commit="$(git -C "$SCE_HOME" rev-parse HEAD 2>/dev/null || cat "$SCE_HOME/.harness-commit" 2>/dev/null \
    || echo 'unknown (not a git checkout)')"
changes="$(git -C "$SCE_HOME" status --porcelain 2>/dev/null || true)"
printf 'harness: %s\n%s\n' "$commit" "$changes" > "$logs/harness-git.txt"
if ! run_step "$K8S" ${source_args[@]+"${source_args[@]}"} up --images "$images" --port "$port" \
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
rc=0
run_step "$SCE_HOME/driver/run.sh" --target k8s --base "http://127.0.0.1:$port" --report "$report" \
    --label "$label" --stack-manifest "$SCE_HOME/stack/k8s/generated/MANIFEST.json" \
    ${driver_args[@]+"${driver_args[@]}"} || rc=$?

# The driver terminated its unit: its pod must go away, and its refusal probes must be
# ext-authz's (Envoy's access log). The outcome goes into the report and post-run.json.
post_rc=0
post_args=(--out "$logs/post-run.json")
$keep_unit && post_args+=(--unit-kept)
run_step "$K8S" post-run "$report" "${post_args[@]}" || post_rc=$?
echo "[run-k8s] driver exit code $rc; post-run $( ((post_rc == 0)) && echo ok || echo "FAIL (exit $post_rc)" ); report $report"
if (( rc == 0 && post_rc != 0 )); then rc=4; fi
exit "$rc"
