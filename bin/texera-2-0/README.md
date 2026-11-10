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
unit (the Amber engine, sbt), the agent runtime and the live service (Bun) and the frontend
(vite). Only the standard
components run in containers (compose project `texera2`): the Envoy gateway, Keycloak, OpenFGA,
Postgres, RustFS (S3) and Lakekeeper (Iceberg REST). Everything is reached through the gateway at
`http://localhost:8088`. No Kubernetes is involved in development.

```
bin/texera-2-0/up.sh                      # bring everything up (idempotent)
bin/texera-2-0/test.sh unit               # no stack needed: catalog, engine, runtime, frontend
bin/texera-2-0/test.sh scenario           # the end-to-end scenarios against the running stack
bin/texera-2-0/test.sh ui                 # Playwright against the running stack
bin/texera-2-0/test.sh evals              # the real agents through the real model
bin/texera-2-0/test.sh all                # every layer on the running stack; `gate` wipes first
bin/texera-2-0/down.sh                    # stop it all, keep the data
bin/texera-2-0/down.sh --wipe             # stop it all and delete the volumes
```

How to use what comes up, from the first sign-in to runs, agents and the API by hand:
`docs/texera-2-0/GUIDE.md`.

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
install chromium`); where Playwright ships no build for the host (Ubuntu 20.04, say), set
`TEXERA_E2E_BROWSER_CHANNEL=chrome` to drive the installed Google Chrome instead.

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
at startup. A warehouse of the lake is a resource of the catalog's (`/warehouses`), and the
catalog makes each one there with credential vending on, so a unit never holds a key to a
store: the platform's own, `texera` (`TEXERA_ICEBERG_WAREHOUSE`), at every start, on the
stack's RustFS under `warehouse/` of the bucket `texera` (`TEXERA_LAKE_S3_ENDPOINT`,
`TEXERA_LAKE_BUCKET`, `TEXERA_LAKE_KEY_PREFIX`); a project's own, `w_<rid>`, when it is
created, under `w/<rid>/` of the same bucket or on the store its spec names. An execution gets
a namespace of its own (`e_<execution rid>`) in its warehouse, which the
catalog opens for the identity of the unit that runs it: every table of the execution goes there, and
nobody else, not even a person with their own token, gets anything from the lake directly;
people read results through the catalog, which decides. The dev stack's unit presents the
realm's `texera-unit` client (`run-unit.sh`); a unit the catalog provisions on Kubernetes gets a
client of its own, minted in Keycloak, whose secret goes to OpenBao and to the unit's Secret.
Changing the realm (`keycloak/texera-realm.json`) needs `down.sh --wipe` (`k8s.sh down` on the
cluster): Keycloak imports a realm only once.

Retention is a setting (`spec.retention`, ISO 8601 durations): `results` is how long a finished
execution keeps its result tables (absent: forever; its record and summaries stay, its rows
answer 410), `blobs` how long an uploaded file nobody committed is kept (absent: a day). The
catalog sweeps hourly; `POST /settings/retention/sweep` runs one now, for administrators. An execution
can also be deleted outright (`DELETE /workflows/{rid}/executions/{eid}`, the Delete button of
its page), which takes its tables with it; one a dataset version derives from is refused.

## Ports

| Port (host) | Service |
|---|---|
| 8088 | Envoy gateway, the only entrypoint (`http://localhost:8088`) |
| 9901 | Envoy admin |
| 8090 | Catalog (Go): resources, versions, grants, executions, lineage, MCP server |
| 28085 | Computing unit (Amber); actor port 2652 |
| 23002 | Agent runtime (AI SDK 7, AG-UI) |
| 23003 | Live service (Hocuspocus, Yjs): the sessions people share on a resource, behind the gateway at `/live/` |
| 5174 | Frontend (vite) |
| 23010 | Bio MCP server (PubMed, genes, variants, proteins), behind the gateway at `/bio-mcp`; its key is a seeded credential |
| 18081 | Keycloak (admin/admin; users alice/alice, bob/bob, texera-admin/admin) |
| 18082 | OpenFGA HTTP API (gRPC 8081 inside the network, for Lakekeeper) |
| 19001 | RustFS S3 (texera / texera-secret) |
| 18181 | Lakekeeper Iceberg REST and management API (a token is required; the catalog is the operator) |
| 15432 | Postgres (texera/texera; databases catalog, keycloak, openfga, lakekeeper) |

