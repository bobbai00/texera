#!/usr/bin/env bash
# rest-check.sh <suites...>
# Runs amber suites against a real REST catalog: the step 0 proof's lake (Lakekeeper on RustFS),
# brought up under the shared stack lock and taken down again whatever happens. The lake and
# the lock are let go of after 18 minutes at the latest.
S=${SCE_WORK:-$HOME/.sce-work}/step3
L=${SCE_LOCK:-${SCE_WORK:-$HOME/.sce-work}/stack.lock}
LAKE=${SCE_WORKTREES:-$HOME/Desktop/projects/texera-worktrees}/sce-step0-proofs/proofs/step0/iceberg-commits
WT=${SCE_WORKTREES:-$HOME/Desktop/projects/texera-worktrees}/sce-step3-lane
OUT=$S/rest-check.out; : > "$OUT"
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$OUT"; }

until mkdir "$L" 2>/dev/null; do say "waiting for the stack lock, held by: $(cat "$L/owner" 2>/dev/null)"; sleep 30; done
echo "step3 part 5 lakekeeper $(date)" > "$L/owner"
say "lock taken"
cleanup() {
  [ -n "$WATCHDOG" ] && kill "$WATCHDOG" 2>/dev/null
  "$LAKE/stack.sh" down >> "$OUT" 2>&1
  left="$(docker ps -a --filter name=sce0ice --format '{{.Names}}' | tr '\n' ' ')"
  say "lake down; containers left: '${left}'"
  rm -rf "$L"
  say "lock released"
}
trap cleanup EXIT
# Whatever hangs, the lake and the lock go after 18 minutes.
( sleep 1080; echo "watchdog: 18 minutes passed" >> "$OUT"; pkill -f -- "-Drest-check-marker=1"; sleep 20; kill -TERM $$ ) &
WATCHDOG=$!

"$LAKE/stack.sh" up >> "$OUT" 2>&1 || { say "the lake did not come up"; exit 2; }
say "lake up"
eval "$("$LAKE/stack.sh" env)"
cd "$WT" || exit 9
export AMBER_TEST_FILTER=skip-integration
# What Lakekeeper itself lists in the execution-log namespace while the suites run: proof that
# the tables are made in the REST catalog. Every table name seen goes to rest-tables.txt.
LK=http://127.0.0.1:19540/catalog/v1
PREFIX_ID="$(curl -s "$LK/config?warehouse=texera" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("overrides") or {}).get("prefix") or (d.get("defaults") or {}).get("prefix") or "")')"
say "warehouse prefix: ${PREFIX_ID}"
: > "$S/rest-tables.txt"
( while true; do
    curl -s "$LK/$PREFIX_ID/namespaces/execution-log/tables" \
      | python3 -c 'import json,sys
try:
    for t in json.load(sys.stdin).get("identifiers", []): print(t["name"])
except Exception: pass' >> "$S/rest-tables.txt"
    sleep 1
  done ) &
LISTER=$!
sbt -Dsbt.supershell=false -Drest-check-marker=1 "WorkflowExecutionService/testOnly $*" > "$S/rest-check.log" 2>&1
say "sbt exit $?"
kill "$LISTER" 2>/dev/null
say "distinct execution-log tables Lakekeeper listed during the run: $(sort -u "$S/rest-tables.txt" | wc -l | tr -d ' ')"
grep -E "Tests: succeeded|\*\*\* FAILED \*\*\*|\*\*\* ABORTED \*\*\*|Failed tests:|^\[error\]|All tests passed|Total number of tests run" "$S/rest-check.log" \
  | sed -E 's/\x1b\[[0-9;]*m//g' | cut -c1-240 | head -40 | tee -a "$OUT"
