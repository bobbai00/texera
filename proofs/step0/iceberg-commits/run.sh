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

# Step 0 proof: "With the Java Iceberg client, committing on a timer and tidying the
# tables keep a day-long run fast to read."
#
# Brings up a lake (Lakekeeper + Postgres + RustFS, see stack.sh), runs the benchmark
# (IcebergCommitBench, in this repo's sbt build, on Texera's own Iceberg code), counts
# what each table left in the store, prints one PASS/FAIL line per check, and tears
# everything down. Raw output goes to raw/run-<UTC time>/ (checks.txt holds the
# PASS/FAIL lines).
#
# Usage: ./run.sh [--quick] [benchmark args, e.g. --commits 600]
#   --quick   a 2-minute smoke run (120 commits); the default is the full day (2,880).
# Needs: Docker, sbt + JDK 17, uv, and Postgres on localhost:5432 for jOOQ codegen.
# Exit status: 0 every check passed, 1 the proof ran but a check failed, 2 the harness
# itself failed (lake, benchmark or teardown).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
BENCH_REL=common/workflow-core/src/test/scala/org/apache/texera/amber/core/storage/result/iceberg/bench/IcebergCommitBench.scala
MAIN=org.apache.texera.amber.core.storage.result.iceberg.bench.IcebergCommitBench
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$HERE/raw/run-$STAMP"

ARGS=()
if [[ "${1:-}" == "--quick" ]]; then
  shift
  ARGS=(--commits 120 --checkpoint-every 50 --tidy-every 40 --warmup-commits 10 --tick-seconds 600)
fi
ARGS+=("$@")

PASSED=0
FAILED=0
HARNESS_FAILED=0
result() { # PASS|FAIL name evidence
  echo "$1 $2: $3" | tee -a "$OUT/checks.txt"
  if [[ "$1" == PASS ]]; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); fi
}
harness_fail() { # name evidence
  result FAIL "$1" "$2"
  HARNESS_FAILED=1
}

teardown() {
  "$HERE/stack.sh" down
  local left
  left="$(docker ps -a --filter name=sce0ice --format '{{.Names}}')$(docker volume ls --filter name=sce0ice --format '{{.Name}}')$(docker network ls --filter name=sce0ice --format '{{.Name}}')"
  if [[ -z "$left" ]]; then
    result PASS teardown_clean "no sce0ice container, volume or network left"
  else
    harness_fail teardown_clean "left behind: $(echo "$left" | tr '\n' ' ')"
  fi
}

license_header() {
  sed -n '2,17p' "$HERE/run.sh"
  echo
}

# Raw text goes into the repo: no home directory in it.
sanitize() {
  "$PY" -I -c 'import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text().replace(sys.argv[2], "<repo>").replace(sys.argv[3], "~"))' "$1" "$REPO" "$HOME"
}

trap 'echo "interrupted"; teardown; exit 130' INT TERM

mkdir -p "$OUT"
[[ -x "$HERE/.venv/bin/python" ]] || uv venv --quiet "$HERE/.venv"
PY="$HERE/.venv/bin/python"

# The benchmark lives in the sbt tree; this folder keeps a copy. Restore it if missing.
if [[ ! -f "$REPO/$BENCH_REL" ]]; then
  mkdir -p "$(dirname "$REPO/$BENCH_REL")"
  cp "$HERE/src/IcebergCommitBench.scala" "$REPO/$BENCH_REL"
elif ! cmp -s "$REPO/$BENCH_REL" "$HERE/src/IcebergCommitBench.scala"; then
  echo "note: $BENCH_REL differs from src/IcebergCommitBench.scala; running the sbt-tree copy"
fi

echo "== clean state, then the lake"
"$HERE/stack.sh" down
if "$HERE/stack.sh" up; then
  result PASS lake_up "Lakekeeper $("$HERE/stack.sh" info | "$PY" -I -c 'import json,sys; print(json.load(sys.stdin)["version"])') + Postgres + RustFS, warehouse with remote signing"
else
  harness_fail lake_up "see the [stack] lines above"
  teardown
  exit 2
fi

echo "== benchmark (sbt WorkflowCore/Test/runMain $MAIN ${ARGS[*]:-}); output in ${OUT#"$REPO"/}"
eval "$("$HERE/stack.sh" env)"
START=$(date +%s)
(cd "$REPO" && sbt -batch "WorkflowCore/Test/runMain $MAIN --out $OUT ${ARGS[*]:-}") >"$OUT/sbt-output.txt" 2>&1
CODE=$?
ELAPSED=$(($(date +%s) - START))
if [[ $CODE -eq 0 && -f "$OUT/console.txt" ]]; then
  result PASS benchmark_ran "sbt exit 0 after ${ELAPSED}s"
else
  harness_fail benchmark_ran "sbt exit $CODE after ${ELAPSED}s; see ${OUT#"$HERE"/}/sbt-output.txt"
fi

echo "== what each table left in the store"
if [[ -f "$OUT/tables.csv" ]]; then
  echo "scenario,table,objects,bytes,data_files,data_bytes,manifests,manifest_lists,metadata_files,metadata_bytes" >"$OUT/objects.csv"
  tail -n +2 "$OUT/tables.csv" | while IFS=, read -r scenario table _id location _version; do
    echo "$scenario,$table,$("$HERE/stack.sh" objects "$location")" >>"$OUT/objects.csv"
  done
  cat "$OUT/objects.csv"
fi

echo "== checks"
if [[ -f "$OUT/console.txt" ]]; then
  while read -r _ verdict rest; do
    result "$verdict" "${rest%%:*}" "${rest#*: }"
  done < <(grep '^CHECK ' "$OUT/console.txt")
fi

teardown

# Raw text files carry the ASF header so the license check accepts them.
for f in "$OUT/console.txt" "$OUT/sbt-output.txt" "$OUT/checks.txt"; do
  [[ -f "$f" ]] && sanitize "$f" && { license_header; cat "$f"; } >"$f.tmp" && mv "$f.tmp" "$f"
done
"$PY" -I "$HERE/summarize.py" "$OUT" >"$OUT/summary.md.txt" 2>&1 || true
{ license_header; cat "$OUT/summary.md.txt"; } >"$OUT/summary.txt" && rm -f "$OUT/summary.md.txt"

echo "== $PASSED passed, $FAILED failed (raw output: ${OUT#"$HERE"/})"
if [[ $HARNESS_FAILED -ne 0 ]]; then exit 2; fi
[[ $FAILED -eq 0 ]] || exit 1
