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

# The shared editing service. It shares code with the app, so it is built from frontend-react/:
#   docker build -f shared-editing-service/Dockerfile -t texera/shared-editing-service .
# It is told where Texera's backend is by TEXERA_GATEWAY, such as http://nginx:8080.

FROM docker.io/library/node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /src
COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable && yarn install --immutable
COPY . .
RUN yarn build:shared-editing

# What runs is one file, with nothing installed beside it.
FROM docker.io/library/node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
WORKDIR /srv
COPY --from=build /src/dist-shared-editing/main.js ./
ENV HOST=0.0.0.0 PORT=1235
USER node
EXPOSE 1235
CMD ["node", "main.js"]
