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


# The frontend: the React app built to static files, served by nginx with the headers it is built
# to run under (frontend-next/security-headers.ts, rendered by frontend-next/scripts/nginx-conf.ts).
# It talks only to its own origin, the gateway. Build with the repository root as the context:
#
#   docker build -f bin/dockerfiles/frontend.dockerfile -t texera/frontend:dev .

# What is built is static files, the same for every platform, so the build runs on the machine's
# own platform whatever the image is for: an emulated one is slow, and has been seen to hang.
FROM --platform=$BUILDPLATFORM docker.io/oven/bun:1.3.14-alpine AS build
WORKDIR /texera
COPY package.json bun.lock ./
COPY api/package.json api/
COPY packages/ packages/
COPY agent-runtime/package.json agent-runtime/
COPY live/package.json live/
COPY bio-mcp-service/package.json bio-mcp-service/
COPY frontend-next/ frontend-next/
RUN bun install --frozen-lockfile
WORKDIR /texera/frontend-next
RUN bunx vite build --outDir /out/html && bun scripts/nginx-conf.ts > /out/default.conf

FROM docker.io/library/nginx:1.29-alpine
COPY --from=build /out/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /out/html /usr/share/nginx/html
COPY LICENSE NOTICE DISCLAIMER /usr/share/nginx/
EXPOSE 8080