## End-to-end checks

`bin/texera-2-0/test.sh` runs the tests in four layers, `unit | contract | scenario | ui`, plus
`evals` (the real agents through the real model), `cluster` (the same scenarios and Playwright
against the Kubernetes deployment) and `gate` (a wiped stack, then everything). The scenarios
are pytest modules under `tests/e2e/`, one per use case; `docs/texera-2-0/TESTING.md` is the
guide: what each proves, the markers, the fixtures, how to add one.

## Kubernetes

The same stack on a local Kubernetes cluster, in one command:

```
bin/texera-2-0/k8s.sh up            # the kind cluster if missing, the six images, config, workloads, wait
bin/texera-2-0/k8s.sh check         # test.sh cluster: the scenarios and Playwright against the cluster
bin/texera-2-0/k8s.sh status        # pods, services, jobs
bin/texera-2-0/k8s.sh down          # delete the namespace (the cluster stays)
bin/texera-2-0/k8s.sh destroy       # delete the kind cluster
```

Open http://localhost:28088 (alice/alice, bob/bob). On Linux the cluster is [kind](https://kind.sigs.k8s.io)
(Kubernetes in Docker; `kind` and `kubectl` in `~/.local/bin` are enough), created with node
port 30088 mapped to localhost:28088. Another local cluster works with `TEXERA2_KUBE_CONTEXT`
set (`orbstack` on macOS with OrbStack; the gateway is made a LoadBalancer there, which such a
cluster publishes on localhost); remote clusters are refused. Two facts about this host shape the defaults: it is on cgroup
v1, so the node image is Kubernetes 1.33 (`TEXERA2_KIND_IMAGE` overrides), and kind needs
higher inotify limits than Ubuntu's defaults (`sysctl fs.inotify.max_user_instances=1024
fs.inotify.max_user_watches=1048576`).

What runs there: Postgres, Keycloak, OpenFGA, OpenBao (dev mode), RustFS, Lakekeeper (with
authentication and OpenFGA, bootstrapped by the catalog, reaching the public issuer through a
`socat` sidecar in its pod), the Envoy gateway, the catalog, one static computing unit, the
agent runtime, the live service, the bio MCP server and the frontend behind nginx, from `deploy/kubernetes/`
(kustomize) and the images under `bin/dockerfiles/`. The config maps are rendered from the
dev stack's own files (the realm, the gateway, the database bootstrap); the model key goes
from `.env` into a Secret and from there into OpenBao by the `openbao-init` job.

Computing units are resources there like everywhere else: a unit created with
`provider: kubernetes` (`POST /computing-units`, or the library's "New computing unit")
becomes a Deployment and a Service in the namespace, named after its rid, that the catalog
reconciles on every status probe; it reports pending until the engine answers, an execution takes
`computingUnit: <its URI>`, a changed spec (image, memory, cpu) rolls the Deployment at once
(the provider is fixed, and a unit with an execution on it answers 409 until it is over),
`terminate` removes the workloads, and the catalog's service account may do nothing else in
the cluster (`deploy/kubernetes/rbac.yaml`).

## AWS

The same manifests on EKS, from one command: `deploy/aws/deploy.sh up` makes the network, the
cluster and its Graviton nodes, the registry, the load balancer and the KMS key with Terraform
(`deploy/aws/cluster`), builds and pushes the images, applies `deploy/kubernetes` through a cloud
overlay (`deploy/aws/texera`: images by digest, the public URL, generated secrets, S3 as the
object store through pod identities, volumes on EBS, OpenBao with a volume and the KMS seal)
and loads the model key; `deploy/aws/deploy.sh check` runs the cluster checks against the
public URL. A domain and a certificate are two variables. `deploy/aws/README.md` has the whole
of it.
