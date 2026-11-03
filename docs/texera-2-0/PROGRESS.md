# Texera 2.0 progress log

Newest first. Each entry: what was done, how it was verified, what is next.

## 2026-11-03 (session 4)

Done and verified:
- The engine has no metadata layer left. Deleted `common/dao` (jOOQ, MockTexeraDB), `common/auth`
  and `sql/`; nothing in `amber/` or `common/` opens a database or imports those packages.
  The unit's caller is a `UnitPrincipal` built from the verified token (subject, name, email,
  role); WebSocket handshakes verify the token too, and the old mode that trusted `x-user-*`
  headers from the retired access-control service is gone. From workflow-core and the
  operators: the LakeFS documents and client, `RepositoryMountManager` with the execution-time
  binding on `PhysicalOp` (the scheduler no longer asks a mount authority before workers run),
  the file-lister operator, the database dataset resolution in `FileResolver` (datasets arrive as
  catalog-presigned URLs; local paths still work), and the CSV column limit read from a database
  table (now `constants.csv-max-columns`). UDF dataset/model parameters carry the URL the catalog
  resolved. The cost estimator reads the previous run's runtime statistics from the workflow
  context the unit fills from its registry. Engine specs moved off MockTexeraDB onto the
  in-memory registry (`ExecutionRegistry.adopt/forget` for fixtures).
