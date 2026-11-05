# Texera 2.0 implementation plan

Branch `texera-2-0`, in its own worktree of the main checkout. The design is the Claude Doc
"Texera as the Workspace for Agentic Collaborative Research" (rev 67). The resource model and
the implementation architecture settled on 2026-11-03 are in the Claude Doc "Texera 2.0
Resource Model and Implementation Architecture"
(https://claude.ai/artifact/LCDUYos77DAM24TL1hyDCQ): kinds, names and URIs, versions,
executions, compute, operators, access control, settings and quotas, credentials and models,
the codegen pipeline, the service map with adapters, the roadmap and the open decisions. Where
the two docs differ, the second wins. This file is the newer word on sequencing only, and
`PROGRESS.md` beside it records what is done and verified.

The text below is the plan of milestone M1 as it was written. Decisions of Nov 5 replaced
parts of it: one agent (the Texera Agent) instead of the Data Analyst and the Bio Researcher,
one MCP server at `/mcp/catalog` instead of a catalog and a dataflow server, built-ins defined
by the platform's project instead of a label, and chats that store choices and are bound to no
computing unit. `GUIDE.md` describes the system as it is; the Nov 5 entries of `PROGRESS.md`
say what changed and why.

Settled after the doc, in the same conversation: executions are resources nested under
workflows; versions, files, operators and ports, computing nodes and messages are subresources
with their parent's permissions; one `edge` table holds references and lineage as a rebuildable
index; the catalog is a client of every peer's API and never of its storage; Keycloak's Admin
API is not used (principal search runs on the catalog's own `principal` table). An agent is a
template version running one turn of a conversation on the person's behalf: the template is
the definition, the conversation is the state, the turn is the stateless loop. There are no
agent principals in M1; agents act as the person, and the template version is recorded on
each message and in the origin of each resource a turn creates.

## Milestone M1: the catalog contract, minimal and complete

Planned 2026-11-03. M1 replaces the ordering of phases 1 to 5 of the doc's roadmap with one
milestone: every kind of the settled model exists behind the generated contract, versioned
where the model says so, with subresources, grants, lineage and credentials working, and every
peer behind a port with one adapter and a contract test. Minimal means one adapter per port and
no feature beyond what the acceptance list exercises. Extensible means the ports, the content
kinds, the kind registry and the generic UI page exist, so the next adapter or kind is an
addition and not a change.

### Decisions taken to unblock M1 (override any of them before S4 starts)

1. Blob store: content-addressed S3 under `blobs/sha256/{aa}/{digest}`; lakeFS is an adapter slot.
2. Names are unique per parent and kind; the rid is the identity and URIs carry rids.
3. The plan JSON keeps `operatorID`, `operatorType`, `operatorProperties`, `inputPorts[].portID`,
   `outputPorts[].portID` and `links`.
4. Quotas and model usage metering are out of M1; no `quota`, `quota_usage` or `model_usage`
   tables yet.
5. One seeded model endpoint, `anthropic-platform`, in the system project, referencing the
   credential `anthropic-platform`. `up.sh` loads the key from the repo-root `.env` into OpenBao
   and never prints it. The agent runtime leases the key per turn and loses `TEXERA_LLM_API_KEY`.
6. Grants inherit down the parent chain, project to workflow to execution, as in the model today.
7. Pre-release: the schema is squashed into a new `0001_init.sql` and the dev stack is reset.
   No data migration.
8. The engine is untouched in M1. The catalog compiles custom operators into Python UDF
   operators before sending the plan, builds the environment before start (execution phase
   `provisioning`), and refuses a second concurrent run of a workflow on a unit with 409 itself.
9. Credentials are consumed in M1 by the agent runtime only: the model endpoint's key and MCP
   server headers. `format: credential` on operator properties is reserved; substitution at run
   time is the first extension.
10. The ToolLoopAgent refactor of the runtime loop is not in M1, so the current demo stays the
    regression signal for the contract reset.
11. The chat is the host, not an agent. Mode selection, native commands (`/mode`, `/new`),
    resource cards, history and permissions belong to the runtime and the app as code with
    tests; prompts, skills, tools and the model belong to templates. There is no platform
    agent and no router. A conversation names its current template in `spec.template`: chosen
    when the chat starts (a picker; the default is `settings.defaults.agentTemplate`), changed
    by the person with the switcher or `/mode`, or by a handoff. The generated catalog MCP
    server is seeded as `mcp-servers/catalog` and mounted on every template unless the
    template opts out, so the active agent can list, create and share resources with the
    person's permissions. Two seeded templates: Data Analyst (the default) and Bio Researcher.
12. An agent is a template version running one turn of a conversation on the person's behalf
    (see above). The runtime is a stateless turn runner behind one endpoint,
    `POST /agents/conversations/{rid}/ag-ui`: load the conversation and its template at head,
    pin that version on the turn's messages, run the loop with the person's token, stream,
    append, stop. No agent principals, no spawner, no lifetimes; scaling is more replicas. A
    template may list `handoffs`; the `handoff` tool is injected when the list is non-empty,
    its candidates described by the targets' cards. A handoff sets `spec.template`, emits the
    AG-UI event `texera.handoff`, and the target template finishes the same turn on the same
    stream; at most two per turn. A2A exposes each template as an agent, with the
    conversation as the A2A context. Delegation that returns a result (agents as tools) and
    agent identities of their own are extensions.
    The shape is Claude Code's. The harness always receives the message and does the
    deterministic work: native commands, context assembly (template prompt, history, skills,
    MCP servers, the catalog server, the handoff tool), tool execution behind the PDP,
    streaming, persistence. The judgment calls are the model's inside the loop: what to do,
    which tools, whether to load a skill, whether to hand off among the template's listed
    candidates. A template sees only the handoffs its author listed, never every template. A
    harness step that reads the first message and picks a template is the router extension.
13. The Bio Researcher's MCP server is built into the agent runtime at `/agents/mcp/scholar`
    and seeded as `mcp-servers/scholar` in the system project: literature search over Europe
    PMC (PubMed content) and OpenAlex, both keyless, plus fetching an abstract by id. Tests run
    it in a fixture mode with canned results.

### Steps

Each step is a series of small commits pushed as they land; the gate closes the step. Unit
tests stay green at every commit. End to end is red between S5 and S8 and green again at S10.

**S1 Contract.** `api/catalog/` replaces `api/catalog.tsp`: `envelope.tsp` (apiVersion, kind,
metadata with uri, spec, status, versions, grants, search, errors), one file per kind under
`kinds/` (spec, status, custom methods), `subresources.tsp`, `access.tsp` (the AuthZEN
evaluation endpoint) and `lineage.tsp` (OpenLineage inbound; upstream and downstream walks).
Extensions on every kind and operation: `x-texera-kind` {plural, versioned, parent, references,
index}, `x-texera-permission`, `x-mcp` {server: catalog | dataflow}. `api/openfga/model.fga`
v2: relations owner, editor, viewer, user; parent; `user:*`; computed can_read, can_write,
can_share, can_delete, can_execute, can_use, can_run_on, can_rotate. The agent template spec
references its model endpoint, skills and MCP servers by URI and gains `handoffs`; the
conversation status gains `activeAgent` and `participants`. `engine.tsp` is unchanged.
Gate: `tsp compile` clean; the OpenAPI diff reviewed against the doc's kind table.

**S2 Codegen.** `catalog/cmd/catalogen` (it absorbs `mcpgen`) reads the OpenAPI and emits
`catalog/internal/kinds/kinds.gen.go` (the registry, embedded JSON Schemas, reference
extractors as JSON pointers), `catalog/internal/uri/uri.gen.go` and
`packages/kinds/src/uri.gen.ts` (one grammar, parser and printer), `packages/kinds/src/kinds.gen.ts`,
the per-server MCP tables `catalog/internal/mcp/{catalog,dataflow}_tools.gen.go`,
`catalog/internal/authz/permissions_test.gen.go`, `gen/schemas/*.schema.json`, and
`catalog/internal/store/migrations/0002_indexes.gen.sql` from the declared index fields.
`make generate` runs tsp, oapi-codegen, catalogen and hey-api; `check-drift` covers every
output. Gate: `make generate && make check-drift` clean; URI round-trip property tests; the
permission table test compiles against the model.

**S3 Infrastructure.** Compose gains `openbao` (dev mode, KV v2 mount `texera`, an AppRole for
the catalog) and an init job; the OpenFGA init loads model v2; the Keycloak realm export gains
the `admins` group and a `groups` claim. Gate: `up.sh` from clean; every container healthy;
`smoke-env.py`.

**S4 Store and ports.** A new `0001_init.sql` with eleven tables: principal, resource,
resource_version, access_index, access_outbox, blob, dataset_staging, edge, lineage_event,
message, credential_lease. A message is (conversation_rid, seq, turn, role, author_pid,
template_rid, template_vno, parts, created_at): the author is the person whose turn it was,
the template version names the agent that wrote an assistant message, and the turn id groups
the messages of one loop. There is no agent or turn table: concurrency is
`status.activeTurn` on the conversation, and the AG-UI thread and run ids and the A2A context
and task ids map to the conversation rid and the turn id. The stream never touches the
database: the runtime inserts the person's message, upserts the one in-progress assistant
message after every step, and clears `activeTurn` at the end, about ten writes a turn. `seq`
is assigned under the conversation row's lock; reads are keyset-paged by `seq`. Resumable
streams, blob-backed large tool results and OpenTelemetry step traces are extensions keyed by
the turn id. `catalog/internal/store` becomes generic: one resource store
for every kind (create, get, list with filters and the readable index, update with etag, delete,
versions with digest and expectedHead), plus edges, blobs, staging, messages, agents and leases.
`catalog/internal/ports` defines Identity, Authorizer, SecretStore, BlobStore, TableCatalog,
UnitProvider, EnvironmentBuilder, ModelGateway, LineageSink and SearchIndex.
`catalog/internal/adapters` holds one adapter each (keycloak, openfga, openbao, s3cas,
lakekeeper, staticunit, unitenv, anthropic, noop, pgsearch) and memory adapters for tests.
`catalog/internal/ports/contracttest` has one suite per port, run against the memory adapters in
unit tests and against the stack under `-tags integration`. The access relay writes tuples from
the outbox and maintains the index, with a rebuild command. Gate: `go test ./...`;
`go test -tags integration ./...` against the stack.

**S5 Services.** `catalog/internal/services/{resources,files,executions,compute,operators,agents,credentials,models,iam,lineage}`
over the ports; `catalog/internal/server` becomes the thin generated strict server that calls
them. Resources: generic CRUD, versions, subresources, grants, search, lineage walks, `:edit`
for workflows. Files: upload to blobs, staging, `:commit` to a manifest version, ranged reads,
presigned URLs. Executions: `:run` with the resolution order request, then workflow defaults,
then project defaults, then 409; used edges at start; environment build then start; status
written at transitions; produced edges from the OpenLineage completion report; `:cancel`;
`:save` with derivedFrom (a CSV export to blobs in M1; the `table` content kind is declared and
not produced). Compute: the static unit provider, the nodes facet, the operator list per engine
image digest, built-in operator seeding. Operators: custom Python operators compiled into
Python UDF operators in the plan. Agents: templates, skills (markdown content kind), MCP
servers, conversations and messages, agent principals. Credentials: `:secret`, `:lease` with
the lease log. Models: model-endpoint CRUD with `can_use`; the model kind on the dataset
machinery with `producedBy`. IAM: me, principal search, the settings singleton with
`settings/public`. Lineage: OpenLineage inbound mapped to edges. Two MCP servers from the
generated tables. Gate: `go test ./...`; `smoke-catalog.sh` and `smoke-run.sh` rewritten for
the new API.

**S6 Engine.** No contract change. Verify the start request, the build endpoints and the
OpenLineage events against the new catalog and fix only what the smoke run finds. Gate:
`smoke-run.sh` through Lakekeeper and RustFS.

**S7 Agent runtime.** The catalog client follows the new paths and envelopes; templates
reference skills, MCP servers and a model endpoint by URI; the model key and `secret:` headers
come from `:lease`. The runtime becomes the stateless turn runner of decision 12: the
conversation endpoint replaces the per-agent one, the agent host, spawner, agent principals
and lifetimes go, the sandbox interface stays as the seam for code-execution tools. New: the
`scholar` MCP server at `/agents/mcp/scholar` with its fixture mode; the native commands; the
`handoff` tool and the `texera.handoff` event; messages of another template rendered with its
name in the history; A2A keyed by template. Gate: `bun test`, typecheck, `smoke-chat.py` with
Claude Haiku 5.5.

**S8 Frontend.** The regenerated client and kinds; the generic kind page renders any kind from
its JSON Schema (metadata, spec editor, versions, grants with principal search, dependents and
lineage from edges); executions under workflows with the port view; dataset files; the
credential page's write-only secret form. The agent templates page: list, view a template's
card, prompt, model endpoint, skills, MCP servers, handoffs and loop; create and edit with a
form over those fields; versions and grants. A new chat starts with a template picker; the
chat shows the current template, labels each assistant message with the template that wrote
it, and switches through the switcher or `/mode`. Gate: vitest; Playwright on Chrome.

**S9 Agents demo.** Seed `mcp-servers/catalog`, `mcp-servers/scholar` and the two templates
(Data Analyst as today; Bio Researcher with the scholar server, a literature-review skill and
a handoff to the Data Analyst); set `settings.defaults.agentTemplate` to the Data Analyst. The
scenario as a Playwright test on the scholar fixture and as a Haiku smoke run: Alice starts a
chat and picks the Bio Researcher; "research ideas on CRISPR off-target effects" is answered
with cited ideas; "now analyze iris.csv" is handed off to the Data Analyst, which runs a
workflow and shows results; "share this dataset with Bob" is done by the active template
through the catalog server; the templates page lists both and a third created from the page
is usable in a new chat. Gate: the Playwright scenario; `smoke-chat.py` extended with the
handed-off turn.

**S10 Close.** Seeding of the rest (the system project, built-in operators, skills, the model
endpoint and its credential, the admins group), README and PROGRESS, the doc's "What changes
from the current code" and roadmap sections, memory notes. Gate: `test.sh` all green from a
clean `up.sh`.

### Acceptance (the M1 demo)

1. Alice logs in through Keycloak and has a personal project. The system project holds the
   built-in operators, the Data Analyst template, its skills, the dataflow MCP server and the
   platform model endpoint, all public.
2. She uploads iris.csv: `datasets/{rid}@1` with a manifest over one blob. Uploading the same
   bytes again creates no second blob.
3. In a chat the Data Analyst builds `workflows/{rid}@1` to `@3` through the dataflow MCP
   server and runs it. The run is `workflows/{rid}/executions/{eid}` with ports under it. The
   runtime leased the platform key from OpenBao and holds no key of its own.
4. She saves a port: `datasets/{rid2}@1` with `producedBy`. The lineage panel walks upstream to
   iris.csv and downstream from iris.csv to the new dataset.
5. She creates a custom Python operator `operators/{rid}@1`, uses it in a workflow version, and
   the run executes it in the pinned environment. Deleting the operator is refused with the
   workflow listed as a dependent.
6. She shares the project with Bob as viewer. Bob finds the workflow, the run and the datasets
   in search, reads them and runs the workflow. Editing is 403 and leasing the credential is 403.
7. She creates a credential and an MCP server whose header references it. The runtime mounts
   the server through a lease and the lease is logged.
8. `make generate && make check-drift` is clean. The permission table test, the URI round-trip
   tests and every port's contract suite pass. `test.sh` is green.
9. The agent templates page lists the Data Analyst and the Bio Researcher with their cards,
   prompts, model endpoint, skills, MCP servers and handoffs. Alice creates a third template
   from the page with her own prompt and the scholar server; it is versioned, shareable and
   available in the picker of a new chat.
10. Alice starts a chat with the Bio Researcher and asks for research ideas on a biology
    topic; it answers with ideas grounded in cited literature from the scholar server. She
    then asks for an analysis of iris.csv; the Bio Researcher hands off to the Data Analyst,
    which builds and runs a workflow and shows the result. The chat labels each assistant
    message with the template that wrote it, and she can switch the template herself.
11. Alice asks the active template to share the chat's dataset with Bob and to list her
    templates; both happen through the catalog MCP server mounted on every template, with her
    permissions, and show as resource cards.

### Out of M1, with the interface that stays

| Later | What M1 leaves in place |
| --- | --- |
| Kubernetes units, the CRD, Helm | the UnitProvider port and the static adapter |
| lakeFS, LiteLLM, OpenSearch | the BlobStore, ModelGateway and SearchIndex ports with contract suites |
| `:save` as an Iceberg table version | the `table` content kind in the contract |
| quotas and model usage metering | the resolution points at `:run`, upload and lease |
| credentials in operator properties | `format: credential` reserved in the property schemas |
| reused and column lineage, external lineage sinks | the edge relations and the LineageSink port |
| environment images, an image registry, multi-node units | `engine.image`, `status.builds[]`, the nodes facet |
| groups beyond admins, SCIM | the group principal and the `groups` claim mapping |
| the ToolLoopAgent loop, tool approval, A2A tasks | the runtime's loop module boundary |
| delegation that returns a result (agents as tools), sub-agent policies | A2A `SendMessage` in the runtime and `subagents` in the template spec |
| a router that picks the template from the first message | the template cards and `settings.defaults.agentTemplate` |
| agent identities of their own (least privilege, own credentials), background agents with nobody present | `type agent` in the OpenFGA model and the template version on every message |
| durable execution of long turns (checkpoint per step, survive a restart) | the turn runner as the one place a step is recorded |
| BioMCP or other third-party scholarly servers, ClinicalTrials.gov | the `mcp-server` kind; any HTTP server is one row away |
| Java and Python generated clients | the OpenAPI the generators read |

## Repository layout (target, this worktree)

```
api/                 TypeSpec contract: catalog/ (envelope, kinds/, subresources, access,
                     lineage), engine.tsp, openfga/model.fga
gen/                 generated OpenAPI and JSON Schemas
catalog/             Go control plane: cmd/catalog, cmd/catalogen; internal/{kinds,uri,ports,
                     adapters,services,server,store,authn,authz,mcp,config}
agent-runtime/       TypeScript (Bun, Hono, AI SDK 7): AG-UI stream, A2A server, MCP client,
                     skills, agent host, sandbox interface
frontend-next/       the React app (routes, shell); becomes frontend/ at the cutover
packages/            catalog-client (generated), kinds (generated registry and URI grammar),
                     workflow-model, ui, chat
amber/               the Amber engine as a pure engine (see "Engine boundary")
common/              workflow-core, workflow-operator, workflow-compiler, config, auth, pybuilder
bin/texera-2-0/      the dev stack (docker compose) and scripts
docs/texera-2-0/     this plan, progress, decisions
```

The 1.x services, the Angular frontend, jOOQ and the old deployment tooling were deleted in
this worktree; the 1.x build workflow is replaced by the 2.0 one (`.github/workflows/build.yml`).

## Service topology of the dev stack

Everything that is Texera runs as a plain process on the host; only the standard components run
in containers (compose project `texera2`); no Kubernetes is involved in development. Envoy
(container, host port 8088; jwt_authn on Keycloak JWKS, ext_authz to the catalog) routes:
`/` → frontend (vite :5174 on the host), `/catalog/v1`, `/access/v1`, `/mcp`, `/lineage/v1`
→ catalog (:8090 host), `/agents` → agent-runtime (:23002 host), `/units/{rid}/wsapi` and
`/units/{rid}/api` → the unit (ComputingUnitMaster under sbt, :28085 host), `/auth` → Keycloak.
Infrastructure containers: postgres, keycloak, openfga, openbao (from S3), rustfs (S3),
lakekeeper (Iceberg REST) with a socat sidecar that makes 127.0.0.1:19001 reach RustFS inside
Lakekeeper's network namespace as it does on the host. The unit's Python workers run from the
uv-managed `.venv`. Details and ports: `bin/texera-2-0/README.md`.

## Engine boundary (Amber as a pure engine)

The unit (ComputingUnitMaster) keeps: the actor system, scheduling, workers, the Python/R
runtimes, the WebSocket protocol for live events, pause/resume/kill and result pagination,
the compiler, operator metadata, Iceberg result storage through Lakekeeper. It has no Postgres
dependency, no dashboard resources, no HS256 JWT, no lakeFS.

Its API to the catalog: `POST /api/executions` with a self-contained `ExecutionStartRequest`
(eid, workflow content, resolved dataset inputs as presigned URLs, environment, result store
config, the catalog callback URL plus a token), `GET /api/executions/{eid}`, cancel and
result pages; `POST /api/compile` and `GET /api/operators`; `POST /api/environments` and the
build status. It reports execution status and port results as OpenLineage run events to the
catalog. RS256 token verification through JWKS on the WebSocket and HTTP endpoints. Live
per-operator progress goes to the app over the unit's WebSocket, not through the catalog.

## Conventions

- Every new dependency is Apache-2.0, MIT or BSD. No secrets in the repo; the stack reads
  `ANTHROPIC_API_KEY` from the environment or the gitignored repo-root `.env`.
- Tests beside the code: `_test.go`, `*.test.ts`, `*.spec.ts`; integration tests need the
  stack and are tagged `integration`.
- Generated code is committed under `gen/` and the `*.gen.*` files, and checked for drift in CI.
- Observability: OpenTelemetry API only; exporters off by default.
