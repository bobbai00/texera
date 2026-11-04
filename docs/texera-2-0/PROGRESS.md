# Texera 2.0 progress log

Newest first. Each entry: what was done, how it was verified, what is next.

## 2026-11-04 (session 6, on Linux): M1 steps S1 to S10

Done and verified (branch `texera-2-0`, each step a pushed commit):
- S1 Contract v2 under `api/catalog/`: the envelope, one file per kind (fifteen kinds), the
  subresources, the AuthZEN and OpenLineage routes, `x-texera-kind`, `x-texera-permission`
  and `x-mcp` (with the server); OpenFGA model v2 (owner, editor, viewer, user; parent;
  computed permissions). Actions are verb subresources (`/{rid}/run`), not `:verb`, because
  Go's router cannot match a colon inside a segment; the URI grammar never carried verbs.
- S2 `cmd/catalogen` emits the kind table (Go and TS), the JSON Schema bundle, the MCP tool
  table, the permission table and the index migration; oapi-codegen generates types only; the
  server is generic over the kind table and validated against the OpenAPI document in tests.
  `internal/uri` is the one grammar with round-trip tests and the reference extractor.
- S3 Stack: OpenBao (dev mode, `texera` KV v2 mount) with `up.sh` loading the model key over
  stdin; Envoy serves `/catalog/v1/settings/public` without a token and routes `/bio-mcp` to
  the bio MCP service copied from dknet-ai-public (`bio-mcp-service/`, a bun workspace,
  :23010, dev API key `texera-bio-dev-key`).
