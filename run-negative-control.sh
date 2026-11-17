#!/usr/bin/env bash
# run-negative-control.sh -- the negative controls (section 7 H5 of the step-2 and of the
# step-3 design): the checks that say a new unit is right must FAIL on an old one, each
# for its own reason. A control that passes, or fails for another reason, proves nothing.
#
#   ./run-negative-control.sh [--step 2|3] [--keep] [--reset] [--images <registry>/<tag>]
#                             [--source <worktree>] [-- <driver args>]
#
# --step 2 (the default), on the published images: the old unit must FAIL Checks A, D and F.
# 1. stack up with --pg-statement-log --isolate-unit (published images by default)
# 2. log in as texera and take its token
# 3. stack up again with --unit-env USER_JWT_TOKEN=<token>: the unit is recreated
#    and reads datasets through file-service (the K8s path), which it cannot reach
# 4. run scenario a over `ws` with --negative-control: the report records "controls
#    failed as expected", or the run fails (a control that passes proves nothing)
# 5. stack down (volumes kept) unless --keep
#
# --step 3, once per gate 3C, on the images of step 2's last sub-part (--images is required:
# its unit still writes its status to Postgres and boots with a pool):
# 1. stack up with --pg-statement-log --isolate-unit --fast-record
# 2. run scenarios a and q over `create-ws` with --negative-control 3: Check G must fail on
#    the unit's status UPDATEs and Check H on its idle pool, and q's execution must stay at
#    status 1 past the deadline by which step 3's Dashboard closes it "unit lost"
# 3. stack down, then up again with --unit-no-postgres --expect-unit-down: every service but
#    the unit comes up; the unit must not become healthy, and its log must say Postgres is why
#    (the verdict goes to reports/negative-control-<time>-unit.json)
# 4. stack down (volumes kept) unless --keep
#
# Take the shared stack lock before running this (see the README).
# Exit code: the driver's (0 controls failed as expected; with --step 3 also 1 when the unit
# came up without Postgres or stayed down for another reason), 3 if the stack did not come up.
set -euo pipefail
SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="$SCE_HOME/stack/sce-stack.sh"

keep=false; reset=false; images=""; step=2; source_args=(); driver_args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep) keep=true ;;
        --reset) reset=true ;;
        --step) step="$2"; shift ;;
        --images) images="$2"; shift ;;
        --source) source_args=(--source "$2"); shift ;;
        --) shift; driver_args=("$@"); break ;;
        -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1 (see --help)" >&2; exit 64 ;;
    esac
    shift
done
case "$step" in
    2) images="${images:-ghcr.io/apache/latest}" ;;
    3) [[ -n "$images" ]] || { echo "--step 3 runs against the images of step 2's last sub-part: pass --images <registry>/<tag>" >&2; exit 64; } ;;
    *) echo "--step takes 2 or 3 (got '$step')" >&2; exit 64 ;;
esac

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
report="$SCE_HOME/reports/negative-control-$stamp.json"
mkdir -p "$SCE_HOME/reports"

finish() {
    local rc=$?
    if ! $keep; then
        echo "[negative-control] taking the stack down (volumes kept)"
        "$STACK" down || true
    fi
    exit "$rc"
}
trap finish EXIT

up() {  # the stack with the control's options, plus what is given
    "$STACK" ${source_args[@]+"${source_args[@]}"} up --images "$images" "${opts[@]}" "$@"
}

if [[ "$step" == 3 ]]; then
    opts=(--pg-statement-log --isolate-unit --fast-record)
    if $reset; then "$STACK" reset; fi
    echo "[negative-control] stack up with $images ${opts[*]}"
    if ! up; then
        echo "[negative-control] stack did not come up" >&2; exit 3
    fi
    "$STACK" status

    set +e
    "$SCE_HOME/driver/run.sh" --transport create-ws --scenario a,q --negative-control 3 \
        --report "$report" --label "negative control of step 3: images=$images ${opts[*]}" \
        --stack-manifest "$SCE_HOME/stack/generated/MANIFEST.json" ${driver_args[@]+"${driver_args[@]}"}
    rc=$?
    set -e
    echo "[negative-control] driver exit code $rc; report $report"

    echo "[negative-control] the same stack with --unit-no-postgres: the unit must not become healthy"
    "$STACK" down
    unit_report="${report%.json}-unit.json"
    set +e
    up --unit-no-postgres --expect-unit-down | tee "$unit_report.log"
    unit_rc=${PIPESTATUS[0]}
    set -e
    tail -n 1 "$unit_report.log" > "$unit_report"
    echo "[negative-control] the unit without Postgres: exit code $unit_rc; verdict $unit_report"
    if [[ $rc -eq 0 && $unit_rc -ne 0 ]]; then rc=1; fi
    exit "$rc"
fi

opts=(--pg-statement-log --isolate-unit)
if $reset; then "$STACK" reset; fi
echo "[negative-control] stack up with $images ${opts[*]}"
if ! up; then
    echo "[negative-control] stack did not come up" >&2; exit 3
fi
token="$("$SCE_HOME/driver/run.sh" --print-token)"
[[ "$token" == *.*.* ]] || { echo "[negative-control] no token from the login" >&2; exit 3; }
echo "[negative-control] recreating the unit with USER_JWT_TOKEN (texera's token)"
if ! up --unit-env "USER_JWT_TOKEN=$token"; then
    echo "[negative-control] stack did not come up with the token" >&2; exit 3
fi
"$STACK" status

set +e
"$SCE_HOME/driver/run.sh" --transport ws --scenario a --negative-control \
    --report "$report" --label "negative control: images=$images ${opts[*]} USER_JWT_TOKEN" \
    --stack-manifest "$SCE_HOME/stack/generated/MANIFEST.json" ${driver_args[@]+"${driver_args[@]}"}
rc=$?
set -e
echo "[negative-control] driver exit code $rc; report $report"
exit "$rc"
