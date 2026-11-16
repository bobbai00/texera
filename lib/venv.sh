# shellcheck shell=bash
# Sourced by the harness entrypoints. Makes sure the harness venv exists
# (created with uv from requirements.txt) and exports SCE_PY, its python.
#
#   SCE_HOME  the harness root (set by the caller before sourcing)

: "${SCE_HOME:?SCE_HOME must be set before sourcing lib/venv.sh}"

SCE_VENV="$SCE_HOME/.venv"
SCE_PY="$SCE_VENV/bin/python"

sce_ensure_venv() {
    local stamp="$SCE_VENV/.requirements.sha"
    local want
    want="$(shasum -a 256 "$SCE_HOME/requirements.txt" | cut -d' ' -f1)"
    if [[ -x "$SCE_PY" && -f "$stamp" && "$(cat "$stamp")" == "$want" ]]; then
        return 0
    fi
    if ! command -v uv >/dev/null 2>&1; then
        echo "uv is not on PATH; install it (brew install uv) and retry" >&2
        exit 1
    fi
    echo "[sce] preparing python venv in $SCE_VENV" >&2
    [[ -x "$SCE_PY" ]] || uv venv --quiet --python 3.12 "$SCE_VENV" >&2
    uv pip install --quiet --python "$SCE_PY" -r "$SCE_HOME/requirements.txt" >&2
    echo "$want" >"$stamp"
}

sce_ensure_venv
export SCE_PY
