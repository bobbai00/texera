#!/usr/bin/env bash
# images/build.sh -- thin branch images for the sce stack, built on the published ones.
#
#   images/build.sh [options] <worktree> <tag>
#
# For a Texera worktree this
#   1. runs `sbt <Project>/dist` for the six JVM services (one sbt invocation):
#        WorkflowExecutionService (amber: the unit + the dashboard), FileService,
#        ComputingUnitManagingService, WorkflowCompilingService, ConfigService,
#        AccessControlService
#   2. with --frontend, builds the frontend (node 24 via nvm, the repo's pinned yarn)
#   3. generates the Python protobufs (protoc + betterproto at amber's pin) straight
#      into the build context -- never into the worktree
#   4. unzips every dist into a scratch context under <harness>/build/<tag>/ (the repo's
#      .dockerignore blocks *.zip and target/, so the repo root cannot be the context)
#   5. builds images FROM ghcr.io/apache/texera-<name>:latest that replace only
#      bin/ lib/ conf/, the resource dirs, the unit's Python tree and (with --frontend)
#      /frontend/dist, tagged sce/texera-<name>:<tag>
#   6. retags the images it does not rebuild (agent-service, notebook-migration-service,
#      jupyter) as sce/texera-<name>:<tag>, so `--images sce/<tag>` finds a full set.
#
# Options
#   --frontend          also build and replace the frontend (dashboard image)
#   --skip-sbt          reuse the dist zips already in */target/universal
#   --pip MODE          auto (default): reinstall amber/requirements.txt in the unit image
#                       when it differs from the base image's; operator-requirements.txt
#                       drift is only reported. always: reinstall both. never: neither.
#   --registry REG      output namespace (default sce)
#   --base REG:TAG      base images (default ghcr.io/apache:latest)
#   --dry-check         check every source path, dist name, tool and in-image target
#                       path; build nothing (safe while sbt is busy elsewhere)
#   -h, --help
#
# Then: ./run-baseline.sh --images sce/<tag>   or   stack/sce-stack.sh up --images sce/<tag>
set -euo pipefail

if ((BASH_VERSINFO[0] < 4)); then
    echo "bash >= 4 required (brew install bash); this is $BASH_VERSION" >&2
    exit 1
fi

SCE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

frontend=false; skip_sbt=false; pip_mode=auto; out_reg=sce; dry=false
base_reg=ghcr.io/apache; base_tag=latest
args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --frontend) frontend=true ;;
        --skip-sbt) skip_sbt=true ;;
        --pip) pip_mode="$2"; shift ;;
        --registry) out_reg="$2"; shift ;;
        --base) base_reg="${2%:*}"; base_tag="${2##*:}"; shift ;;
        --dry-check) dry=true ;;
        -h|--help) sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "unknown option $1 (see --help)" >&2; exit 64 ;;
        *) args+=("$1") ;;
    esac
    shift
