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


# The catalog (Go): resources and versions, grants and the policy decision point, executions and
# lineage, datasets, and the Texera MCP server. Build with the repository root as the context:
#
#   docker build -f bin/dockerfiles/catalog.dockerfile -t texera/catalog:dev .

FROM docker.io/library/golang:1.27-alpine AS build
WORKDIR /src/catalog
COPY catalog/go.mod catalog/go.sum ./
RUN go mod download
COPY catalog/ ./
ARG SOURCE_DATE_EPOCH
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -buildid=" -o /out/catalog ./cmd/catalog

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /texera
COPY --from=build /out/catalog /texera/catalog
COPY api/openfga/model.fga /texera/api/openfga/model.fga
COPY LICENSE NOTICE DISCLAIMER /texera/
ENV TEXERA_OPENFGA_MODEL=/texera/api/openfga/model.fga
EXPOSE 8090
ENTRYPOINT ["/texera/catalog"]
