#!/usr/bin/env bash
# record-bench.sh -- the day-long benchmark of an execution's record (step 3 design,
# section H7, layer 1): bring up a throwaway lake (stack.sh), run ExecutionRecordBench
# through sbt in a worktree against it, print one PASS/FAIL line per check, and take
# the lake down again.
#
#   bench/record-bench.sh <worktree> [--quick] [--env <file>] [--no-lake] [-- <bench options>]
#
#   <worktree>  a Texera worktree that has ExecutionRecordBench (step 3, sub-part 7)
#   --quick     120 ticks instead of a day's 2,880: about 2 minutes instead of about 15
#   --env FILE  source FILE before sbt runs. sbt generates the jOOQ classes from a
#               Postgres at build time, read from STORAGE_JDBC_URL, _USERNAME and
#               _PASSWORD (default: texera_db on localhost:5432); a worktree with a
#               database of its own names it in such a file. The lake's settings are
#               applied after it, so they win.
#   --no-lake   bring no lake up: run against the catalog the environment (and --env)
#               names, such as the build's Postgres catalog. That shows that the record
#               is whole; its times say nothing about a deployment.
#   anything after `--` goes to the bench (e.g. -- --ticks 600 --operators 20)
#
# The run's files go to bench/reports/record-bench-<UTC time>/: checks.txt (the
# PASS/FAIL lines), checkpoints.csv, ticks.csv, and sbt-output.txt.
#
# Exit code: 0 every check passed; 1 the bench ran and a check failed; 2 the lake, sbt
# or the teardown failed.
set -uo pipefail
BENCH_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="$BENCH_HOME/stack.sh"
MAIN=org.apache.texera.amber.engine.common.executionrecord.ExecutionRecordBench
SOURCE=amber/src/test/scala/org/apache/texera/amber/engine/common/executionrecord/ExecutionRecordBench.scala

worktree=""; env_file=""; lake=true; bench_args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --quick) bench_args+=(--quick) ;;
        --env) env_file="${2:?--env needs a file}"; shift ;;
        --no-lake) lake=false ;;
        --) shift; bench_args+=("$@"); break ;;
        -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "unknown option: $1 (see --help)" >&2; exit 64 ;;
        *) [[ -z "$worktree" ]] || { echo "one worktree, not also $1" >&2; exit 64; }
           worktree="$1" ;;
    esac
    shift
done
[[ -n "$worktree" ]] || { echo "usage: $0 <worktree> [--quick] [--env <file>] [--no-lake] [-- <bench options>]" >&2; exit 64; }
worktree="$(cd "$worktree" 2>/dev/null && pwd)" || { echo "no such worktree" >&2; exit 64; }
[[ -f "$worktree/$SOURCE" ]] || { echo "$worktree has no $SOURCE" >&2; exit 64; }
[[ -z "$env_file" || -f "$env_file" ]] || { echo "no such file: $env_file" >&2; exit 64; }

out="$BENCH_HOME/reports/record-bench-$(date -u +%Y%m%dT%H%M%SZ)"
# A directory of this run alone: the verdict is read from the checks.txt in it.
[[ ! -e "$out" ]] || out="$out-$$"
# The directory is one word of sbt's runMain command.
[[ "$out" != *[[:space:]]* ]] || { echo "the harness's path has a space in it: $out" >&2; exit 64; }
mkdir -p "$BENCH_HOME/reports" && mkdir "$out" || exit 2

lake_up=false
teardown() {
    $lake_up || return 0
    lake_up=false
    echo "[record-bench] taking the lake down"
    if ! "$STACK" down; then
        echo "[record-bench] the lake was not removed cleanly" >&2
        return 1
    fi
}
# However the script ends, the lake goes with it.
trap teardown EXIT
trap 'exit 130' INT TERM

if $lake; then
    echo "[record-bench] bringing the lake up"
    # A run that was killed may have left its lake behind.
    "$STACK" down || exit 2
    lake_up=true
    if ! "$STACK" up; then
        teardown
        exit 2
    fi
fi

if [[ -n "$env_file" ]]; then
    # The file is not held to this script's `set -u`.
    set +u
    # shellcheck disable=SC1090
    source "$env_file" || { echo "[record-bench] $env_file failed" >&2; exit 2; }
    set -u
fi
if $lake; then eval "$("$STACK" env)"; fi
if [[ -z "${STORAGE_JDBC_URL:-}" ]]; then
    echo "[record-bench] STORAGE_JDBC_URL is not set: sbt generates the jOOQ classes from texera_db on localhost:5432"
fi

echo "[record-bench] sbt WorkflowExecutionService/Test/runMain $MAIN --out $out ${bench_args[*]-}"
echo "[record-bench] in $worktree, catalog ${STORAGE_ICEBERG_CATALOG_TYPE:-as storage.conf says}; sbt's output: $out/sbt-output.txt"
started=$(date +%s)
# The bench's own lines, as they come; everything else is in the file. sbt exits with what
# the bench exits with (0, 1 or 2), and with 1 when the build fails.
(cd "$worktree" && sbt -batch "WorkflowExecutionService/Test/runMain $MAIN --out $out ${bench_args[*]-}") 2>&1 |
    tee "$out/sbt-output.txt" |
    grep --line-buffered -E '^(catalog |warm-up: |tick +[0-9]+ |[0-9]+ ticks in |WARN |ERROR )'
code=${PIPESTATUS[0]}
echo "[record-bench] sbt exited with $code after $(($(date +%s) - started)) s"

teardown || code=2

echo "== checks ($out/checks.txt)"
checks=0
[[ -f "$out/checks.txt" ]] && checks=$(grep -cE '^(PASS|FAIL) ' "$out/checks.txt")
if [[ "$checks" -gt 0 ]]; then
    cat "$out/checks.txt"
    echo "== $(grep -c '^PASS ' "$out/checks.txt") passed, $(grep -c '^FAIL ' "$out/checks.txt") failed"
else
    # sbt also exits with 1 when the build fails: without a check the bench did not run.
    echo "the bench wrote no check: see the end of $out/sbt-output.txt" >&2
    tail -n 30 "$out/sbt-output.txt" >&2
    code=2
fi
exit "$code"
