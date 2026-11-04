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

Everything that is Texera runs as a plain process on the host: the catalog (Go), the computing
unit (the Amber engine, sbt), the agent runtime (Bun) and the frontend (vite). Only the standard
components run in containers (compose project `texera2`): the Envoy gateway, Keycloak, OpenFGA,
Postgres, RustFS (S3) and Lakekeeper (Iceberg REST). Everything is reached through the gateway at
`http://localhost:8088`. No Kubernetes is involved in development.

```
bin/texera-2-0/up.sh                      # bring everything up (idempotent)
bin/texera-2-0/test.sh                    # all suites, then the end-to-end checks
bin/texera-2-0/test.sh suites             # only the unit and integration suites
bin/texera-2-0/test.sh e2e                # only the end-to-end checks against the running stack
bin/texera-2-0/down.sh                    # stop it all, keep the data
bin/texera-2-0/down.sh --wipe             # stop it all and delete the volumes
```

`up.sh` reuses a service that already runs from this worktree and refuses to start when another
process holds one of its ports. Logs go to `logs/texera-2-0/<service>.log`, test logs to
`logs/texera-2-0/tests/`.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Docker with Compose v2 | any recent | the infrastructure containers |
| Go | the `go` line of `catalog/go.mod` (a [go.dev tarball](https://go.dev/dl/) under `~/.local/go` is found) | the catalog |
| JDK 17 and sbt | | the computing unit |
| Bun | 1.3 | the agent runtime, the frontend, the generated clients |
| uv | 0.9 | the Python environment of the engine's workers |
| `lsof`, `curl` | | the scripts |

The Python environment is managed by [uv](https://docs.astral.sh/uv/) from the repo-root
`pyproject.toml`: `up.sh` runs `uv sync --all-extras` (Python 3.12 into `.venv`, downloaded by
uv when missing) and `bin/python-proto-gen.sh` once, and the unit runs its workers from
`.venv/bin/python`. `bun install` at the repo root installs every workspace.

The model key for the agent runtime is `ANTHROPIC_API_KEY`, read from the environment, from the
file `TEXERA_ENV_FILE` names, or from a `.env` at the repo root (gitignored; `KEY=VALUE` or
`export KEY=VALUE` lines). Without it everything but the agent runtime starts.

The Playwright checks use Playwright's bundled Chromium (`cd frontend-next && bunx playwright
install chromium`); where Playwright ships no build for the host (Ubuntu 20.04, say), `test.sh`
drives the installed Google Chrome instead (`TEXERA_E2E_BROWSER_CHANNEL=chrome`).

## How the containers and the host meet

The gateway reaches the host services as `host.docker.internal` (mapped to the host gateway on
Linux). Lakekeeper hands the warehouse's S3 endpoint to the engine on the host, so that endpoint
is `http://127.0.0.1:19001` on both sides: the host's published RustFS port, and inside
Lakekeeper's network namespace a `socat` sidecar (`lakekeeper-s3`) that forwards the same address
to the `rustfs` container. Lakekeeper's own base URI is `http://localhost:18181`, which only the
host uses. No OrbStack-specific hostnames are needed; `TEXERA2_S3_ENDPOINT` and
`TEXERA2_LAKEKEEPER_URI` override both.

## Ports

| Port (host) | Service |
|---|---|
| 8088 | Envoy gateway, the only entrypoint (`http://localhost:8088`) |
| 9901 | Envoy admin |
| 8090 | Catalog (Go): resources, versions, grants, executions, lineage, MCP server |
| 28085 | Computing unit (Amber); actor port 2652 |
| 23002 | Agent runtime (AI SDK 7, AG-UI) |
| 5174 | Frontend (vite) |
| 23010 | Bio MCP server (PubMed, genes, variants, proteins), behind the gateway at `/bio-mcp`; its key is a seeded credential |
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
| `smoke-chat.py` | A real-model chat: the Data Analyst builds, edits and reruns a workflow over the iris dataset, then saves the result as a dataset; every resource carries the turn and the template version as its origin, with lineage to the run |
| `smoke-chat.py --demo` | The M1 scenario: the Bio Researcher answers with cited research ideas through the bio MCP server, then hands the chat to the Data Analyst, which runs the analysis |
| `frontend-next/e2e` (Playwright) | Sign-in, a chat with an attachment that becomes a dataset, switching agents through the switcher and `/mode`, creating and editing an agent template from its page, a saved result's lineage, and with the model: the Data Analyst chat that tracks what it built and the Bio Researcher's handoff |

## Kubernetes (deployment only, not for development)

The same services can be deployed as workloads on a local cluster with `bin/texera-2-0/k8s.sh`
and the manifests in `deploy/kubernetes` (namespace `texera2`, gateway on localhost:28088, the
services reach each other by cluster names, so the catalog, the unit and the agent runtime take
explicit `TEXERA_OIDC_JWKS_URL` / `TEXERA_OIDC_TOKEN_URL`). It is a deployment check, needs a
cluster context (`TEXERA2_KUBE_CONTEXT`, default `orbstack`), and is never required for
development: the stack above is the development environment.