done
[[ ${#args[@]} -eq 2 ]] || { echo "usage: images/build.sh [options] <worktree> <tag>  (see --help)" >&2; exit 64; }
WT="$(cd "${args[0]}" && pwd)"
TAG="${args[1]}"
[[ "$pip_mode" =~ ^(auto|always|never)$ ]] || { echo "--pip must be auto|always|never" >&2; exit 64; }
[[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "invalid image tag '$TAG'" >&2; exit 64; }

CTX_ROOT="$SCE_HOME/build/$TAG"

say()  { printf '[build] %s\n' "$*"; }
warn() { printf '[build] WARNING: %s\n' "$*" >&2; }
die()  { printf '[build] ERROR: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ the image map
# image name -> sbt project / dist zip glob (relative to the worktree)
declare -A SBT_PROJECT=(
    [workflow-execution-coordinator]=WorkflowExecutionService
    [dashboard-service]=WorkflowExecutionService
    [file-service]=FileService
    [config-service]=ConfigService
    [access-control-service]=AccessControlService
    [workflow-compiling-service]=WorkflowCompilingService
    [workflow-computing-unit-managing-service]=ComputingUnitManagingService
)
declare -A DIST_ZIP=(
    [workflow-execution-coordinator]="amber/target/universal/amber-*.zip"
    [dashboard-service]="amber/target/universal/amber-*.zip"
    [file-service]="file-service/target/universal/file-service-*.zip"
    [config-service]="config-service/target/universal/config-service-*.zip"
    [access-control-service]="access-control-service/target/universal/access-control-service-*.zip"
    [workflow-compiling-service]="workflow-compiling-service/target/universal/workflow-compiling-service-*.zip"
    [workflow-computing-unit-managing-service]="computing-unit-managing-service/target/universal/computing-unit-managing-service-*.zip"
)
# image name -> its app root inside the image (where bin/ lib/ conf/ live)
declare -A APP_ROOT=(
    [workflow-execution-coordinator]=/texera/amber
    [dashboard-service]=/texera/amber
    [file-service]=/texera
    [config-service]=/texera
    [access-control-service]=/texera
    [workflow-compiling-service]=/texera
    [workflow-computing-unit-managing-service]=/texera
)
# image name -> "worktree-relative source dir:in-image target dir" resource pairs,
# exactly what bin/dockerfiles/<x>.dockerfile copies into its runtime stage
declare -A RESOURCES=(
    [workflow-execution-coordinator]="common/config/src/main/resources:/texera/amber/common/config/src/main/resources amber/src/main/resources:/texera/amber/src/main/resources"
    [dashboard-service]="amber/src/main/resources:/texera/amber/src/main/resources common/config/src/main/resources:/texera/amber/common/config/src/main/resources"
    [file-service]="common/config/src/main/resources:/texera/common/config/src/main/resources file-service/src/main/resources:/texera/file-service/src/main/resources"
    [config-service]="common/config/src/main/resources:/texera/common/config/src/main/resources config-service/src/main/resources:/texera/config-service/src/main/resources"
    [access-control-service]="access-control-service/src/main/resources:/texera/access-control-service/src/main/resources"
    [workflow-compiling-service]="common/config/src/main/resources:/texera/common/config/src/main/resources workflow-compiling-service/src/main/resources:/texera/workflow-compiling-service/src/main/resources"
    [workflow-computing-unit-managing-service]="common/config/src/main/resources:/texera/common/config/src/main/resources computing-unit-managing-service/src/main/resources:/texera/computing-unit-managing-service/src/main/resources"
)
BUILT_IMAGES=(workflow-execution-coordinator dashboard-service file-service config-service
              access-control-service workflow-compiling-service workflow-computing-unit-managing-service)
RETAGGED_IMAGES=(agent-service notebook-migration-service jupyter)
UNIT_IMAGE=workflow-execution-coordinator
DASHBOARD_IMAGE=dashboard-service
UNIT_PYTHON_DIR=/texera/amber/src/main/python
FRONTEND_DIR=/frontend/dist

base_image() { echo "$base_reg/texera-$1:$base_tag"; }
out_image()  { echo "$out_reg/texera-$1:$TAG"; }

newest() {  # newest file matching a glob relative to the worktree, or empty
    local pattern="$1" f best="" best_t=0 t
    shopt -s nullglob
    # shellcheck disable=SC2206
    local matches=( "$WT"/$pattern )
    shopt -u nullglob
    for f in "${matches[@]}"; do
        t=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")
        if (( t > best_t )); then best="$f"; best_t=$t; fi
    done
    if (( ${#matches[@]} > 1 )); then
        warn "several dists match $pattern; using the newest: ${best#"$WT"/}"
    fi
    echo "$best"
}

# ---------------------------------------------------------------- preflight checks
problems=0
problem() { printf '[build]   MISSING: %s\n' "$*" >&2; problems=$((problems + 1)); }

check_worktree() {
    say "worktree $WT ($(git -C "$WT" rev-parse --short HEAD 2>/dev/null || echo '?') on $(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?'))"
    [[ -f "$WT/build.sbt" ]] || problem "$WT/build.sbt"
    local p
    for p in WorkflowExecutionService FileService ComputingUnitManagingService WorkflowCompilingService ConfigService AccessControlService; do
        grep -qE "^lazy val $p\b" "$WT/build.sbt" || problem "sbt project $p in build.sbt"
    done
    local img pair src
    for img in "${BUILT_IMAGES[@]}"; do
        for pair in ${RESOURCES[$img]}; do
            src="${pair%%:*}"
            [[ -d "$WT/$src" ]] || problem "$WT/$src (resources of $img)"
        done
    done
    [[ -d "$WT/amber/src/main/python" ]] || problem "$WT/amber/src/main/python"
    [[ -d "$WT/amber/src/main/protobuf" ]] || problem "$WT/amber/src/main/protobuf"
    [[ -d "$WT/common/workflow-core/src/main/protobuf" ]] || problem "$WT/common/workflow-core/src/main/protobuf"
    [[ -f "$WT/amber/requirements.txt" ]] || problem "$WT/amber/requirements.txt"
    grep -qE '^betterproto==' "$WT/amber/requirements.txt" 2>/dev/null || problem "a betterproto== pin in amber/requirements.txt"
    if $frontend; then
        [[ -f "$WT/frontend/package.json" ]] || problem "$WT/frontend/package.json"
        compgen -G "$WT/frontend/.yarn/releases/yarn-*.cjs" >/dev/null || problem "$WT/frontend/.yarn/releases/yarn-*.cjs"
    fi
}

check_tools() {
    command -v docker >/dev/null || problem "docker on PATH"
    command -v unzip >/dev/null || problem "unzip on PATH"
    command -v rsync >/dev/null || problem "rsync on PATH"
    command -v protoc >/dev/null || problem "protoc on PATH (brew install protobuf)"
    command -v uv >/dev/null || problem "uv on PATH (brew install uv)"
    $skip_sbt || command -v sbt >/dev/null || problem "sbt on PATH"
    if $frontend; then
        [[ -s "$HOME/.nvm/nvm.sh" ]] || problem "$HOME/.nvm/nvm.sh (nvm, for node 24)"
        # shellcheck disable=SC1091
        ( source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 && nvm which 24 >/dev/null 2>&1 ) || problem "node 24 under nvm (nvm install 24)"
    fi
    if command -v protoc >/dev/null; then
        local inc
        inc="$(dirname "$(dirname "$(command -v protoc)")")/include"
        [[ -f "$inc/google/protobuf/descriptor.proto" ]] || problem "protoc well-known types at $inc/google/protobuf"
    fi
}

check_base_images() {
    local img base pair dst paths
    for img in "${BUILT_IMAGES[@]}" "${RETAGGED_IMAGES[@]}"; do
        base="$(base_image "$img")"
        if ! docker image inspect "$base" >/dev/null 2>&1; then
            problem "base image $base (docker pull it first)"
            continue
        fi
        [[ " ${RETAGGED_IMAGES[*]} " == *" $img "* ]] && continue
        paths="${APP_ROOT[$img]}/bin ${APP_ROOT[$img]}/lib ${APP_ROOT[$img]}/conf"
        for pair in ${RESOURCES[$img]}; do paths+=" ${pair#*:}"; done
        [[ "$img" == "$UNIT_IMAGE" ]] && paths+=" $UNIT_PYTHON_DIR $UNIT_PYTHON_DIR/proto /tmp/requirements.txt /tmp/operator-requirements.txt"
        [[ "$img" == "$DASHBOARD_IMAGE" ]] && paths+=" $FRONTEND_DIR/index.html"
        local out
        out=$(docker run --rm --network none --entrypoint sh "$base" -c \
            "id -u; id -g; for p in $paths; do [ -e \"\$p\" ] || echo \"\$p\"; done" 2>&1) \
            || { problem "could not inspect $base: $out"; continue; }
        local uid gid missing
        uid=$(echo "$out" | sed -n 1p); gid=$(echo "$out" | sed -n 2p)
        missing=$(echo "$out" | tail -n +3)
        [[ -z "$missing" ]] || problem "in $base: $(echo "$missing" | tr '\n' ' ')"
        [[ "$uid:$gid" == "1001:1001" ]] || problem "$base runs as $uid:$gid, expected 1001:1001 (texera)"
        say "  $base: $(echo "$paths" | wc -w | tr -d ' ') target paths present, user $uid:$gid"
    done
}

check_dists() {
    local img z
    for img in "${BUILT_IMAGES[@]}"; do
        z="$(newest "${DIST_ZIP[$img]}")"
        if [[ -n "$z" ]]; then say "  dist for $img: ${z#"$WT"/}"
        elif $dry; then say "  dist for $img: not built yet (${DIST_ZIP[$img]})"
        else problem "dist zip ${DIST_ZIP[$img]} (run without --skip-sbt)"
        fi
    done
}

# ------------------------------------------------------------------- build steps

run_sbt() {
    local projects=() p
    for p in WorkflowExecutionService FileService ComputingUnitManagingService WorkflowCompilingService ConfigService AccessControlService; do
        projects+=("$p/dist")
    done
    say "sbt ${projects[*]}  (in $WT)"
    ( cd "$WT" && sbt -batch "${projects[@]}" )
}

build_frontend() {
    say "frontend: yarn install --immutable && yarn build (node 24)"
    (
        # shellcheck disable=SC1091
        source "$HOME/.nvm/nvm.sh" >/dev/null
        nvm use 24 >/dev/null
        cd "$WT/frontend"
        local yarn_js
        yarn_js="$(ls .yarn/releases/yarn-*.cjs | head -1)"
        node "$yarn_js" install --immutable
        node "$yarn_js" build
    )
    [[ -f "$WT/frontend/dist/index.html" ]] || die "frontend build produced no dist/index.html"
}

PROTO_VENV="$SCE_HOME/.venv-proto"
ensure_proto_venv() {
    local pin
    pin="$(grep -E '^betterproto==' "$WT/amber/requirements.txt" | head -1 | tr -d '[:space:]')"
    local want="${pin/betterproto==/betterproto[compiler]==}"
    if [[ ! -x "$PROTO_VENV/bin/protoc-gen-python_betterproto" || "$(cat "$PROTO_VENV/.pin" 2>/dev/null)" != "$want" ]]; then
        say "proto plugin venv: $want"
        [[ -x "$PROTO_VENV/bin/python" ]] || uv venv --quiet --python 3.12 "$PROTO_VENV"
        uv pip install --quiet --python "$PROTO_VENV/bin/python" "$want"
        echo "$want" >"$PROTO_VENV/.pin"
    fi
}

# gen_protos <proto source root> <out dir>: what bin/python-proto-gen.sh does, but
# reading from <root> and writing to <out> (the script itself writes into the repo).
gen_protos() {
    local root="$1" out="$2"
    local inc amber_pb core_pb
    inc="$(dirname "$(dirname "$(command -v protoc)")")/include"
    amber_pb="$root/amber/src/main/protobuf"
    core_pb="$root/common/workflow-core/src/main/protobuf"
    mkdir -p "$out"
    # shellcheck disable=SC2046
    PATH="$PROTO_VENV/bin:$PATH" protoc --python_betterproto_out="$out" \
        -I="$inc" -I="$amber_pb" -I="$core_pb" \
        $(find "$amber_pb" -iname "*.proto" | LC_ALL=C sort) \
        $(find "$core_pb" -iname "*.proto" | LC_ALL=C sort)
}

unzip_dist() {  # unzip_dist <zip> <dest>: the zip's single top dir becomes <dest>
    local zip="$1" dest="$2" tmp top
    tmp="$(mktemp -d "$CTX_ROOT/.unzip.XXXXXX")"
    unzip -q "$zip" -d "$tmp"
    mkdir -p "$(dirname "$dest")"
    top=("$tmp"/*)
    if [[ ${#top[@]} -eq 1 && -d "${top[0]}" ]]; then mv "${top[0]}" "$dest"; else mv "$tmp" "$dest"; fi
    rm -rf "$tmp"
    [[ -d "$dest/bin" && -d "$dest/lib" ]] || die "$zip has no bin/ and lib/"
}

# make_context <image>: writes $CTX_ROOT/<image>/{Dockerfile,payload...}
make_context() {
    local img="$1" ctx="$CTX_ROOT/$1" root="${APP_ROOT[$1]}" zip dist_dir
    zip="$(newest "${DIST_ZIP[$img]}")"
    [[ -n "$zip" ]] || die "no dist zip for $img (${DIST_ZIP[$img]})"
    rm -rf "$ctx"; mkdir -p "$ctx"
    dist_dir="$CTX_ROOT/dist/$(basename "$zip" .zip)"
    [[ -d "$dist_dir" ]] || unzip_dist "$zip" "$dist_dir"
    mkdir -p "$ctx/app"
    local d
    for d in bin lib conf; do
        [[ -d "$dist_dir/$d" ]] && cp -R "$dist_dir/$d" "$ctx/app/$d"
    done

    local df="$ctx/Dockerfile" rm_paths="$root/bin $root/lib $root/conf" copies="" i=0 pair src dst
    for d in bin lib conf; do
        [[ -d "$ctx/app/$d" ]] && copies+="COPY --chown=1001:1001 app/$d $root/$d"$'\n'
    done
    for pair in ${RESOURCES[$img]}; do
        src="${pair%%:*}"; dst="${pair#*:}"
        mkdir -p "$ctx/res/$i"
        rsync -a --exclude '.DS_Store' "$WT/$src/" "$ctx/res/$i/"
        rm_paths+=" $dst"
        copies+="COPY --chown=1001:1001 res/$i $dst"$'\n'
        i=$((i + 1))
    done
    local pip_layer=""
    if [[ "$img" == "$UNIT_IMAGE" ]]; then
        rsync -a --exclude '__pycache__' --exclude '*.py[cod]' --exclude '.pytest_cache' \
            --exclude '/proto/' "$WT/amber/src/main/python/" "$ctx/python/"
        cp -R "$CTX_ROOT/proto" "$ctx/python/proto"
        rm_paths+=" $UNIT_PYTHON_DIR"
        copies+="COPY --chown=1001:1001 python $UNIT_PYTHON_DIR"$'\n'
        pip_layer="$(pip_layer_for "$ctx")"
    fi
    if [[ "$img" == "$DASHBOARD_IMAGE" ]] && $frontend; then
        rsync -a "$WT/frontend/dist/" "$ctx/frontend-dist/"
        rm_paths+=" $FRONTEND_DIR"
        copies+="COPY --chown=1001:1001 frontend-dist $FRONTEND_DIR"$'\n'
    fi

    cat >"$df" <<EOF
# Generated by sce-e2e/images/build.sh -- thin layer on $(base_image "$img")
FROM $(base_image "$img")
USER root
${pip_layer}RUN rm -rf $rm_paths
${copies}USER texera
LABEL sce.base="$(base_image "$img")" sce.source="$WT" sce.revision="$REV" sce.dirty="$DIRTY" sce.tag="$TAG"
EOF
}

# The unit image's Python packages come from the base image; reinstall when the
# branch's requirements differ (see --pip).
pip_layer_for() {
    local ctx="$1" base layer="" f
    base="$(base_image "$UNIT_IMAGE")"
    for f in requirements.txt operator-requirements.txt; do
        local mine="$WT/amber/$f" theirs="$ctx/.base-$f"
        docker run --rm --network none --entrypoint cat "$base" "/tmp/$f" >"$theirs" 2>/dev/null || : >"$theirs"
        if cmp -s "$mine" "$theirs"; then continue; fi
        if [[ "$pip_mode" == always || ( "$pip_mode" == auto && "$f" == requirements.txt ) ]]; then
            cp "$mine" "$ctx/$f"
            layer+="COPY $f /tmp/$f"$'\n'"RUN python3 -m pip install --no-cache-dir -r /tmp/$f"$'\n'
            echo "[build]   amber/$f differs from the base image's: reinstalling it in the unit image" >&2
        else
            echo "[build] WARNING: amber/$f differs from $base's copy and is NOT reinstalled (--pip $pip_mode):" >&2
            diff "$theirs" "$mine" | sed 's/^/[build]     /' >&2 || true
        fi
    done
    printf '%s' "$layer"
}

# ------------------------------------------------------------------------- main

REV="$(git -C "$WT" rev-parse HEAD 2>/dev/null || echo unknown)"
# GIT_OPTIONAL_LOCKS=0: do not refresh (and lock) the index of a worktree someone
# else may be committing in.
DIRTY="$([[ -n "$(GIT_OPTIONAL_LOCKS=0 git -C "$WT" status --porcelain --untracked-files=no 2>/dev/null)" ]] && echo true || echo false)"

say "checking the worktree, tools and base images ($base_reg/texera-*:$base_tag)"
check_worktree
check_tools
check_base_images
# Before a real build the dists only have to exist when sbt is skipped; otherwise sbt
# makes them below and they are checked after it runs.
if $dry || $skip_sbt; then check_dists; fi

if $dry; then
    if command -v protoc >/dev/null && command -v uv >/dev/null && (( problems == 0 )); then
        ensure_proto_venv
        tmp="$(mktemp -d)"
        gen_protos "$WT" "$tmp/proto"
        say "  protos: $(find "$tmp/proto" -name '*.py' | wc -l | tr -d ' ') modules generated from the worktree's .proto files (scratch dir, then deleted)"
        rm -rf "$tmp"
    fi
    if (( problems > 0 )); then die "dry check found $problems problem(s)"; fi
    say "dry check OK: nothing built. A real build writes $CTX_ROOT and images $(out_image '<name>')"
    exit 0
fi
(( problems == 0 )) || die "$problems problem(s) above; fix them or run with --dry-check for details"

mkdir -p "$CTX_ROOT"
if ! $skip_sbt; then
    run_sbt
    check_dists
    (( problems == 0 )) || die "sbt finished but $problems dist(s) are missing"
fi
$frontend && build_frontend

ensure_proto_venv
rm -rf "$CTX_ROOT/proto" "$CTX_ROOT/dist"
gen_protos "$WT" "$CTX_ROOT/proto"
say "protos generated into $CTX_ROOT/proto"

manifest_images=()
for img in "${BUILT_IMAGES[@]}"; do
    make_context "$img"
    say "docker build $(out_image "$img")  (context $CTX_ROOT/$img)"
    docker build -t "$(out_image "$img")" "$CTX_ROOT/$img"
    manifest_images+=("\"$img\": {\"image\": \"$(out_image "$img")\", \"id\": \"$(docker image inspect -f '{{.Id}}' "$(out_image "$img")")\", \"rebuilt\": true}")
done
for img in "${RETAGGED_IMAGES[@]}"; do
    docker tag "$(base_image "$img")" "$(out_image "$img")"
    say "retagged $(base_image "$img") -> $(out_image "$img") (not rebuilt)"
    manifest_images+=("\"$img\": {\"image\": \"$(out_image "$img")\", \"id\": \"$(docker image inspect -f '{{.Id}}' "$(out_image "$img")")\", \"rebuilt\": false}")
done

{
    echo "{"
    echo "  \"tag\": \"$TAG\","
    echo "  \"registry\": \"$out_reg\","
    echo "  \"source\": \"$WT\","
    echo "  \"revision\": \"$REV\","
    echo "  \"dirty\": $DIRTY,"
    echo "  \"base\": \"$base_reg/texera-*:$base_tag\","
    echo "  \"frontend_rebuilt\": $frontend,"
    echo "  \"pip_mode\": \"$pip_mode\","
    echo "  \"built_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo "  \"images\": {"
    for i in "${!manifest_images[@]}"; do
        sep=","; (( i == ${#manifest_images[@]} - 1 )) && sep=""
        echo "    ${manifest_images[$i]}$sep"
    done
    echo "  }"
    echo "}"
} >"$CTX_ROOT/BUILD-MANIFEST.json"

say "done: $out_reg/texera-*:$TAG  (manifest $CTX_ROOT/BUILD-MANIFEST.json)"
say "run it:  $SCE_HOME/run-baseline.sh --images $out_reg/$TAG"
