#!/usr/bin/env bash
# driver/run.sh [driver args]  --  run the e2e driver with the harness venv.
#   driver/run.sh --list
#   driver/run.sh --scenario a,c --base http://localhost:8080
set -euo pipefail
SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/venv.sh
source "$SCE_HOME/lib/venv.sh"
exec "$SCE_PY" -u "$SCE_HOME/driver/e2e.py" "$@"
