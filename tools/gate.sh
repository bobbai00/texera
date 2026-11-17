#!/usr/bin/env bash
# gate.sh <commit> <tag> <single-node driver args...>
# Builds branch images (with the frontend) and runs the harness in single-node (gate + browser),
# Kubernetes and local-dev. Writes one summary line per stage to $OUT.
COMMIT="$1"; TAG="$2"; shift 2; SN_ARGS=("$@")
W=${SCE_WORKTREES:-$HOME/Desktop/projects/texera-worktrees}
H=$W/sce-e2e; IMG=$W/sce-imgbuild; LD=$W/sce-localdev-src
L=${SCE_LOCK:-${SCE_WORK:-$HOME/.sce-work}/stack.lock}
OUT=$H/reports/gate-$TAG.summary; : > "$OUT"
say() { echo "$(date +%H:%M:%S) $*" >> "$OUT"; }
lock() { until mkdir "$L" 2>/dev/null; do sleep 20; done; echo "gate $TAG $(date) pid $$" > "$L/owner"; }
unlock() { rm -rf "$L"; }
cd "$H" || exit 9
MODE_SCN="${MODE_SCN:-a,b,c,d,e,u,k,l1,l6,l8}"
# K8S_SCN / LD_SCN: the scenarios of the Kubernetes and the local-dev stage (default MODE_SCN).
K8S_SCN="${K8S_SCN:-$MODE_SCN}"; LD_SCN="${LD_SCN:-$MODE_SCN}"
# SN_STACK_OPTS: extra stack options of the single-node gate run, e.g. "--isolate-unit".
read -r -a SN_STACK <<< "${SN_STACK_OPTS:-}"

[ -z "$(git -C "$IMG" status --porcelain --untracked-files=no)" ] || { say "ABORT: $IMG is dirty"; exit 9; }
git -C "$IMG" checkout -q --detach "$COMMIT" || { say "ABORT: checkout"; exit 9; }
/opt/homebrew/bin/bash images/build.sh --frontend "$IMG" "$TAG" > "reports/build-$TAG.log" 2>&1; rc=$?
say "build images sce/$TAG from $COMMIT: exit $rc"; [ $rc -eq 0 ] || exit 1

if [ -z "$SKIP_SN" ]; then
  lock
  ./run-baseline.sh --reset --images "sce/$TAG" --source "$IMG" --pg-statement-log "${SN_STACK[@]}" --label "gate $TAG" -- "${SN_ARGS[@]}" > "reports/gate-$TAG-single-node.log" 2>&1; rc=$?
  unlock
  say "single-node gate: exit $rc"
  grep -E "^ (PASS|FAIL) |overall:" "reports/gate-$TAG-single-node.log" >> "$OUT"
  ./run-browser-smoke.sh --lock "$L" --reset --images "sce/$TAG" --source "$IMG" > "reports/gate-$TAG-browser.log" 2>&1; rc=$?
  say "browser smoke: exit $rc"
  grep -E "^ ?(PASS|FAIL)|B[0-9]+ .*(PASS|FAIL)|overall" "reports/gate-$TAG-browser.log" | tail -12 >> "$OUT"
fi

if [ -z "$SKIP_K8S" ]; then
  ./run-k8s.sh --lock "$L" --images "sce/$TAG" --source "$IMG" -- --transport create-ws --scenario "$K8S_SCN" > "reports/gate-$TAG-k8s.log" 2>&1; rc=$?
  say "kubernetes: exit $rc"
  grep -E "^ (PASS|FAIL) |overall:" "reports/gate-$TAG-k8s.log" >> "$OUT"
fi

if [ -z "$SKIP_LD" ]; then
  if [ -n "$(git -C "$LD" status --porcelain --untracked-files=no)" ]; then say "local-dev SKIPPED: $LD is dirty"; else
    git -C "$LD" checkout -q --detach "$COMMIT"
    lock; stack/localdev-stack.sh build --force > "reports/gate-$TAG-localdev-build.log" 2>&1; rc=$?; unlock
    say "local-dev build: exit $rc"
    if [ $rc -eq 0 ]; then
      ./run-localdev.sh --lock "$L" --reset -- --transport create-ws --scenario "$LD_SCN" > "reports/gate-$TAG-localdev.log" 2>&1; rc=$?
      say "local-dev: exit $rc"
      grep -E "^ (PASS|FAIL) |overall:" "reports/gate-$TAG-localdev.log" >> "$OUT"
    fi
  fi
fi
say "DONE"
