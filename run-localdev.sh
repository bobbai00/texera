#!/usr/bin/env bash
# run-localdev.sh -- the e2e scenarios against Texera run the way bin/local-dev.sh runs it:
# take the stack lock, start clean, bring up local-dev's infrastructure (in Docker, renamed,
# shifted ports), the JVM services as host processes from the source worktree's dists and
# the Angular dev server; run every scenario through the dev server's proxy on local-dev's
# local computing unit; check every service survived; take everything down again unless
# --keep; release the lock. The run is bounded in time.
#
#   ./run-localdev.sh --lock <dir> [--source <worktree>] [--reset] [--keep] [--label <text>]
#                     [--time-limit MIN] [--python PY] [--heap NAME=SIZE ...] [--strict-schema]
#                     [--allow-stale-dists] [-- <driver args>]
#   ./run-localdev.sh --no-lock ...
#
#   --lock        the stack lock: a directory taken with mkdir (waiting while another run holds
#                 it) and removed at the end; also $SCE_STACK_LOCK. Required: the run starts with
#                 `down` and shares the Docker VM with the other stacks. --no-lock only on a
#                 machine where nothing else deploys
#   --time-limit  minutes from taking the lock to the end of the run (default 40, or
#                 $SCE_LOCALDEV_TIME_LIMIT). At the limit the running step is stopped and the stack
#                 taken down (under a minute; --keep or not), exit 5, so the lock is held under 45
#                 minutes
#   --source      the worktree that is built and run (default $SCE_LOCALDEV_SOURCE or
#                 texera-worktrees/sce-localdev-src). Its dist zips are built with `sbt dist` only
#                 when missing; build them beforehand (stack/localdev-stack.sh build) to keep the
#                 lock short
#   --reset       start from empty volumes (`reset` instead of `down` first)
#   --keep        leave the stack running afterwards (default: down, volumes kept). The lock stays
#                 held with it: `stack/localdev-stack.sh down`, then removing the lock, is the
#                 caller's job (the shared rule: within 45 minutes of taking it)
#   --python, --heap, --strict-schema, --allow-stale-dists   passed to `localdev-stack.sh up`
#                 (see its --help). --strict-schema stops the run where `bin/local-dev.sh up` stops
#                 when local-dev's schema step fails (exit 3); without it the run goes on and the
#                 report lists the deviation (summary.local_dev_deviations)
#   anything after `--` goes to driver/e2e.py (e.g. -- --scenario a,d)
#
# Writes reports/localdev-<UTC time>.json and reports/localdev-<UTC time>-logs/ (every service's
# log, the infrastructure's container logs, the stack manifest, local-dev's schema step,
# harness-git.txt, post-run.json). Exit code: the driver's (0 all pass, 1 a scenario failed, 2
# setup failed), 3 if the stack did not come up, 4 if the post-run check failed (a service died
# or stopped answering during the run), 5 if the time limit was reached, 64 for a usage error.
set -euo pipefail
SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="$SCE_HOME/stack/localdev-stack.sh"

keep=false; reset=false; label=""; lock="${SCE_STACK_LOCK:-}"; no_lock=false
limit_min="${SCE_LOCALDEV_TIME_LIMIT:-40}"
source_args=(); up_args=(); driver_args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep) keep=true ;;
        --reset) reset=true ;;
        --source) source_args=(--source "$2"); shift ;;
        --label) label="$2"; shift ;;
        --lock) lock="$2"; shift ;;
        --no-lock) no_lock=true ;;
        --time-limit) limit_min="$2"; shift ;;
        --python) up_args+=(--python "$2"); shift ;;
        --heap) up_args+=(--heap "$2"); shift ;;
        --strict-schema|--allow-stale-dists) up_args+=("$1") ;;
        --) shift; driver_args=("$@"); break ;;
        -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1 (see --help)" >&2; exit 64 ;;
    esac
    shift
done
if [[ -z "$lock" ]] && ! $no_lock; then
    echo "run-localdev.sh starts with \`down\` and shares the Docker VM with other stacks: pass --lock <dir>" >&2
    echo "(the stack lock, see the README) or set SCE_STACK_LOCK; --no-lock only where nothing else deploys" >&2
    exit 64
fi
if ! [[ "$limit_min" =~ ^[0-9]+$ ]] || (( limit_min < 5 )); then
    echo "--time-limit takes whole minutes, at least 5 (got '$limit_min')" >&2
    exit 64
fi
[[ -n "$label" ]] || label="localdev"

# ------------------------------------------------------------------ lock and clock
# started: the lock is held (or --no-lock); before that nothing may be cleaned up, since a
# stack of this project would be another run's.
started=false; have_lock=false; lock_t0=0; watchdog=""; cur=""; timed_out=false; brought_up=false

kill_tree() {  # stop a step and everything it started
    local pid=$1 child
    kill -STOP "$pid" 2>/dev/null || true
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
    kill -TERM "$pid" 2>/dev/null || true
    kill -CONT "$pid" 2>/dev/null || true
}

