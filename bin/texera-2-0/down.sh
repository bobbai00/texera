#!/usr/bin/env bash
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

# Stops what up.sh started: the host services that run from this worktree, then the containers.
#
#   bin/texera-2-0/down.sh           # keep the data volumes
#   bin/texera-2-0/down.sh --wipe    # also delete them (databases, objects, realm state)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
LOGS=${TEXERA2_LOG_DIR:-$ROOT/logs/texera-2-0}
# shellcheck source=lib.sh
source "$HERE/lib.sh"

stop frontend 5174
stop agent-runtime 23002
stop bio-mcp 23010
stop unit 28085
stop catalog 8090

if [ "${1:-}" = "--wipe" ]; then
  docker compose -f "$HERE/docker-compose.yml" down -v
else
  docker compose -f "$HERE/docker-compose.yml" down
fi
