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

# Helpers shared by up.sh, down.sh and test.sh. Sourced, not run. Expects HERE, ROOT and LOGS.
# Other stacks on this host run the same kinds of processes, so a process is only ever reused
# or stopped when it runs from this worktree.

# Toolchains installed under the home directory (the go.dev tarball, bun, uv) are found without
# a shell profile, so the scripts work from cron, CI and non-login shells alike.
export PATH="$HOME/.local/go/bin:$HOME/go/bin:$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

# The model key: ANTHROPIC_API_KEY from the environment, else from TEXERA_ENV_FILE, else from the
# repo-root .env (gitignored). Lines may read KEY=VALUE or `export KEY=VALUE`.
if [ -z "${TEXERA_ENV_FILE:-}" ] && [ -f "$ROOT/.env" ]; then TEXERA_ENV_FILE=$ROOT/.env; fi
export TEXERA_ENV_FILE
env_file_value() { [ -f "${TEXERA_ENV_FILE:-}" ] && sed -n "s/^\(export \)\{0,1\}$1=//p" "$TEXERA_ENV_FILE" | head -1 || true; }

# Playwright drives its bundled Chromium, or the installed Google Chrome where Playwright ships no
# build for this host (frontend-next/playwright.config.ts reads the channel).
if [ -z "${TEXERA_E2E_BROWSER_CHANNEL:-}" ] && ! ls "$HOME/.cache/ms-playwright" 2>/dev/null | grep -q '^chromium' \
   && command -v google-chrome >/dev/null 2>&1; then
  export TEXERA_E2E_BROWSER_CHANNEL=chrome
fi

# The Python environment of the engine's workers: .venv at the repo root, managed by uv.
ensure_python_env() {
  if [ ! -x "$ROOT/.venv/bin/python" ]; then
    command -v uv >/dev/null || { echo "uv is required (https://docs.astral.sh/uv/): curl -LsSf https://astral.sh/uv/install.sh | sh" >&2; exit 1; }
    echo "python: creating .venv with uv sync --all-extras"
    (cd "$ROOT" && uv sync --all-extras)
  fi
  if [ ! -d "$ROOT/amber/src/main/python/proto" ]; then
    echo "python: generating the engine's protobuf bindings"
    (cd "$ROOT" && PATH="$ROOT/.venv/bin:$PATH" bin/python-proto-gen.sh)
  fi
}

# lsof exits non-zero when nothing matches; these must not trip `set -e -o pipefail` callers.
listener() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true; }
ours() { case "$(cwd_of "$1")" in "$ROOT"*) return 0 ;; *) return 1 ;; esac; }

# start NAME PORT DIR COMMAND: runs COMMAND from DIR in the background unless PORT is taken.
start() {
  local name=$1 port=$2 dir=$3 cmd=$4 pid
  pid=$(listener "$port")
  if [ -n "$pid" ]; then
    if ours "$pid"; then echo "$name: already running (pid $pid, :$port)"; return 0; fi
    echo "$name: port $port belongs to pid $pid in $(cwd_of "$pid"); stop it or change the port" >&2
    exit 1
  fi
  echo "$name: starting on :$port (log $LOGS/$name.log)"
  # `exec` so no shell of this script lingers holding its stdout (a caller piping our output would
  # otherwise wait for the service to exit).
  (cd "$dir" || exit 1; exec nohup bash -c "$cmd" >"$LOGS/$name.log" 2>&1 </dev/null) &
}

# wait_for NAME SECONDS COMMAND...: polls COMMAND once a second until it succeeds.
wait_for() {
  local name=$1 seconds=$2 _
  shift 2
  for _ in $(seq 1 "$seconds"); do
    if "$@" >/dev/null 2>&1; then echo "$name: ready"; return 0; fi
    sleep 1
  done
  echo "$name: not ready after ${seconds}s (log: $LOGS/$name.log)" >&2
  exit 1
}

http_ok() { curl -sf -o /dev/null --max-time 5 "$1"; }

# stop NAME PORT: stops the process on PORT, and the sbt launcher or `bun run` that wraps it.
stop() {
  local name=$1 port=$2 pid parent
  pid=$(listener "$port")
  if [ -z "$pid" ]; then echo "$name: not running"; return 0; fi
  if ! ours "$pid"; then echo "$name: pid $pid on :$port is not from this worktree; leaving it"; return 0; fi
  parent=$(ps -o ppid= -p "$pid" | tr -d ' ' || true)
  kill "$pid" 2>/dev/null || true
  if [ -n "$parent" ] && ps -o command= -p "$parent" | grep -qE 'sbt-launch\.jar|bun run '; then
    kill "$parent" 2>/dev/null || true
  fi
  for _ in $(seq 1 20); do [ -z "$(listener "$port")" ] && { echo "$name: stopped"; return 0; }; sleep 1; done
  echo "$name: still listening on :$port" >&2
}
