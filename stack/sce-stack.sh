#!/usr/bin/env bash
# sce-stack.sh -- an isolated copy of Texera's single-node stack (compose project "sce").
#
#   stack/sce-stack.sh [--source <worktree>] generate [--images <registry>/<tag>]
#   stack/sce-stack.sh [--source <worktree>] up [--images <registry>/<tag>] [--timeout S]
#   stack/sce-stack.sh down            stop + remove containers and network, keep volumes
#   stack/sce-stack.sh reset           down + delete only the sce_* volumes
#   stack/sce-stack.sh status [--json]
#   stack/sce-stack.sh logs <service> [--tail N] [-f]
#
# --source defaults to $SCE_SOURCE or
# /Users/jiadongb/Desktop/projects/texera-worktrees/self-contained-engine.
# --images defaults to ghcr.io/apache/latest (the published images);
# images/build.sh produces sce/<tag>.
# Run `stack/sce-stack.sh --help` (or `<command> --help`) for every option.
set -euo pipefail
SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/venv.sh
source "$SCE_HOME/lib/venv.sh"
exec "$SCE_PY" "$SCE_HOME/stack/sce_stack.py" "$@"
