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


# The agent runtime (Bun, Vercel AI SDK 7): AG-UI chat streams, agent templates and the MCP
# servers they bind. Build with the repository root as the context:
#
#   docker build -f bin/dockerfiles/agent-runtime.dockerfile -t texera/agent-runtime:dev .
#
# The model key is never part of the image; the deployment passes ANTHROPIC_API_KEY at run time.

FROM docker.io/oven/bun:1.3.14-alpine
WORKDIR /texera
# Every workspace's manifest, so the frozen lockfile matches.
COPY package.json bun.lock ./
COPY api/package.json api/
COPY packages/ packages/
COPY agent-runtime/package.json agent-runtime/
COPY frontend-next/package.json frontend-next/
COPY bio-mcp-service/package.json bio-mcp-service/
RUN bun install --frozen-lockfile
COPY agent-runtime/ agent-runtime/
COPY LICENSE NOTICE DISCLAIMER ./
USER bun
EXPOSE 23002
CMD ["bun", "agent-runtime/src/main.ts"]