- S4 Store (eleven tables, generic over kinds, tests on the stack's Postgres) and ports
  (Identity, Authorizer, SecretStore, BlobStore, UnitProvider, LineageSink) with one adapter
  each plus memory adapters; contract suites pass in memory and against OpenBao, RustFS and
  OpenFGA under `-tags integration`.
- S5 `internal/catalog` (one Service, one file per area), `internal/server` (generic routes
  from the kind table plus the actions), `internal/mcp` (the bridge: a tool call is the
  operation's request against the API in process), `cmd/catalog` wiring. Tests: every
  response validated against the contract; every operation of the permission table routed;
  lifecycle, sharing, files, references and delete refusal, a run against a fake unit with
  OpenLineage events, ports, rows, save with derivedFrom and the lineage walks, conversations
  and turns, origins, credentials and leases, units and AuthZEN. `go test -p 1 ./...` green
  (the store and server suites share the test database, so serial).

Decisions taken while implementing (PLAN.md decisions still hold):
- The outbox relay flushes synchronously on the write path (`Relay.Flush`), so a resource is
  visible to the authorizer before its request answers; the background loop retries failures.
- Downloads are served as `application/octet-stream` as the contract says, with the file's
  own type in `X-Texera-Content-Type`; a ranged read answers 206 with `Content-Range`.
- A slash inside a file path is percent-encoded in the URL (`files/dir%2Ffile.csv`); the Go
  router also accepts the raw form.
- The run resolution order is request, workflow, project, settings; the settings singleton is
  seeded with the Data Analyst template, the default environment and the dev unit.
- `view=summary|full` applies to the operator list only (the property schemas are heavy);
  other lists carry full envelopes.

- S6 Engine, verified unchanged against the new catalog on the live stack. Per decision 7 the
  dev database and the OpenFGA store were dropped and recreated (the old `principal` table
  lacked `admin`), and Envoy was recreated so it knew the public settings and `/bio-mcp`
  routes. `smoke-catalog.sh` green end to end (seeds, versions, sharing, files and references,
  a conversation turn with an origin, both MCP servers: 10 catalog and 13 dataflow tools);
  `smoke-run.sh` green (validate, run, ports, rows, the used/produced/derivedFrom lineage,
  the saved CSV); `smoke-env.py` PASS (a UDF importing `humanize` fails without an
  environment and completes with one, the build shows `ready`, the execution pins `@1`).
- S7 Agent runtime rewritten as a stateless turn runner over contract v2: `config.ts` carries
  no model key (the endpoint and its leased secret come from the catalog), templates, skills,
  MCP servers and model endpoints are read by URI through `resolve`, the ReAct loop takes
  `interruptTools` and reports an `interrupted` outcome, the turn pins the template version
  at `startTurn`, persists each step through `replaceMessage`, handles `/mode` natively and
  runs the handoff loop (the conversation's template changes, `texera.handoff` is emitted).
  `bun test` 45/45, typecheck and lint clean. On the stack with the real model: the Data
  Analyst answered the iris question in 11.8 s (search, files, read, skill, create, validate,
  run, port result, answer); `smoke-chat.py --demo` ran the M1 scenario: the Bio Researcher
  gave three cited CRISPR off-target ideas, then handed the conversation to the Data Analyst,
  which built and ran the workflow and reported the averages; the conversation's template
  changed and every assistant message carries the template version that wrote it.

- S8 Frontend rebuilt on contract v2 (commit 60516ce70). The kinds package takes what a kind is
  from the generated kind table and names everything with the one URI grammar (`uri.ts`,
  mirroring `internal/uri`, with round-trip tests); a generic page renders any kind from its
  envelope: a form generated from the kind's JSON Schema (JSON a click away), versions, access
  (visibility and grants with principal search), lineage walked over the edge table plus the
  specs that reference it. One file per kind; folders for the workflow editor (the spec holds no
  positions, the app lays the graph out), the execution page (phase, operators, the port view
  with paged rows, save as dataset), the agent template form, the shared files tabs and the
  credential's write-only secret form. The engine WebSocket client is gone: runs are the
  catalog's. Routes are the catalog's paths (`/workflows/{rid}/executions/{eid}`); `?panel=`
  holds the same path. The chat labels every assistant message with the template version that
  wrote it, shows the current agent with a switcher that goes through `/mode`, and renders
  handoffs as dividers; the runtime records a handoff or a switch as a system note naming the
  new template (commit 7b20b051d). vitest 55 green; typecheck and lint clean.
- S9 Agents demo. Playwright on Chrome against the dev stack, six tests green: sign-in and a
  chat with an attachment that becomes a dataset; switching agents through the switcher and
  `/mode` without a model; creating an agent template from its page, editing it into v2 and
  starting a chat with it; a saved result's lineage (derived from the port, the run, the file it
  read); with the model, the Data Analyst's loop that tracks the workflow it built, and the Bio
  Researcher's cited ideas followed by the handoff to the Data Analyst, whose answer carries the
  averages and who then shares the dataset with Bob through the catalog server (checked as Bob).
  `smoke-chat.py --demo` runs the same three turns from the command line.

Decisions taken in S8 and S9:
- Names are unique per project and kind, so a new chat is named by its agent and its start
  time, and a second upload of the same file name gets its own dataset.
- The switcher sends `/mode <uri>` through the runtime rather than writing the conversation's
  spec itself: one path for a change of hands, recorded the same way whoever asked for it.
- System notes stay out of the model's history; the model sees a change of agent through the
  labelled messages.

- S10 Close. The gate ran as `down.sh --wipe && up.sh && test.sh` on this machine: the wiped
  stack came up with the model key loaded into OpenBao; thirteen steps, twelve green on the
  first run (catalog, runtime and frontend suites; engine `sbt test` 145 s and its integration
  suites 199 s; smoke-catalog, smoke-run, retention, environments, the real-model chat, the
  Playwright suite of six, the unit restart). The one failure was the demo's last turn: on a
  wiped stack Bob had never logged in, so `search_principals` found nobody to share with. The
  demo now logs Bob in first and passes (ideas, handoff, analysis, share, checked as Bob); the
  limitation and its extension point (a user search on the Identity port) are recorded in
  `API-REQUESTS.md`. Admins come from the Keycloak realm role `admin`, so no admins group is
  seeded. The frontend and dev READMEs, the root README table, the conventions note and the
  design doc ("Texera 2.0 Resource Model and Implementation Architecture", rev 19: the
  catalog and its peers, lineage, agents as templates, conversations and turns, and the
  closing sections) are current. M1 is closed.

- After the close, the two acceptance items not yet exercised live, now smoke tests in
  `test.sh`: `smoke-operator.py` (a custom Python operator created as a resource, used by its
  URI in a workflow, failing without its package and completing in a pinned environment, its
  column in the result, the workflow recorded as its dependent, deletion refused with 409) and
  `smoke-share.py` (Alice shares her project with Bob as viewer; Bob finds the workflow, the
  run and the dataset in search, reads them, runs the workflow on the platform's unit, and gets
  403 on edit, delete, lease and the grant list; revoked afterwards). Playwright gained the
  operator page: created from the library, its code in the generated form, found in a new
  workflow's palette by its URI. The sharing smoke needed one model change: `user` is no
  longer implied by `viewer` (an explicit grant, editors, or inherited), so a project viewer
  cannot lease its owner's credentials; the system project grants `user` to `user:*` so the
  platform's unit, credentials and model endpoint stay usable by everyone; environments need
  only `read`. All eleven acceptance items are now demonstrated.

- Sharing with people who have not logged in yet: the Identity port gained `SearchUsers`, the
  Keycloak adapter asks the admin API with the service client's token (the realm now gives
  `texera-services` the `view-users` role), and `Principals` merges the directory into the
  catalog's rows, recording a found person so they can be granted access; their first login
  takes the principal over (server test, live check against a never-logged-in admin, the
  share form in Playwright). The demo smoke no longer logs Bob in first.

- A custom operator declares the columns its code adds in `implementation.python.outputColumns`
  (typed `Attribute[]`), replacing the `x-texera-output-columns` key. The workflow editor keeps
  a person's canvas positions in their preferences (`canvas[rid]`), loaded when the editor
  opens and saved debounced after a move; the spec stays the engine's plan. A README for the
  catalog. `test.sh e2e` on the reused (not wiped) stack: the shell smokes now name what they
  make with a timestamp, since names are unique per project and kind, and the Playwright
  assertions accept the averages as the model rounds them.

- A screenshot tour of the generic pages (dataset, run, template, credential, model endpoint,
  environment, unit, project, settings, chat) found one bug: a link carrying `?panel=` lost
  its panel on arrival, because the panel sync's two directions undid each other; one ref now
  records the last value either side wrote, and the chat test reloads the page to prove the
  panel comes back. Also: the side panel has its own attribute (`data-side-panel`), library
  rows join description and facts cleanly, generated labels write URL, URI and ID, and the
  settings page is read-only for non-administrators. `test.sh e2e` on the reused stack:
  eleven of eleven, Playwright seven of seven.

- Credentials in operator properties (the user's pick). A property whose schema says
  `format: credential` holds a credential URI; when a run starts the catalog leases every
  credential the plan names for that execution, with the caller's permission, and puts the
  secret where the URI was in the plan the engine receives. Versions and executions keep the
  URI; a compile leaves it in place. A custom operator now receives its instance properties
  in its code as `PROPS` (they no longer reach the engine as operator properties), with
  credentials substituted. The property form shows a credential picker for such fields, and
  the workflow skill tells agents the rule. Checks: a server test on the plan the fake unit
  receives and on the stored documents, and `smoke-credential.py` on the stack (the code saw
  the leased secret, the version keeps the URI, a project viewer is refused until granted
  `user` on the credential).

- Kubernetes, in one command (the user's pick, with the unit provider next). `k8s.sh up`
  creates a kind cluster when missing (Kubernetes 1.33, since this host is on cgroup v1 and
  newer kubelets refuse it; inotify limits raised), builds the five images (catalog, agent
  runtime, frontend, bio MCP server, computing unit), loads them, renders the config maps from
  the dev stack's own files, puts the model key in a Secret that the `openbao-init` job moves
  into OpenBao, applies the kustomize manifests (now with OpenBao, the bio server, RBAC) and
  waits; `k8s.sh check` runs the smokes against the cluster. The gateway is a node port kind
  maps to localhost:28088. Playwright passes against the cluster.
- The Kubernetes unit provider. The UnitProvider port now names the unit (`Endpoint(rid,
  spec)` reconciles, `Terminate(rid, spec)` releases); the `kube` adapter makes a unit of
  `provider: kubernetes` a Deployment and a Service in the catalog's namespace, named after
  the rid, with the spec's image and the master node's memory and cpu, under a service account
  that may touch nothing else (`rbac.yaml`); `unitmux` offers static and Kubernetes units side
  by side; deleting the resource terminates it. A `user` grant on a unit now lets a person
  compile, build and run on it without reading its spec, as the model always said (the run,
  validate and build paths loaded the unit through the read-checked lookup). Checks: the
  adapter against the fake clientset, a server test for a user-only grant, and
  `smoke-k8s-unit.py` on the cluster: ready in 10 s, a run completes, Bob refused then allowed,
  terminate removes the workloads, delete succeeds.

Next: Lakekeeper on OpenFGA and retention, as agreed; then quotas and groups.

## 2026-11-03 (session 5, on Linux)

Done and verified:
- The dev stack runs as local processes on any Docker host (Ubuntu 20.04 here); no OrbStack, no
  Kubernetes. Lakekeeper's base URI is `localhost:18181` and the warehouse's S3 endpoint is
  `127.0.0.1:19001` on both sides: the host's published RustFS port, and inside Lakekeeper's
  network namespace a socat sidecar (`lakekeeper-s3`) forwarding to the rustfs container.
  `k8s.sh` and `deploy/kubernetes` stay as a deployment check, out of the development path.
- The engine's Python environment is managed by uv: a repo-root `pyproject.toml` (Python 3.12,
  the pins of `amber/*requirements.txt`, torch CPU on Linux x86_64) with `uv.lock` committed;
  `up.sh` runs `uv sync --all-extras` and `bin/python-proto-gen.sh` when `.venv` is missing, and
  the unit and `test.sh` run workers from `.venv/bin/python`. `up.sh` checks the prerequisites,
  finds Go/bun/uv under `~`, and reads `ANTHROPIC_API_KEY` from a gitignored repo-root `.env`
  (`export` lines allowed). Playwright drives the installed Google Chrome where it ships no
  Chromium for the host. `stop` in `lib.sh` waits for the process to exit, so a unit restart no
  longer races the actor port.
- The agent runtime runs the Dataflow Agent's ReAct loop on AI SDK 7
  (`agent-runtime/src/run/react-loop.ts`): before every model call `prepareStep` renders the
  turn's state into the system prompt (step budget, the resources the turn touched with the
  ids to reuse, whether a result was shown); `onStepFinish` records each step; the answer policy
  (`free` or `after_result`) sends a reply that computed nothing back with a correction, once by
  default; a provider refusal is retried once and a cut-off reply continued once; the step limit
  and a refusal end the turn as `RUN_ERROR`; corrections are `texera.correction` CUSTOM events.
  The contract gained `AgentTemplateSpec.loop` (LoopSpec: answer, resultTools, maxSteps,
  temperature); `make generate` regenerated the Go server, the TS client and the MCP table.
- The Data Analyst template follows the Dataflow Agent: a prompt with the role, the resources,
  the way of working and the answer rule; `loop.answer = after_result`; three skills the
  platform ships as SKILL.md (`catalog/internal/server/skills/`, embedded, the license comment
  stripped before storage): texera-workflows, python-udf, reading-results, loaded on demand with
  `load_skill`. A changed shipped skill gets a new version authored by the platform.
- Verified: `up.sh` from a clean checkout; `smoke-catalog.sh`; `smoke-run.sh` (a run through
  Lakekeeper and RustFS, the result saved as a dataset version); the runtime's `bun test` 49/49
  with typecheck and lint; the frontend's typecheck, lint and vitest; the catalog's
  `go test ./...` on the stack's Postgres; `smoke-chat.py` with Claude Haiku 5.5 PASS (turn 1:
  search, list files, read the header, load_skill, create, validate, run, read rows, answer in
  9 steps and 10.6 s with the right averages; turn 2 edits to v2 and reruns in 5 steps; the save
  turn makes a dataset version with lineage to the run; no correction was needed); Playwright
  4/4 on Chrome, the real-model Data Analyst test included. Docs: the handoff and design docs
  are copied under `docs/texera-2-0/claude-docs/`.

- Prompt caching: the instructions are a cacheable system message in AI SDK 7's `instructions`
  option, the conversation's newest message carries a second breakpoint, and the turn's state is
  re-rendered as the newest user message (not in the system prompt, which broke the cached
  prefix). The MCP `list_operators` without `q` or `group` is a compact list (types, names,
  groups, descriptions); with them, the schemas and ports as before. Tests in both packages.
  Measured on a real Data Analyst turn: 99,330 of 116,579 input tokens read from cache (Haiku
  writes cache increments only above its 2k-token minimum, so small steps are not re-cached);
  a bare `list_operators` is 43 KB instead of 910 KB.
- `bin/texera-2-0/test.sh` end to end on this machine: 13 of 13 checks pass in 8 m 35 s,
  including the engine integration suites and the unit-restart check that failed in the handoff.

Next:
- The frontend's template editor does not expose `loop` yet; the catalog accepts it.
- CI installs the engine's Python with `uv pip install -r amber/*requirements.txt`; switch CI
  and the images to the lockfile (`uv sync`) so one definition serves all three.
- Tool approval (AI SDK `toolApproval` + AG-UI interrupts), A2A tasks and sub-agents remain
  unwired, as before.

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
