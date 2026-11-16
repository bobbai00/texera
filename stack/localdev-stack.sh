#!/usr/bin/env bash
# localdev-stack.sh -- Texera the way bin/local-dev.sh runs it (infrastructure in Docker, the
# JVM services as host processes from their dist launchers, the frontend on the Angular dev
# server with its proxy), isolated for the harness: compose project e2e-localdev, shifted
# infrastructure ports, logs under reports/.
#
#   stack/localdev-stack.sh [--source <worktree>] up [--python PY] [--heap NAME=SIZE ...] [--logs DIR]
#   stack/localdev-stack.sh down                 stop the processes, remove containers and network; keep volumes
#   stack/localdev-stack.sh reset                down, then remove the e2e-localdev_* volumes
#   stack/localdev-stack.sh status [--json]
#   stack/localdev-stack.sh logs <service|alias> [--tail N] [-f]   aliases: unit, dashboard, cu-manager, compiler,
#                                                                  files, config, acs, ng, pg
#   stack/localdev-stack.sh [--source <worktree>] build [--force]  sbt dist when a dist zip is missing
#   stack/localdev-stack.sh venv                 build .state/localdev/py311 (Python 3.11 + amber's requirements)
#   stack/localdev-stack.sh post-run <report>    after a driver run: every service alive and healthy
#   stack/localdev-stack.sh generate             write stack/localdev/generated/ only
#
# --source defaults to $SCE_LOCALDEV_SOURCE or
# /Users/jiadongb/Desktop/projects/texera-worktrees/sce-localdev-src (local-dev builds in it).
# `up`, `build`, `down` and `reset` change Docker state: hold the stack lock (README, "One run
# at a time"), or use run-localdev.sh, which takes it. Run `stack/localdev-stack.sh --help`
# (or `<command> --help`) for every option.
set -euo pipefail
SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/venv.sh
source "$SCE_HOME/lib/venv.sh"
exec "$SCE_PY" "$SCE_HOME/stack/localdev/localdev_stack.py" "$@"
