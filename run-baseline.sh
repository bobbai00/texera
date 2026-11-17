#!/usr/bin/env bash
# run-baseline.sh -- bring the sce stack up on a set of images, wait until it is
# healthy, run every e2e scenario, print the results, and take the stack down
# again unless --keep is given.
#
#   ./run-baseline.sh [--keep] [--reset] [--source <worktree>] [--images <registry>/<tag>]
#                     [--pg-statement-log] [--isolate-unit] [--with-replay-log] [--fast-record]
#                     [--unit-no-postgres] [--unit-env KEY=VAL ...] [--dashboard-env KEY=VAL ...]
#                     [--label <text>] [-- <driver args>]
#
#   --images   default ghcr.io/apache/latest (the published images); a branch
#              build from images/build.sh is sce/<tag>
#   --reset    start from empty volumes (sce-stack.sh reset first)
#   --keep     leave the stack running afterwards (default: sce-stack.sh down,
#              volumes kept)
#   --pg-statement-log, --isolate-unit, --with-replay-log, --fast-record,
#   --unit-no-postgres, --unit-env KEY=VAL, --dashboard-env KEY=VAL
#              stack options for the evidence checks, passed to `sce-stack.sh up`
#              (see the README); the driver's --evidence needs --pg-statement-log,
#              the step-3 gates need --fast-record, and gate 3C is run a second
#              time with --unit-no-postgres (Check J)
#   anything after `--` goes to driver/e2e.py (e.g. -- --scenario a,d)
#
# Exit code: the driver's (0 all pass, 1 a scenario failed, 2 setup failed),
# or 3 if the stack did not come up.
set -euo pipefail
SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="$SCE_HOME/stack/sce-stack.sh"

keep=false; reset=false; images="ghcr.io/apache/latest"; label=""; source_args=()
driver_args=(); stack_opts=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep) keep=true ;;
        --reset) reset=true ;;
        --images) images="$2"; shift ;;
        --source) source_args=(--source "$2"); shift ;;
        --label) label="$2"; shift ;;
        --pg-statement-log|--isolate-unit|--with-replay-log|--fast-record|--unit-no-postgres)
            stack_opts+=("$1") ;;
        --unit-env|--dashboard-env) stack_opts+=("$1" "$2"); shift ;;
        --) shift; driver_args=("$@"); break ;;
        -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1 (see --help)" >&2; exit 64 ;;
    esac
    shift
done
if [[ -z "$label" ]]; then
    label="images=$images"
    # the option names only: a --unit-env or --dashboard-env value may be a token
    for o in ${stack_opts[@]+"${stack_opts[@]}"}; do
        [[ "$o" == --* ]] && label+=" $o"
    done
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
report="$SCE_HOME/reports/baseline-$stamp.json"
mkdir -p "$SCE_HOME/reports"

finish() {
    local rc=$?
    if ! $keep; then
        echo "[run-baseline] taking the stack down (volumes kept); pass --keep to leave it up"
        "$STACK" down || true
    else
        echo "[run-baseline] --keep: stack left running at http://localhost:8080 (stack/sce-stack.sh down to stop)"
    fi
    exit "$rc"
}
trap finish EXIT

if $reset; then
    echo "[run-baseline] reset: removing sce containers and sce_* volumes"
    "$STACK" reset
fi

echo "[run-baseline] stack up with images $images"
if ! "$STACK" ${source_args[@]+"${source_args[@]}"} up --images "$images" ${stack_opts[@]+"${stack_opts[@]}"}; then
    echo "[run-baseline] stack did not come up" >&2
    "$STACK" status || true
    exit 3
fi
"$STACK" status

echo "[run-baseline] running the e2e driver"
set +e
"$SCE_HOME/driver/run.sh" --report "$report" --label "$label" \
    --stack-manifest "$SCE_HOME/stack/generated/MANIFEST.json" ${driver_args[@]+"${driver_args[@]}"}
rc=$?
set -e
echo "[run-baseline] driver exit code $rc; report $report"
exit "$rc"
