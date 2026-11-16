#!/usr/bin/env bash
# run-negative-control.sh -- the step-2 negative control (design section 7 H5): on
# the published images the old unit must FAIL Checks A, D and F.
#
#   ./run-negative-control.sh [--keep] [--reset] [--images <registry>/<tag>]
#                             [--source <worktree>] [-- <driver args>]
#
# 1. stack up with --pg-statement-log --isolate-unit (published images by default)
# 2. log in as texera and take its token
# 3. stack up again with --unit-env USER_JWT_TOKEN=<token>: the unit is recreated
#    and reads datasets through file-service (the K8s path), which it cannot reach
# 4. run scenario a over `ws` with --negative-control: the report records "controls
#    failed as expected", or the run fails (a control that passes proves nothing)
# 5. stack down (volumes kept) unless --keep
#
# Take the shared stack lock before running this (see the README).
# Exit code: the driver's (0 controls failed as expected), 3 if the stack did not come up.
set -euo pipefail
SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="$SCE_HOME/stack/sce-stack.sh"

keep=false; reset=false; images="ghcr.io/apache/latest"; source_args=(); driver_args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep) keep=true ;;
        --reset) reset=true ;;
        --images) images="$2"; shift ;;
        --source) source_args=(--source "$2"); shift ;;
        --) shift; driver_args=("$@"); break ;;
        -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1 (see --help)" >&2; exit 64 ;;
    esac
    shift
done

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

opts=(--pg-statement-log --isolate-unit)
if $reset; then "$STACK" reset; fi
echo "[negative-control] stack up with $images ${opts[*]}"
if ! "$STACK" ${source_args[@]+"${source_args[@]}"} up --images "$images" "${opts[@]}"; then
    echo "[negative-control] stack did not come up" >&2; exit 3
fi
token="$("$SCE_HOME/driver/run.sh" --print-token)"
[[ "$token" == *.*.* ]] || { echo "[negative-control] no token from the login" >&2; exit 3; }
echo "[negative-control] recreating the unit with USER_JWT_TOKEN (texera's token)"
if ! "$STACK" ${source_args[@]+"${source_args[@]}"} up --images "$images" "${opts[@]}" \
        --unit-env "USER_JWT_TOKEN=$token"; then
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
