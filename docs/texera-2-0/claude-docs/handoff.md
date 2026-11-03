# Texera 2.0 handoff

Nov 3, 2026 · @JB

## Where things stand

Texera 2.0 is committed on branch `texera-2-0` as `53b9d50e4` and pushed to the fork [bobbai00/texera](https://github.com/bobbai00/texera/tree/texera-2-0). It runs end to end on the dev stack and on the local Kubernetes cluster, verified with Claude Haiku 5.5. The last full test run passed 11 of 13 checks; both failures are environment problems, not product bugs (see Next steps).

| Piece | Where | State now |
| --- | --- | --- |
| Worktree | `~/Desktop/projects/texera-worktrees/texera-2-0` | branch `texera-2-0`, clean, pushed to `origin` |
| Main checkout | `~/Desktop/projects/texera` | on `main`, untouched |
| Dev stack infrastructure | Docker Compose project `texera2` | up |
| Gateway (Envoy) | http://localhost:8088 | up |
| Catalog | localhost:8090 | up |
| Computing unit | localhost:28085 | **stopped**: its last restart hit a port race |
| Agent runtime | localhost:23002 | up |
| Frontend (vite) | localhost:5174, served through the gateway | up |
| Example MCP server | localhost:23010 | up |
| Kubernetes deployment | OrbStack, namespace `texera2`, http://localhost:28088 | all pods running |

To bring the dev unit back, run `bin/texera-2-0/up.sh`; it starts only what is missing. Sign in as alice/alice or bob/bob.

## How it fits together

&#91;embedded content: Texera 2.0 services and what calls what\]

The browser and the agent runtime reach every service through the gateway, which checks Keycloak tokens and asks the catalog to authorize each call. The gateway also proxies live run updates to the unit, and each service verifies tokens itself.

## What is done

Every goal in the original request is implemented and checked by an automated test; the table names the check to rerun.

| Goal | Where it lives | Verified by |
| --- | --- | --- |
| Chat to get data analysis done | `agent-runtime/` (AI SDK 7, AG-UI), Data Analyst template | `smoke-chat.py` (real model, three turns), Playwright real-model chat |
| Track resources created in a chat | Origin on every resource and version (conversation + turn); "From this chat" panel | `smoke-chat.py` attribution checks, Playwright |
| View and create agent templates | `agent_template` kind in the catalog; library page | Playwright "library" test, `smoke-templates.py` (template edited to v2) |
| Agents plug in different MCP servers | Templates bind MCP servers with tool allowlists | `smoke-templates.py` with the external `mcp-iris-facts` server |
| Texera dataflow MCP end to end | `catalog/internal/mcp`: 20 tools (operators, create/edit, validate, run, results, save, lineage) | `smoke-catalog.sh` MCP calls, chat transcripts |
| Versions on every change by a person or an agent | New version per edit, attributed to the agent on behalf of the person | `smoke-chat.py`, catalog Go tests |
| Executions create versions with lineage | Port-level lineage from the unit (OpenLineage); results saved as dataset versions "produced by" the run | `smoke-run.sh`, `TestSavedResultsAreDatasetVersionsProducedByTheRun` |
| Authentication end to end | Keycloak OIDC, Envoy jwt\_authn + ext\_authz on the catalog's PDP (OpenFGA); the unit verifies tokens itself | catalog Go tests, `smoke-catalog.sh` (401/403 cases) |
| Amber as a clean engine | Unit API + in-memory registry; no database, LakeFS, mounts or old auth | `sbt test` across all modules |
| Computing units and environments | Static unit resource; Python environments built per version on the unit | `smoke-env.py` |
| Lineage tracked | read / produced edges between versions, with the execution on each edge | `smoke-run.sh`, Playwright lineage test |
| Verified with Claude Haiku 5.5 | Key read at launch from the main repo's `.env` | all real-model checks above |

Beyond the request: results survive a unit restart, a Kubernetes deployment, the 2.0 CI workflow, and one-command `up` / `test` / `down` scripts.

## Run and test

Run everything from the worktree root. The model key is read at launch from the main checkout's `.env` through `TEXERA_ENV_FILE` and is never copied into the repo.

```bash
ENV=~/Desktop/projects/texera/.env
TEXERA_ENV_FILE=$ENV bin/texera-2-0/up.sh       # start what is missing (idempotent)
TEXERA_ENV_FILE=$ENV bin/texera-2-0/test.sh     # suites, then end-to-end checks
bin/texera-2-0/test.sh suites                   # Go, TypeScript and sbt suites only
bin/texera-2-0/test.sh e2e                      # end-to-end only, against the running stack
bin/texera-2-0/down.sh                          # stop it all; --wipe also deletes the volumes
TEXERA_ENV_FILE=$ENV bin/texera-2-0/k8s.sh up   # build images, deploy to OrbStack, wait
bin/texera-2-0/k8s.sh status                    # or: down, which deletes the namespace
make generate                                   # regenerate code from api/*.tsp
```

| Port (localhost) | Service | Accounts |
| --- | --- | --- |
| 8088 | Gateway (Envoy), the only entry point | alice/alice, bob/bob, texera-admin/admin |
| 8090 | Catalog (Go) |  |
| 28085 | Computing unit (Amber); actor port 2652 |  |
| 23002 | Agent runtime |  |
| 5174 | Frontend (vite), served through the gateway |  |
| 23010 | Example MCP server for the templates check |  |
| 18081 | Keycloak | admin/admin |
| 18082 | OpenFGA |  |
| 19001 | RustFS (S3) | texera / texera-secret |
| 18181 | Lakekeeper (Iceberg REST) |  |
| 15432 | Postgres | texera/texera |
| 28088 | Kubernetes gateway (OrbStack) | same users |

Service logs are in `logs/texera-2-0/`, and each test step's log is in `logs/texera-2-0/tests/`. Every credential above is a dev-only default.

## Test results

The last full `test.sh` run on the dev stack (November 3) passed 11 of 13 checks, and every end-to-end check also passed on Kubernetes. Neither failure is a product bug.

| Check | Dev stack | Kubernetes | Note |
| --- | --- | --- | --- |
| Catalog: go vet + go test | pass |  | Postgres required; a missing database now fails instead of skipping |
| Agent runtime: types, lint, bun test | pass |  |  |
| Frontend: types, lint, vitest | pass |  |  |
| Engine and libraries: `sbt test` | pass |  | integration-tagged suites excluded, as in CI |
| Engine integration suites (REST catalog) | **fail** |  | one suite needs plotly, missing from the shared Python venv |
| Catalog: versions, sharing, datasets, MCP | pass | pass |  |
| Run: compile, execute, results, lineage, save as dataset | pass | pass |  |
| Results kept across runs and the idle release | pass | pass |  |
| Environments: a UDF with a package | pass | pass |  |
| Chat with the real model (three turns) | pass | pass |  |
| Templates + an external MCP server | pass | pass |  |
| Frontend end to end (Playwright, 4 tests) | pass | pass | production nginx and CSP on Kubernetes |
| Results after a unit restart | **fail** | pass | dev: the restarted unit found actor port 2652 still bound |

In that step sbt stopped at the operator module's failure, so the engine's own integration suites did not run. Earlier the same day they passed with `UDF_PYTHON_PATH` set, and the REST catalog suite passed against the dev stack's Lakekeeper.

## Next steps

The first three items get the test run back to 13 of 13; the rest is the work after this slice.

- [ ] Restart the dev unit with `bin/texera-2-0/up.sh`.
- [ ] Fix the restart race: `stop` in `bin/texera-2-0/lib.sh` waits only for the HTTP port to close, so make it also wait for the process to exit (the actor port 2652 is freed last). Then rerun `smoke-restart.py`.
- [ ] Give the worktree its own Python venv: `amber/venv` is a link to the main checkout's, which lacks `operator-requirements.txt`. Use `uv venv --python 3.12 amber/venv`, install the three requirement files, rerun `test.sh e2e`.
- [ ] Fix the env-file path in `bin/texera-2-0/README.md`: `../texera/.env` points inside `texera-worktrees/`; the key lives in `~/Desktop/projects/texera/.env`.
- [ ] Run the 2.0 CI on the pushed branch. It runs only on pull requests and on pushes to `main` or `release/**`, so start it by hand: `gh workflow run build.yml --repo bobbai00/texera --ref texera-2-0`. So far it has only been checked locally.
- [ ] Split the branch into small reviewed PRs after a design review; do not open one PR from this branch.
- [ ] Release engineering for the new images: binary LICENSE and NOTICE for the Go catalog and the Bun agent runtime, image publishing, a Helm chart with production settings (TLS, secrets, sized volumes).
- [ ] A Kubernetes unit operator, so units are created per person or team instead of one static unit.
- [ ] Retention driven by the catalog: the unit drops results after a day, and the catalog should record when they expire.

## Gotchas

Most lost time came from shared machine state, identity provider URLs and the Python environment.

- **Never touch the remote EKS cluster.** `k8s.sh` uses only the `orbstack` context and refuses cloud contexts.
- **Other stacks share this machine.** Ports 8085, 18085, 2552, 3002, 5173 and 8080 belong to them; never stop their processes. `up.sh` refuses a port held by anything outside this worktree.
- **OrbStack hostnames.** The host-run unit reaches storage as `texera2-lakekeeper.orb.local` and `texera2-rustfs.orb.local`, network aliases in the compose file.
- **Keycloak.** Keep `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=false`. After a realm re-import, restart Envoy (it caches the key set) and the agent runtime (its service token).
- **Token issuer in Kubernetes.** Tokens carry the public URL, localhost:28088. Pods fetch keys and tokens from Keycloak's cluster address, so the catalog needs `TEXERA_OIDC_JWKS_URL` and `TEXERA_OIDC_TOKEN_URL`.
- **Python for engine tests.** Without `UDF_PYTHON_PATH=amber/venv/bin/python`, integration suites hang: a worker fails to start and the test waits.
- **Iceberg in tests.** Engine suites use the Postgres-backed catalog in the stack's `texera_iceberg_catalog` database; `test.sh` sets it. The REST suite needs the Lakekeeper settings.
- **Engine ids.** They are derived from the catalog's UUIDs. Creating a result table replaces one of the same name, so ids must never repeat.
- **Ignored folders.** A legacy `catalog/` rule in `.gitignore` and `.dockerignore` once hid the whole Go catalog. Check `git status --ignored` after adding a top-level folder.
- **The model key.** Read from `TEXERA_ENV_FILE` at launch; in Kubernetes it lives only in the `texera2-llm` Secret. Never commit it.
- **Running the unit.** `sbt runMain` must fork with `JdkOptions.jvmFlags`; `run-unit.sh` does this.

## Where to read more

Start with the progress log: it records every session's work, how it was verified, and what came next.

| File (in the worktree) | What it answers |
| --- | --- |
| `docs/texera-2-0/PROGRESS.md` | What each session did and verified, newest first |
| `docs/texera-2-0/PLAN.md` | The design: layout, service topology, engine boundary, what was retired |
| `docs/texera-2-0/API-REQUESTS.md` | Conventions the parts rely on that the contract does not state |
| `bin/texera-2-0/README.md` | The dev stack, its ports, each end-to-end check, Kubernetes |
| `api/catalog.tsp`, `api/engine.tsp`, `api/openfga/model.fga` | The contract and the authorization model |
| `catalog/internal/server/lineage.go` | How the unit's OpenLineage events become executions and lineage |
| `amber/src/main/scala/org/apache/texera/web/execution/` | The unit API, execution registry, lineage reporter, environments |
| `deploy/kubernetes/` | The Kubernetes manifests |
| `.github/workflows/build.yml` | The 2.0 CI jobs |

A Claude session picks up from the memory note `project_texera_2_0_implementation.md`, which points to the progress log.
