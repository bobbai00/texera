#!/usr/bin/env bash
# run-browser-smoke.sh -- the browser smoke (driver/browser_smoke.py) on a single-node
# stack: bring the stack up on a set of images, drive the real workflow editor in
# headless Chromium, run API scenario(s) on the same stack as a sanity check, and take
# the stack down again unless --keep.
#
#   ./run-browser-smoke.sh --images <registry>/<tag> [--source <worktree>] [--reset] [--keep]
#                          [--lock <dir>] [--api-scenario a,d | --no-api-scenario]
#                          [--label <text>] [-- <browser_smoke.py args>]
#
#   --images        the images to run; they must hold the frontend that creates an execution
#                   and then starts it (images/build.sh --frontend, step 2's PR B on). The
#                   published images' frontend sends WorkflowExecuteRequest instead
#   --source        the worktree whose deployment files the stack is generated from (default:
#                   sce-stack.sh's). Use the worktree the images were built from
#   --reset         start from empty volumes (sce-stack.sh reset first)
#   --keep          leave the stack running afterwards (default: sce-stack.sh down, volumes
#                   kept). With --lock the lock stays held too: `stack/sce-stack.sh down`,
#                   then removing the lock, is then the caller's job
#   --lock          the stack lock (README, "One run at a time"): a directory taken with
#                   mkdir, waiting while another run holds it, and removed at the end; also
#                   $SCE_STACK_LOCK. Without it the caller must already hold the lock
#   --api-scenario  the driver's scenarios run after the smoke, on the create-ws transport
#                   (default a); --no-api-scenario skips them
#   anything after `--` goes to driver/browser_smoke.py (e.g. -- --case B1,B3)
#
# Writes reports/browser-smoke-<UTC time>/: report.json, a screenshot (or more) per case,
# and api-scenarios.json. Exit code: the smoke's (0 all pass, 1 a case failed, 2 setup
# failed), 3 if the stack did not come up, 4 if the smoke passed and an API scenario
# failed, 64 for a usage error.
set -euo pipefail
SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="$SCE_HOME/stack/sce-stack.sh"

keep=false; reset=false; images=""; label=""; lock="${SCE_STACK_LOCK:-}"; api_scenarios="a"
source_args=(); smoke_args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep) keep=true ;;
        --reset) reset=true ;;
        --images) images="$2"; shift ;;
        --source) source_args=(--source "$2"); shift ;;
        --label) label="$2"; shift ;;
        --lock) lock="$2"; shift ;;
        --api-scenario) api_scenarios="$2"; shift ;;
        --no-api-scenario) api_scenarios="" ;;
        --) shift; smoke_args=("$@"); break ;;
        -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1 (see --help)" >&2; exit 64 ;;
    esac
    shift
done
if [[ -z "$images" ]]; then
    echo "--images <registry>/<tag> is required: the smoke needs a frontend built from step 2's PR B on" >&2
    echo "(images/build.sh --frontend <worktree> <tag>, then --images sce/<tag>)" >&2
    exit 64
fi
[[ -n "$label" ]] || label="images=$images"

# shellcheck source=lib/venv.sh
source "$SCE_HOME/lib/venv.sh"
# Chromium for the venv's Playwright; nothing is downloaded when it is already there.
"$SCE_PY" -m playwright install chromium >&2

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$SCE_HOME/reports/browser-smoke-$stamp"
mkdir -p "$out"

have_lock=false; started=false
finish() {
    local rc=$?
    if $started; then
        if ! $keep; then
            echo "[browser-smoke] taking the stack down (volumes kept); pass --keep to leave it up"
            "$STACK" down || true
        else
            echo "[browser-smoke] --keep: stack left running at http://localhost:8080 (stack/sce-stack.sh down to stop)"
        fi
    fi
    if $have_lock; then
        if $keep && $started; then
            echo "[browser-smoke] --keep: the stack lock $lock stays held; remove it after \`stack/sce-stack.sh down\`"
        else
            rm -rf "$lock"
            echo "[browser-smoke] stack lock released"
        fi
    fi
    exit "$rc"
}
trap finish EXIT

if [[ -n "$lock" ]]; then
    mkdir -p "$(dirname "$lock")"
    until mkdir "$lock" 2>/dev/null; do
        echo "[browser-smoke] the stack lock is held ($(cat "$lock/owner" 2>/dev/null || echo '?')); waiting"
        sleep 30
    done
    have_lock=true
    echo "run-browser-smoke.sh $(date) pid $$" >"$lock/owner"
    echo "[browser-smoke] stack lock taken: $lock"
fi
started=true

if $reset; then
    echo "[browser-smoke] reset: removing sce containers and sce_* volumes"
    "$STACK" reset
fi
echo "[browser-smoke] stack up with images $images"
if ! "$STACK" ${source_args[@]+"${source_args[@]}"} up --images "$images"; then
    echo "[browser-smoke] stack did not come up" >&2
    "$STACK" status || true
    exit 3
fi

echo "[browser-smoke] driving the editor in headless Chromium"
set +e
"$SCE_PY" -u "$SCE_HOME/driver/browser_smoke.py" --out "$out" --label "$label" \
    --stack-manifest "$SCE_HOME/stack/generated/MANIFEST.json" ${smoke_args[@]+"${smoke_args[@]}"}
rc=$?
set -e
echo "[browser-smoke] smoke exit code $rc; report $out/report.json"

if [[ -n "$api_scenarios" ]]; then
    echo "[browser-smoke] API scenario(s) $api_scenarios on the same stack (create-ws)"
    set +e
    "$SCE_HOME/driver/run.sh" --transport create-ws --scenario "$api_scenarios" \
        --report "$out/api-scenarios.json" --label "$label (after the browser smoke)" \
        --stack-manifest "$SCE_HOME/stack/generated/MANIFEST.json"
    api_rc=$?
    set -e
    echo "[browser-smoke] API scenario exit code $api_rc; report $out/api-scenarios.json"
    if (( rc == 0 && api_rc != 0 )); then rc=4; fi
fi
exit "$rc"
