<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# Texera 2.0 dev stack

Infrastructure runs in containers (compose project `texera2`). The catalog, the computing unit,
the agent runtime and the frontend run on the host, so they can be rebuilt and restarted quickly.
Everything is reached through the gateway at `http://localhost:8088`.

```
bin/texera-2-0/up.sh                      # bring everything up (idempotent)
TEXERA_ENV_FILE=../texera/.env bin/texera-2-0/up.sh   # also start the agent runtime with ANTHROPIC_API_KEY from that file
bin/texera-2-0/test.sh                    # all suites, then the end-to-end checks
bin/texera-2-0/test.sh suites             # only the unit and integration suites
bin/texera-2-0/test.sh e2e                # only the end-to-end checks against the running stack
bin/texera-2-0/down.sh                    # stop it all, keep the data
bin/texera-2-0/down.sh --wipe             # stop it all and delete the volumes
```

`up.sh` reuses a service that already runs from this worktree and refuses to start when another
process holds one of its ports. The API key is read when the agent runtime starts and is never
written into this repository. Logs go to `logs/texera-2-0/<service>.log`, test logs to
`logs/texera-2-0/tests/`.

## Ports

| Port (host) | Service |
|---|---|
| 8088 | Envoy gateway, the only entrypoint (`http://localhost:8088`) |
| 9901 | Envoy admin |
| 8090 | Catalog (Go): resources, versions, grants, executions, lineage, MCP server |
| 28085 | Computing unit (Amber); actor port 2652 |
| 23002 | Agent runtime (AI SDK 7, AG-UI) |
| 5174 | Frontend (vite) |
| 23010 | Example third-party MCP server, started by `test.sh e2e` for the templates check |
| 18081 | Keycloak (admin/admin; users alice/alice, bob/bob, texera-admin/admin) |
| 18082 | OpenFGA HTTP API |
| 19001 | RustFS S3 (texera / texera-secret) |
| 18181 | Lakekeeper Iceberg REST |
| 15432 | Postgres (texera/texera; databases catalog, keycloak, openfga, lakekeeper) |

## End-to-end checks

| Script | What it proves |
|---|---|
| `smoke-catalog.sh` | Auth, workflow versions by content and JSON patch, validation, sharing through the PDP, datasets, MCP |
| `smoke-run.sh` | Compile and run on the unit, results, port-level lineage reported back to the catalog, a result saved as a dataset version produced by the run |
| `smoke-retention.py` | Every execution keeps its results after later runs and after the unit's idle release |
| `smoke-env.py` | A Python UDF fails without its package and completes in an Environment that lists it |
| `smoke-chat.py` | A real-model chat builds, edits and reruns a workflow, then saves the result as a dataset; everything is attributed to the agent on behalf of the person, with lineage to the run |
| `smoke-templates.py` | A template binds an external MCP server beside the built-in one; the agent uses both |
| `frontend-next/e2e` (Playwright) | Sign-in, chat with attachments, the library, a real-model chat that tracks what it built, saving a result from its run page |

## Kubernetes

The same services run as workloads on a local cluster (OrbStack's by default):

```
TEXERA_ENV_FILE=../texera/.env bin/texera-2-0/k8s.sh up   # build the images, apply deploy/kubernetes, wait
GW=http://localhost:28088 bin/texera-2-0/smoke-run.sh      # any check, against the cluster's gateway
bin/texera-2-0/k8s.sh status
bin/texera-2-0/k8s.sh down                                 # delete the namespace, data included
```

The manifests live in `deploy/kubernetes` (namespace `texera2`). The gateway's LoadBalancer
port 28088 on localhost is the public URL and the token issuer; the services reach each other,
Keycloak included, by their cluster names, which is why the catalog, the unit and the agent
runtime take explicit key-set and token URLs (`TEXERA_OIDC_JWKS_URL`, `TEXERA_OIDC_TOKEN_URL`).
The realm, the gateway config and the warehouse bootstrap are rendered from the files above.
`k8s.sh` only touches the context in `TEXERA2_KUBE_CONTEXT` (default `orbstack`) and refuses
remote cloud contexts.
