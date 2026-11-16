#!/usr/bin/env bash
# k8s-stack.sh -- Texera on OrbStack Kubernetes (kube context "orbstack"), deployed from a
# worktree's Helm chart (bin/k8s) as release "texera" in namespace sce-k8s; computing
# units are pods the managing service creates in sce-k8s-units.
#
#   stack/k8s-stack.sh [--source <worktree>] up [--images <registry>/<tag>] [--port 30080] [--timeout S]
#                                              [--forward relay|kubectl] [--allow-crd-drift]
#   stack/k8s-stack.sh down                       uninstall, delete both namespaces and leftovers (not CRDs)
#   stack/k8s-stack.sh status [--json]
#   stack/k8s-stack.sh logs <alias|deploy/name|unit|unit-<cuid>|envoy> [--tail N] [-f]
#   stack/k8s-stack.sh port-forward start|stop|status
#   stack/k8s-stack.sh collect-logs <dir>          logs, events, objects of both namespaces
#   stack/k8s-stack.sh follow-units <dir>          stream every unit pod's log (until killed)
#   stack/k8s-stack.sh post-run <report.json>      after a driver run: unit pod gone, refusals by ext-authz
#   stack/k8s-stack.sh generate [--images ...]     write stack/k8s/generated/ only
#
# --source defaults to $SCE_SOURCE or
# /Users/jiadongb/Desktop/projects/texera-worktrees/self-contained-engine.
# --images defaults to ghcr.io/apache/latest; images/build.sh produces sce/<tag>.
# Run `stack/k8s-stack.sh --help` (or `<command> --help`) for every option. `up` and `down`
# change the shared cluster: hold the stack lock (README, "One run at a time"), or use
# run-k8s.sh, which takes it.
set -euo pipefail
SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/venv.sh
source "$SCE_HOME/lib/venv.sh"
exec "$SCE_PY" "$SCE_HOME/stack/k8s/k8s_stack.py" "$@"