run_step() {  # a long step, in the background so a signal can interrupt the wait for it
    if $timed_out; then exit 5; fi
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
    echo "[run-localdev] TIME LIMIT: ${limit_min} min since the lock was taken; stopping the run" >&2
}

on_signal() {
    echo "[run-localdev] interrupted; cleaning up" >&2
    if [[ -n "$cur" ]]; then kill_tree "$cur"; wait "$cur" 2>/dev/null || true; fi
    exit 130
}

finish() {
    local rc=$?
    set +e
    trap '' INT TERM USR1  # the cleanup below runs to the end; the lock is released last
    if ! $started; then
        echo "[run-localdev] stopped before taking the lock; nothing was started or removed"
        exit "$rc"
    fi
    if [[ -n "$watchdog" ]]; then kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null; fi
    if $brought_up; then
        "$STACK" collect-logs "$logs" >/dev/null 2>&1 &
        wait $!
    fi
    local kept=false
    if $keep && ! $timed_out; then kept=true; fi
    if ! $kept; then
        if $keep; then echo "[run-localdev] time limit reached: --keep does not apply; taking the stack down"; fi
        echo "[run-localdev] taking the stack down (volumes kept); pass --keep to leave it up"
        "$STACK" down --no-collect &
        wait $!
    else
        echo "[run-localdev] --keep: stack left running at http://localhost:4200"
    fi
    if $have_lock; then
        if $kept; then
            # the stack still holds the ports and the Docker VM: the lock stays with it
            echo "harness-localdev run-localdev.sh --keep: stack left running since $(date); the holder runs" \
                 "stack/localdev-stack.sh down, then removes this lock" >> "$lock/owner"
            echo "[run-localdev] --keep: the lock $lock stays held while the stack runs. When done:"
            echo "[run-localdev]   stack/localdev-stack.sh down && rm -rf $lock"
            echo "[run-localdev] (the shared rule: at most 45 minutes from taking it, i.e. by" \
                 "$(date -r $((lock_t0 + 45 * 60)) +%H:%M:%S))"
        else
            rm -rf "$lock"
            echo "[run-localdev] lock released after $(( ($(date +%s) - lock_t0) / 60 )) min"
        fi
    fi
    exit "$rc"
}
trap finish EXIT
trap on_signal INT TERM
trap on_time_limit USR1

if [[ -n "$lock" ]]; then
    echo "[run-localdev] waiting for the lock $lock ($(cat "$lock/owner" 2>/dev/null || echo 'free'))"
    until mkdir "$lock" 2>/dev/null; do sleep 30; done
    have_lock=true
    echo "harness-localdev run-localdev.sh pid $$ $(date)" > "$lock/owner"
    echo "[run-localdev] lock taken"
fi
started=true
lock_t0=$(date +%s)
main_pid=$$
( sleep $((limit_min * 60)) & sp=$!
  trap 'kill $sp 2>/dev/null; exit 0' TERM
  wait $sp && kill -USR1 "$main_pid" ) &
watchdog=$!
echo "[run-localdev] time limit ${limit_min} min (until $(date -r $((lock_t0 + limit_min * 60)) +%H:%M:%S))"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
report="$SCE_HOME/reports/localdev-$stamp.json"
logs="$SCE_HOME/reports/localdev-$stamp-logs"
mkdir -p "$logs"
commit="$(git -C "$SCE_HOME" rev-parse HEAD 2>/dev/null || cat "$SCE_HOME/.harness-commit" 2>/dev/null \
    || echo 'unknown (not a git checkout)')"
changes="$(git -C "$SCE_HOME" status --porcelain 2>/dev/null || true)"
printf 'harness: %s\n%s\n' "$commit" "$changes" > "$logs/harness-git.txt"

# ------------------------------------------------------------------------- run
if $reset; then
    echo "[run-localdev] clean start: stopping any previous local-dev stack and removing its volumes"
    run_step "$STACK" reset --no-collect
else
    echo "[run-localdev] clean start: stopping any previous local-dev stack (volumes kept)"
    run_step "$STACK" down --no-collect
fi

echo "[run-localdev] bringing the local-dev stack up"
brought_up=true
if ! run_step "$STACK" ${source_args[@]+"${source_args[@]}"} up --logs "$logs" ${up_args[@]+"${up_args[@]}"}; then
    echo "[run-localdev] the stack did not come up" >&2
    "$STACK" status || true
    exit 3
fi
"$STACK" status

echo "[run-localdev] running the e2e driver against the dev server (http://localhost:4200)"
rc=0
run_step "$SCE_HOME/driver/run.sh" --target localdev --report "$report" --label "$label" \
    --stack-manifest "$SCE_HOME/stack/localdev/generated/MANIFEST.json" \
    ${driver_args[@]+"${driver_args[@]}"} || rc=$?

post_rc=0
run_step "$STACK" post-run "$report" --out "$logs/post-run.json" || post_rc=$?
echo "[run-localdev] driver exit code $rc; post-run $( ((post_rc == 0)) && echo ok || echo "FAIL (exit $post_rc)" ); report $report"
if (( rc == 0 && post_rc != 0 )); then rc=4; fi
exit "$rc"
