#!/usr/bin/env bash
# suite.sh <worktree> <tag> [catalog-db]
# Runs the Scala suites of a worktree one after another and writes one line per suite to
# <scratch>/suite-<tag>.summary; full logs go next to it. Needs a Postgres with Texera's schema on SCE_PG_PORT (default 5432) or wherever STORAGE_JDBC_URL points.
WT="$1"; TAG="$2"; CATALOG_DB="${3:-}"
S=${SCE_WORK:-$HOME/.sce-work}
OUT=$S/suite-$TAG.summary; : > "$OUT"
PY=${UDF_PYTHON_PATH:-$S/py311/bin/python}
cd "$WT" || exit 9
export STORAGE_ICEBERG_CATALOG_TYPE=postgres
# Specs that check generated Python against a real interpreter cancel themselves unless
# `python3` on PATH has pandas and plotly: the engine venv has both.
export PATH="$(dirname "$PY"):$PATH"
[ -n "$CATALOG_DB" ] && export STORAGE_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME="localhost:${SCE_PG_PORT:-5432}/$CATALOG_DB"
say() { echo "$(date +%H:%M:%S) $*" >> "$OUT"; }
run() { # run <name> <env assignments...> -- <sbt args...>
  local name="$1"; shift; local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  local log="$S/suite-$TAG-$name.log"
  env "${envs[@]}" sbt -Dsbt.supershell=false "$@" > "$log" 2>&1; local rc=$?
  say "$name: exit $rc"
  grep -E "Tests: succeeded|\*\*\* FAILED \*\*\*|\*\*\* ABORTED \*\*\*|Failed tests:|Error during tests:|^\[error\] .*(Spec|Test)\b|Passed: Total|Failed: Total" "$log" \
    | sed -E 's/\x1b\[[0-9;]*m//g' | cut -c1-230 | sort | uniq -c | sort -rn | head -40 >> "$OUT"
}
say "worktree $WT at $(git rev-parse --short HEAD) $(git status --porcelain --untracked-files=no | wc -l | tr -d ' ') modified"
run common -- "Config/test" "DAO/test" "WorkflowCore/test" "WorkflowOperator/test" "WorkflowCompiler/test"
run services WCS_TEST_FILTER=skip-integration -- "WorkflowCompilingService/test" "AccessControlService/test" "ComputingUnitManagingService/test" "ConfigService/test" "FileService/test"
run amber-unit AMBER_TEST_FILTER=skip-integration -- "WorkflowExecutionService/test"
run amber-integration AMBER_TEST_FILTER=integration-only "UDF_PYTHON_PATH=$PY" -- "WorkflowExecutionService/test"
say "DONE"
