#!/usr/bin/env bash
# frontend-check.sh <worktree> <tag>: the frontend's unit tests, format check and build of a worktree.
WT="$1"; TAG="$2"
S=${SCE_WORK:-$HOME/.sce-work}
OUT=$S/frontend-$TAG.summary; : > "$OUT"
say() { echo "$(date +%H:%M:%S) $*" >> "$OUT"; }
source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 24 >/dev/null 2>&1
cd "$WT/frontend" || exit 9
say "frontend of $WT at $(git rev-parse --short HEAD), node $(node --version)"
[ -d node_modules ] || { yarn install --immutable > "$S/frontend-$TAG-install.log" 2>&1; say "yarn install: exit $?"; }
rm -f src/assets/version.json
yarn format:ci > "$S/frontend-$TAG-format.log" 2>&1; say "format:ci: exit $?"
yarn test > "$S/frontend-$TAG-test.log" 2>&1; rc=$?; say "test: exit $rc"
grep -E "Test Files|Tests |FAIL " "$S/frontend-$TAG-test.log" | sed -E 's/\x1b\[[0-9;]*m//g' | tail -8 >> "$OUT"
yarn build:ci > "$S/frontend-$TAG-build.log" 2>&1; say "build:ci: exit $?"
rm -f src/assets/version.json
say "DONE"
