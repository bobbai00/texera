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

# The live service: the sessions in which people are on a resource together. Built from the
# repository root, like the agent runtime, since it shares the workspace's packages.
FROM docker.io/oven/bun:1.3.14-alpine
WORKDIR /texera
COPY package.json bun.lock ./
COPY api/package.json api/
COPY packages/ packages/
COPY agent-runtime/package.json agent-runtime/
COPY frontend-next/package.json frontend-next/
COPY bio-mcp-service/package.json bio-mcp-service/
COPY live/package.json live/
RUN bun install --frozen-lockfile
COPY live/ live/
COPY LICENSE NOTICE DISCLAIMER ./
USER bun
EXPOSE 23003
CMD ["bun", "live/src/main.ts"]
