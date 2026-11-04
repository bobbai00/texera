"""The host processes of the Compose stack, for the one scenario that restarts the unit."""
from __future__ import annotations

import os
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
BIN = ROOT / "bin" / "texera-2-0"


def restart_unit() -> None:
    script = (
        'set -euo pipefail; source "$HERE/lib.sh"; stop unit 28085; '
        'start unit 28085 "$ROOT" "exec \'$HERE/run-unit.sh\'"; '
        "wait_for unit 900 http_ok http://localhost:28085/api/health"
    )
    env = dict(os.environ, HERE=str(BIN), ROOT=str(ROOT), LOGS=str(ROOT / "logs" / "texera-2-0"))
    subprocess.run(["bash", "-c", script], check=True, env=env)