- Results after a unit restart: the catalog passes the table its lineage recorded
  (`?table=` on the unit's result route) and a unit that no longer holds the run reads it there,
  after checking the table is that execution's result for that port (`recordedResult`).
  `smoke-restart.py` restarts the unit and reads an old run's results.
- A duplicate start of one execution id is refused atomically (409).
- CI for 2.0: `.github/workflows/build.yml` (contract drift, Go catalog with Postgres, TypeScript,
  engine with Postgres-backed Iceberg + binary LICENSE/NOTICE check, Python worker), uploads
  coverage per flag (`codecov.yml` rewritten); `required-checks.yml` and the backport caller
  updated. Not run on GitHub from here; YAML validated and every step's command run locally.
  `amber/LICENSE-binary-java` and `amber/NOTICE-binary` regenerated (409 jars match exactly).
  TypeSpec and hey-api packages pinned to the lockfile versions. `.gitignore` and
  `.dockerignore` no longer ignore `catalog/` (a 1.x rule that hid the whole Go catalog).
- Kubernetes: `deploy/kubernetes` (kustomize, namespace `texera2`) with images
  `bin/dockerfiles/{catalog,agent-runtime,frontend,computing-unit-master}.dockerfile`;
  `bin/texera-2-0/k8s.sh up|status|down` builds, renders the realm/gateway/warehouse config from
  the dev stack's files, creates the model-key secret and waits. The catalog takes explicit
  `TEXERA_OIDC_JWKS_URL`/`TEXERA_OIDC_TOKEN_URL` so in-cluster services verify tokens whose issuer
  is the public URL. The frontend image serves dist/ with nginx and the app's CSP, rendered by
  `frontend-next/scripts/nginx-conf.ts` from `security-headers.ts`. On OrbStack:
  smoke-catalog, smoke-run (with save + produced lineage), smoke-retention, smoke-env,
  smoke-chat (real model, three turns), smoke-templates (external MCP via host.docker.internal)
  and Playwright 4/4 all pass against `http://localhost:28088`.
- `test.sh` now runs every sbt module (`sbt test`, integration-tagged suites excluded) in
  `suites`, and the integration-tagged engine suites against the dev stack's Lakekeeper plus the
  unit-restart check in `e2e`. Go tests fail instead of skipping when Postgres is missing.

Next:
- Release engineering for the new images: binary LICENSE/NOTICE for the Go catalog and the Bun
  agent runtime, image publishing, a Helm chart with production settings (TLS, secrets,
  persistent volumes sized for use).
- A Kubernetes unit operator (units created per person or team) on top of the static unit.
- Retention driven by the catalog: tell it when a run's results expire.

## 2026-11-03 (session 3)

Done and verified:
- Executions produce versions. `POST /catalog/v1/executions/{eid}/results/{opid}/{port}/save`
  (MCP tool `save_result_as_dataset`, 20 tools now) writes a completed run's port result as a CSV
  into a new or existing dataset and commits a version, attributed like any write (agent on behalf
  of the person, origin the chat turn). Lineage gets a `produced` edge from the workflow version
  the run executed to the dataset version, with the execution on the edge, so the chain reads
  dataset@v <- workflow@v <- the dataset versions it read. Saving refuses incomplete runs and
  datasets with hand-staged files. Result pages keep exact numbers (json.Number) from the unit.
  The run page has a "Save as dataset" button; the lineage view labels edges by direction
  ("produced by", "read by").
- Built-in templates follow the platform: on start the catalog compares each built-in template's
  spec with the shipped one and, when they differ, writes a new version authored by the platform
  ("updated by the platform"). The Data Analyst prompt now mentions saving results.
- Chat history replays as steps. A recorded assistant turn (text, calls, results, more text) used
  to be replayed as one assistant message plus one block of results, so the model saw its answer
  before the results it was based on and apologized for it in later turns. It is now replayed
  step by step; calls without a recorded result get an error result so the history stays valid.
- Execution results outlive the run. A new run no longer clears the previous run's results, and
  the unit's idle release (30 s after a run with nobody watching) keeps them; only the retention
  sweep (`result-cleanup.ttl-in-seconds`, one day by default) drops stored results, through
  `amber/.../web/execution/ExecutionStorage`. The old clean-up only stayed harmless because a
  32-bit narrowing of workflow ids kept it from ever matching.
- Engine ids come from the catalog's UUIDs (`EngineIds`, both halves mixed): execution ids from the
  catalog's execution id (a fresh UUID for WebSocket runs), workflow ids from the rid. Result tables
  are named by (workflow id, execution id) and creating one replaces an existing table, so the old
  per-process counter would have overwritten earlier runs' tables after a unit restart or across
  units. "Newest run" uses a creation sequence.
- Retired and deleted: access-control-service, computing-unit-managing-service, config-service,
  file-service, workflow-compiling-service, notebook-migration-service, common/resource, the
  Angular frontend, agent-service, pyright-language-service, and under bin/ local-dev,
  single-node, k8s, the forum, y-websocket-server, pylsp, the mounter and their Dockerfiles. The
  operator icons moved to `frontend-next/public/operator-images`. LICENSE no longer lists deleted
  assets and lists `bin/texera-2-0/examples/iris.csv`; orphaned license texts are gone.
- A repeated start of one execution id gets 409 and leaves the running execution alone (the id is
  claimed atomically; before, a racing duplicate could shut the run down and report it failed).
- One command each: `bin/texera-2-0/up.sh` (idempotent, refuses ports held by other stacks),
  `down.sh [--wipe]`, `test.sh [suites|e2e]` (helpers in `lib.sh`). Verified from a cold start.

Verification (all on the live stack, real model claude-haiku-5-5):
- `test.sh` (11 steps, all pass, twice, once from a cold `up.sh`): catalog go vet + uncached go
  test; agent runtime types, lint, 41 tests; frontend types, lint, 49 tests; engine specs
  (`org.apache.texera.web.*` plus ReadonlyHttpFileDocumentSpec); smoke-catalog, smoke-run (with
  save + produced lineage), smoke-retention, smoke-env, smoke-chat (three turns: build, edit +
  rerun, save as dataset), smoke-templates, Playwright 4/4 (sign-in and attach, library,
  real-model chat, save from the run page with lineage).
- New catalog tests: TestSavedResultsAreDatasetVersionsProducedByTheRun (in-memory S3 fake in the
  harness, exact numbers, CSV quoting, carried-forward files, staged-file conflict, access, failed
  runs), TestBuiltInTemplatesFollowThePlatform.

Next:
- `common/dao` and `sql/`: replace the `User` POJO in common/auth with an engine principal and move
  the engine specs off MockTexeraDB; then drop both.
- `FileResolver` still carries the LakeFS/database dataset path; 2.0 reads presigned URLs only.
- CI: `.github/workflows` and `codecov.yml` still describe the 1.x build; a 2.0 pipeline runs
  `test.sh suites` and `make check-drift` once the generated files are committed.
- Results after a unit restart: the unit's registry is in memory, so an old run's results can no
  longer be paged through a restarted unit although the tables remain. Serve reads by the recorded
  table, checked against the engine id derived from the catalog's execution id.
- Retention is unit-local; the catalog should learn when a run's results expire, and saved
  datasets are the way to keep them.
- A 2.0 Kubernetes deployment (unit operator, the Kubernetes sandbox provider).

## 2026-11-03 (session 2)

Done and verified:
- Amber is a pure engine. Deleted from `amber/`: every dashboard/auth/hub/admin/quota/model/
  dataset/workflow/PVE/AI-assistant/email/result-export resource, `TexeraWebApplication`, HS256
  `JwtAuth`, and all SQL (SqlServer/jOOQ tables/DAOs). Replaced by `web/execution/`:
  `ExecutionRegistry` (in-memory execution records), `UnitApiResource` (the unit API of
  `api/engine.tsp`: health, operators in the contract's OperatorTypeList shape, compile,
  executions start/status/cancel/results, environments build/status), `LineageReporter`
  (OpenLineage run + operator events to the catalog), `EnvironmentManager` (one venv per
  environment version, layered on the unit's base Python through a .pth, uv when available),
  `UnitJwtAuth` (RS256 via Keycloak JWKS, issuer + audience). `ReadonlyHttpFileDocument` in
  workflow-core lets scans read presigned dataset URLs. Actor and HTTP ports are configurable
  (`TEXERA_ACTOR_PORT`, `TEXERA_UNIT_PORT`). The remaining DAO dependency is POJO-only
  (`User`, `UserRoleEnum` via common/auth); no database is opened.
- jOOQ sources are generated against the texera2 Postgres (`texera_db` from `sql/texera_ddl.sql`;
  the pgroonga errors are expected): `STORAGE_JDBC_URL=jdbc:postgresql://localhost:15432/texera_db?currentSchema=texera_db,public STORAGE_JDBC_USERNAME=texera STORAGE_JDBC_PASSWORD=texera sbt DAO/jooqGenerate`.
- Unit runs on the host: `bin/texera-2-0/run-unit.sh` (HTTP :28085, actor :2652; 8085/18085/2552
  belong to other stacks on this machine), `stop-unit.sh` stops only this worktree's unit.
  Python: `amber/venv` symlinks to the main repo's 3.12 venv; Python protos via
  `PATH=<venv>/bin:$PATH bin/python-proto-gen.sh`.
- Shared hostnames for host + containers (OrbStack): `texera2-rustfs.orb.local:9000` and
  `texera2-lakekeeper.orb.local:8181` (network aliases in the compose file; Lakekeeper base URI
  and warehouse endpoint use them).
- `bin/texera-2-0/smoke-run.sh` passes: dataset iris v1 → workflow scan→aggregate v1 → validate on
  the unit (schemas) → run (completed; scan 150 tuples, avg 3) → paged results (correct means)
  → lineage: version_edge dataset@1→workflow@1 (read, eid), port_input, port_edge, port_result.
- Fixed: unit operator registry fetch carries the service token; state-store diff handlers only
  fire with a WebSocket subscriber, so the reporter subscribes to the hot state stream.

- Real-model chat (Claude Haiku 5.5) passes end to end (`bin/texera-2-0/smoke-chat.py`, as bob):
  turn 1 the Data Analyst agent searches, reads the CSV header, creates a workflow (v1),
  validates, runs on the unit and answers correctly; turn 2 it edits the same workflow with a
  JSON patch (v2, message recorded) and reruns. Workflow, versions and executions carry
  createdBy=agent, onBehalfOf=person, origin={conversation, seq}; user messages are authored by
  the person; lineage dataset@1 -> workflow@1 and @2.
- Provenance plumbing: the runtime's per-turn `TurnContext` sends X-Texera-Agent,
  X-Texera-Service-Token and X-Texera-Origin to the built-in MCP server only (third-party MCP
  servers never get the person's token); the catalog honors the origin only with a valid agent
  assertion and prefers it over a body-supplied origin; Envoy passes these headers to ext_authz.
- Typed workflow content in the contract (WorkflowContent/WorkflowOperator/WorkflowLink,
  JsonPatchOperation, EditWorkflow): the MCP tool schemas are real objects now (the model had
  been sending `content` as a string when the schema was `true`). MCP tools return file text for
  binary responses (read_dataset_file). MCP in-memory tests in `catalog/internal/mcp`.
- Templates + pluggable MCP (`smoke-templates.py`): bob registers an external MCP server
  (`agent-runtime/examples/mcp-iris-facts`, :23010), creates a template binding it with an
  allowlist beside the built-in server, edits it to v2, chats in that mode; the agent uses
  species_facts and convert_length together with run_workflow.
- Environments (`smoke-env.py`): a Python UDF importing `humanize` fails without an environment
  and completes with one (`humanize==4.11.0`, built by the unit in ~5 s); the execution records
  the environment version.
- Agent runtime on :23002 (`run-agent-runtime.sh`, key from TEXERA_ENV_FILE); 3002 belongs to
  another stack.

- Catalog HTTP test suite (`catalog/internal/server/{harness,api}_test.go`): a local OIDC issuer
  (RSA/JWKS/client credentials) and a fake unit that reports OpenLineage back; covers auth,
  seeded modes, versioning/patch/conflict, PDP sharing, agent attribution + origin precedence,
  runs with port lineage and failure reporting, MCP over HTTP (401 carries resource_metadata),
  ext_authz. Run with `go test -p 1 ./...` (store and server tests share catalog_test).
- Frontend on the live stack: `frontend-next` (vite :5174 behind Envoy) with OIDC PKCE; Playwright
  `e2e/texera2.spec.ts` passes 3/3 including the real-model core loop (bob asks the Data Analyst,
  answer with the right means in ~12 s, the built workflow listed under "From this chat", opened
  beside with canvas, versions and lineage). Fixes on the way: Keycloak realm (built-in scopes
  kept, audience mapper on the clients, pinned user ids), `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=false`
  (dynamic URLs lost the gateway port), Envoy must be restarted after a realm re-import (JWKS
  cache), message parts persisted in stream order, ResourceRef with kind in message parts and
  `kind` on ResourceVersion, listings no longer reported as touched resources, Select shows labels.

Next (updated 2): retire the old services and Angular from the build, one-command up/test scripts, docs.
Old next: agent runtime live with Haiku 5.5 (template → MCP tools → workflow → run → answer), an
external MCP server plugged into a template, a Python UDF in a custom environment, the frontend
against the live stack (fork stopped at "app builds"), then delete retired services.

## 2026-11-03 (session 1, ended at the usage limit)

Done and verified:
- Contract: `api/common.tsp`, `api/catalog.tsp` (79 operations, 19 tagged `x-mcp`), `api/engine.tsp`
  (the unit API), `api/openfga/model.fga`. `make generate` emits OpenAPI 3.0/3.1 to `gen/openapi/`,
  the Go strict server (`catalog/internal/api`), the Go unit client (`catalog/internal/engine`), the
  MCP tool table (`catalog/internal/mcp/tools.gen.go` via `cmd/mcpgen`) and the TypeScript client
  (`packages/catalog-client`, hey-api with TanStack Query + Zod; TS 5.9 pinned for the generator).
- Dev stack `bin/texera-2-0/` (project `texera2`): Postgres 15432, Keycloak 18081 (realm `texera`,
  users alice/bob/texera-admin, clients `texera-app` PKCE and `texera-services` client-credentials,
  tokens carry `sub`, `aud=texera`, issuer `http://localhost:8088/auth/realms/texera`), OpenFGA 18082,
  RustFS 19001 (buckets `texera`, `datasets`), Lakekeeper 18181 (warehouse `texera`), Envoy 8088
  (jwt_authn on Keycloak JWKS, ext_authz to the catalog, routes to host services; public routes skip
  ext_authz). README in that directory.
- Catalog (Go, `catalog/`): store with migrations and integration tests (`catalog_test` db), OIDC
  verification (go-oidc; discovery must use Keycloak directly on 18081 because Keycloak rewrites
  URLs from X-Forwarded headers), service tokens, OpenFGA model + outbox drainer, PDP (grants
  authoritative, OpenFGA secondary), ext_authz endpoint, all 79 handlers, S3 datasets with staged
  files and immutable version prefixes, workflow content→logical plan conversion with
  `dataset://rid@vno/path` resolution to presigned URLs, executions + OpenLineage ingestion
  contract (see `internal/server/lineage.go`), agents, conversations/messages, seeded system
  principal, static unit, built-in `texera` MCP server, `python-default` environment, templates
  "Data Analyst" and "General", MCP server (go-sdk, bearer auth, stateless streamable HTTP).
  `go build ./... && go vet ./... && go test ./internal/...` green.
- `bin/texera-2-0/smoke-catalog.sh` passes through the gateway: whoami, seeds, workflow create by
  content, edit by JSON patch (v2), structural validation error, versions, lineage, sharing
  (bob 403 → viewer → 200, edit 403), dataset upload/commit/files/download/presign, conversation +
  agent spawn + message + resources-from-chat, MCP initialize/tools/list (19 tools)/tools/call,
  MCP 401 without a token.
- Agent runtime (`agent-runtime/`, built by a fork): AI SDK 7 ToolLoopAgent, AG-UI SSE endpoint,
  minimal A2A, MCP tools over the user's token, skills, sandbox interface; 35 tests green. It uses
  its own fetch layer over the contract because of the client-config path bug, now fixed in
  `packages/catalog-client/openapi-ts.config.ts` (`runtimeConfigPath: ./src/client-config.ts`).
- Frontend fork was still running when the session ended; check `frontend-next/README.md` and
  `docs/texera-2-0/API-REQUESTS.md` for what it produced.

Running processes left on the host: the catalog (`catalog/bin/catalog`, log in the session
scratchpad), the dev stack containers.

Next (in order):
1. Engine boundary in `amber/`: `POST /api/executions` (ExecutionStartRequest), `/api/compile`,
   `/api/operators`, `/api/executions/{eid}/results/{opid}/{port}`, `/api/environments`, JWKS auth,
   https readonly file documents, ExecutionReporter posting OpenLineage events per the contract in
   `catalog/internal/server/lineage.go`, no Postgres. Run it on the host at :8085 (sbt, per the memory
   note on JdkOptions) so the seeded static unit turns `ready`.
2. Wire the agent runtime against the live catalog (`bun run dev` on 3002) and run a real-model
   turn with `ANTHROPIC_API_KEY` from the main repo's `.env` (model `claude-haiku-5-5`).
3. Frontend against the live stack at `http://localhost:8088/`.
4. Delete the retired services and Angular; update `docs/texera-2-0/PLAN.md`.
