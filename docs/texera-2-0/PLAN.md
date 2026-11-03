# Texera 2.0 implementation plan

Branch `texera-2-0`, worktree `texera-worktrees/texera-2-0`. The design is the Claude Doc
"Texera as the Workspace for Agentic Collaborative Research" (rev 67). This file is the
engineering blueprint for the first end-to-end slice and the running notes that survive
context resets. Keep it current: `PROGRESS.md` beside it records what is done and verified.

## What the slice must do (acceptance)

1. A person logs in through Keycloak (OIDC, PKCE). Every service verifies RS256 tokens
   through JWKS; no shared secret anywhere.
2. The person starts a chat in a mode (an agent template), uploads a CSV (dataset v1), and
   asks for an analysis. The agent, running on AI SDK 7, uses only the Texera MCP server
   ("dataflow MCP": operators, edit, compile, run, results) to build a workflow, run it on a
   computing unit, and answer with results. Every workflow edit by the agent or a person is
   a new workflow version. Every run is an execution with lineage: which workflow version,
   which dataset versions, which environment, which port results.
3. The chat lists the resources it produced; each opens as a card, a side panel or a page.
4. Agent templates are catalog resources: list, view, create, edit (versioned). A template
   names MCP servers (catalog resources) it may use; the agent runtime mounts them.
5. Computing units and environments are catalog resources; an execution runs on a unit in
   an environment (Python packages) and the engine honors it.
6. All of it is tested: Go unit and integration tests, Vitest, Playwright, and one real-model
   end-to-end run with Claude Haiku 5.5 (`ANTHROPIC_API_KEY` from the main repo's `.env`).

## Repository layout (target, this worktree)

```
api/                 TypeSpec contract (catalog.tsp, engine.tsp), JSON Schemas, OpenFGA model
gen/                 generated OpenAPI, Go server, TS client, Java client, MCP tool table
catalog/             Go control plane: resources, versions, grants, PDP, executions, lineage,
                     datasets on S3, units, environments, the MCP server, the outbox
agent-runtime/       TypeScript (Bun/Node, Hono, AI SDK 7): AG-UI stream, A2A server, MCP
                     client, skills, agent host, sandbox interface
frontend-next/       the React app (routes, shell); becomes frontend/ at the cutover
packages/            catalog-client (generated), engine-protocol, workflow-model, ui, kinds, chat
amber/               the Amber engine as a pure engine (see "Engine boundary")
common/              workflow-core, workflow-operator, workflow-compiler, config, auth, pybuilder
bin/texera-2-0/      the dev stack (docker compose) and scripts
docs/texera-2-0/     this plan, progress, decisions
```

Retired in this worktree. Deleted: the Dashboard Service (TexeraWebApplication and
`amber/.../web/resource/dashboard|auth|hub|...`), access-control-service,
computing-unit-managing-service, config-service, file-service, workflow-compiling-service
(folded into the unit), notebook-migration-service, `common/resource`, `common/auth`,
`common/dao` with jOOQ, the old `sql/`, the Angular `frontend/` (operator icons moved to
`frontend-next/public/operator-images`), the old `agent-service/`, `pyright-language-service/`,
the 1.x deployment and tooling under `bin/` (local-dev, single-node, k8s, forum,
y-websocket-server, pylsp, mounter), and from the engine the LakeFS documents, the dataset-mount
manager and its execution-time binding, the file-lister operator and every database read. The
1.x build workflow is replaced by the 2.0 one (`.github/workflows/build.yml`).

## Service topology of the dev stack

Envoy :8080 (jwt_authn on Keycloak JWKS, ext_authz to the catalog) routes:
`/` → frontend (vite :5173 on the host), `/catalog/v1`, `/access/v1`, `/mcp`, `/lineage/v1`
→ catalog (:8090 host), `/agents` → agent-runtime (:3001 host), `/units/{rid}/wsapi` and
`/units/{rid}/api` → the unit (cu-master container :8085), `/auth` → Keycloak.
Infrastructure containers: postgres, keycloak, openfga, rustfs (S3), lakekeeper (Iceberg REST),
cu-master (the Amber unit image built from this worktree, with the Python runtime).

## Engine boundary (Amber as a pure engine)

The unit (ComputingUnitMaster) keeps: the actor system, scheduling, workers, the Python/R
runtimes, the WebSocket protocol for live events, pause/resume/kill and result pagination,
the compiler, operator metadata, Iceberg result storage through Lakekeeper.

The unit loses: every Postgres/jOOQ dependency, the dashboard resources, HS256 JWT, lakeFS,
the warehouse table lookup, the per-user venv table.

The unit gains:
- `POST /api/execution/start` with a self-contained `ExecutionStartRequest`: eid, workflow
  content, resolved dataset inputs (presigned URLs), environment (Python packages), result
  store config, and the catalog callback URL plus a token.
- `ExecutionReporter`: execution status, operator states, port results (table, snapshot,
  count, hash) and OpenLineage run events posted to the catalog.
- `POST /api/compile` and `GET /api/operators` (metadata) served by the same process.
- RS256 token verification through JWKS for the WebSocket and HTTP endpoints.
- `https://` readonly file documents so scans read presigned dataset files.
- Environment handling keyed by (environment rid, vno) with a venv per environment version.

## Order of work

1. Contract and generators: `api/catalog.tsp`, OpenAPI, Go strict server, TS client, MCP
   tool table, `make generate`, drift check.
2. Dev stack: compose file, Keycloak realm, OpenFGA model, Envoy config, Lakekeeper init.
3. Catalog core: principals, resources, versions, grants, PDP, OIDC; integration tests.
4. Engine: the boundary above; unit image; run in the stack.
5. Catalog: executions, lineage, datasets, units, environments, operators, MCP server.
6. Agent runtime: AG-UI, ToolLoopAgent, MCP client, templates, conversations, A2A.
7. Frontend: OIDC, generated client, chat with modes, kinds (workflow, dataset, execution,
   template, MCP server, unit, environment), versions, lineage.
8. End-to-end with Haiku 5.5; then delete the retired code; update docs.

## Conventions

- Every new dependency is Apache-2.0, MIT or BSD. No secrets in the repo; the stack reads
  `ANTHROPIC_API_KEY` from the environment.
- Tests beside the code: `_test.go`, `*.test.ts`, `*.spec.ts`; integration tests need the
  stack and are tagged `integration`.
- Generated code is committed under `gen/` and checked for drift in CI.
- Observability: OpenTelemetry API only; exporters off by default.
