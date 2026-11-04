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
Linux). Two public addresses must work inside Lakekeeper's container exactly as on the host, so
Lakekeeper runs in the network namespace of `lakekeeper-net`, a `socat` container with two
forwards: `127.0.0.1:19001` to `rustfs` (Lakekeeper hands that S3 endpoint to the engine on the
host, and the host's published RustFS port is the same address) and `127.0.0.1:8088` to the
gateway (Keycloak's discovery document names the public issuer `http://localhost:8088/auth/...`,
and Lakekeeper fetches its signing keys from there). Lakekeeper's own base URI is
`http://localhost:18181`, which only the host uses. No OrbStack-specific hostnames are needed;
`TEXERA2_S3_ENDPOINT` and `TEXERA2_LAKEKEEPER_URI` override both.

## The lake

Lakekeeper authenticates every caller against Keycloak and authorizes with OpenFGA (a store of
its own, `lakekeeper`, on the stack's OpenFGA server). The catalog bootstraps it as its operator
at startup and creates the `texera` warehouse with credential vending on, so a unit never holds
a key to the whole store. A run gets a namespace of its own (`e_<execution rid>`), which the
catalog opens for the identity of the unit that runs it: every table of the run goes there, and
nobody else, not even a person with their own token, gets anything from the lake directly;
people read results through the catalog, which decides. The dev stack's unit presents the
realm's `texera-unit` client (`run-unit.sh`); a unit the catalog provisions on Kubernetes gets a
client of its own, minted in Keycloak, whose secret goes to OpenBao and to the unit's Secret.
Changing the realm (`keycloak/texera-realm.json`) needs `down.sh --wipe` (`k8s.sh down` on the
cluster): Keycloak imports a realm only once.

Retention is a setting (`spec.retention`, ISO 8601 durations): `results` is how long a finished
run keeps its result tables (absent: forever; the run's record and summaries stay, its rows
answer 410), `blobs` how long an uploaded file nobody committed is kept (absent: a day). The
catalog sweeps hourly; `POST /settings/retention/sweep` runs one now, for administrators. A run
can also be deleted outright (`DELETE /workflows/{rid}/executions/{eid}`, the Delete button of
its page), which takes its tables with it; a run a dataset version derives from is refused.

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
| 18082 | OpenFGA HTTP API (gRPC 8081 inside the network, for Lakekeeper) |
| 19001 | RustFS S3 (texera / texera-secret) |
| 18181 | Lakekeeper Iceberg REST and management API (a token is required; the catalog is the operator) |
| 15432 | Postgres (texera/texera; databases catalog, keycloak, openfga, lakekeeper) |

## End-to-end checks

| Script | What it proves |
|---|---|
| `smoke-catalog.sh` | Auth, workflow versions by content and JSON patch, validation, sharing through the PDP, datasets, MCP |
| `smoke-run.sh` | Compile and run on the unit, results, port-level lineage reported back to the catalog, a result saved as a dataset version produced by the run |
| `smoke-retention.py` | Every execution keeps its results after later runs and after the unit's idle release; a run can be deleted with its tables; an administrator's sweep under a retention policy expires old results (the record stays, the rows answer 410) |
| `smoke-env.py` | A Python UDF fails without its package and completes in an Environment that lists it |
| `smoke-operator.py` | A custom Python operator, created as a resource and used by its URI, runs in a pinned environment; deleting it is refused while a workflow references it |
| `smoke-share.py` | A viewer of a project finds its workflow, run and dataset in search, reads them and runs the workflow, but cannot edit, delete or lease the owner's credential |
| `smoke-credential.py` | A credential named by an operator property reaches the engine as the secret, leased for the run; the version keeps the URI; a viewer who may not use it is refused |
| `smoke-lake.py` | The lake enforces the catalog's decision: a run's tables live in a namespace of their own that the unit which ran it reads with vended credentials; anonymous callers, a person's own token and another unit's identity get nothing; deleting a provisioned unit deletes its identity and credential |
| `smoke-chat.py` | A real-model chat: the Data Analyst builds, edits and reruns a workflow over the iris dataset, then saves the result as a dataset; every resource carries the turn and the template version as its origin, with lineage to the run |
| `smoke-chat.py --demo` | The M1 scenario: the Bio Researcher answers with cited research ideas through the bio MCP server, then hands the chat to the Data Analyst, which runs the analysis |
| `frontend-next/e2e` (Playwright) | Sign-in, a chat with an attachment that becomes a dataset, switching agents through the switcher and `/mode`, creating and editing an agent template from its page, a saved result's lineage, and with the model: the Data Analyst chat that tracks what it built and the Bio Researcher's handoff |

## Kubernetes

The same stack on a local Kubernetes cluster, in one command:

```
bin/texera-2-0/k8s.sh up            # the kind cluster if missing, the five images, config, workloads, wait
bin/texera-2-0/k8s.sh check         # the smoke tests against the cluster, including a unit made as a resource
bin/texera-2-0/k8s.sh status        # pods, services, jobs
bin/texera-2-0/k8s.sh down          # delete the namespace (the cluster stays)
bin/texera-2-0/k8s.sh destroy       # delete the kind cluster
```

Open http://localhost:28088 (alice/alice, bob/bob). On Linux the cluster is [kind](https://kind.sigs.k8s.io)
(Kubernetes in Docker; `kind` and `kubectl` in `~/.local/bin` are enough), created with node
port 30088 mapped to localhost:28088. Another local cluster works with `TEXERA2_KUBE_CONTEXT`
set; remote clusters are refused. Two facts about this host shape the defaults: it is on cgroup
v1, so the node image is Kubernetes 1.33 (`TEXERA2_KIND_IMAGE` overrides), and kind needs
higher inotify limits than Ubuntu's defaults (`sysctl fs.inotify.max_user_instances=1024
fs.inotify.max_user_watches=1048576`).

What runs there: Postgres, Keycloak, OpenFGA, OpenBao (dev mode), RustFS, Lakekeeper (with
authentication and OpenFGA, bootstrapped by the catalog, reaching the public issuer through a
`socat` sidecar in its pod), the Envoy gateway, the catalog, one static computing unit, the
agent runtime, the bio MCP server and the frontend behind nginx, from `deploy/kubernetes/`
(kustomize) and the images under `bin/dockerfiles/`. The config maps are rendered from the
dev stack's own files (the realm, the gateway, the database bootstrap); the model key goes
from `.env` into a Secret and from there into OpenBao by the `openbao-init` job.

Computing units are resources there like everywhere else: a unit created with
`provider: kubernetes` (`POST /computing-units`, or the library's "New computing unit")
becomes a Deployment and a Service in the namespace, named after its rid, that the catalog
reconciles on every status probe; it reports pending until the engine answers, runs take
`computingUnit: <its URI>`, a changed spec (image, memory, cpu) rolls the Deployment at once
(the provider is fixed, and a unit with a run on it answers 409 until the run is over),
`terminate` removes the workloads, and the catalog's service account may do nothing else in
the cluster (`deploy/kubernetes/rbac.yaml`).
