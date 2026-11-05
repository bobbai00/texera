# Using Texera 2.0

Texera 2.0 is a chat-first data analysis platform. A person asks an agent; the agent builds and
runs workflows through the Texera MCP server; every dataset, workflow, run, operator and
template is a resource of one catalog, versioned, shareable, and linked by lineage. Everything
below runs on one machine with the dev stack, or on a local Kubernetes cluster with one
command. This guide goes from the first sign-in to runs, agents, the API by hand and your own
agents; the deeper documents are listed at the end.

## 1. Bring it up

Prerequisites: Docker with Compose v2, Go, JDK 17 with sbt, Bun 1.3, uv 0.9 (the table with
versions and why: `bin/texera-2-0/README.md`). Then, from the repository root:

```
cp .env.example .env            # ANTHROPIC_API_KEY=... (the agents need a model; everything else works without)
bin/texera-2-0/up.sh            # the containers, then the catalog, the computing unit, the agent runtime, the frontend
```

`up.sh` takes a few minutes the first time (the Python environment, the engine's compilation)
and is idempotent: run it again after a change to restart what changed. Open
**http://localhost:8088** and sign in as `alice` / `alice` or `bob` / `bob` (`texera-admin` /
`admin` is an administrator). Logs are in `logs/texera-2-0/<service>.log`.

```
bin/texera-2-0/down.sh          # stop everything, keep the data
bin/texera-2-0/down.sh --wipe   # stop everything and delete the volumes (a fresh realm, store and lake)
```

The same stack on Kubernetes: `bin/texera-2-0/k8s.sh up`, then http://localhost:28088 (section 8).

| Piece | Where | Role |
| --- | --- | --- |
| Gateway (Envoy) | :8088 | the only entry point: the app, `/catalog/v1`, `/mcp/*`, `/agents/*`, `/auth` |
| Catalog (Go) | :8090 | the control plane: resources, versions, grants, runs, lineage, the MCP servers |
| Computing unit (Amber) | :28085 | runs workflows; reached by the catalog only |
| Agent runtime (Bun) | :23002 | runs one chat turn at a time |
| Frontend (vite) | :5174 | the workspace, served through the gateway |
| Keycloak, OpenFGA, OpenBao, Postgres, RustFS, Lakekeeper | containers | identity, authorization, secrets, the store, blobs, the lake |

## 2. The workspace

**A chat.** The home page starts a conversation: pick an agent template (the Data Analyst
answers data questions by building and running workflows; the Bio Researcher grounds
biomedical ideas in PubMed and hands analyses to the Data Analyst) and a computing unit, then
ask. Attach a CSV from the composer and it becomes a dataset of yours. Every resource the
agent makes or touches shows as a card in the message and in the rail beside the chat. Each
assistant message is labelled with the template version that wrote it; switch agents with the
switcher or by typing `/mode <template>`, and a handoff by an agent shows as a divider.

**A chat with others.** Share a conversation like any resource and it is a group chat: an
editor posts and takes turns, a viewer reads along. Their messages arrive as they are sent,
under their names; one person talks to the agent at a time, and while Bob's turn runs Alice
sees "Bob is talking to the Data Analyst" and waits. The agent's answer to Bob's question is
Bob's turn, so the history says who asked what. The same works from the API: a grant on the
conversation is the membership, every message carries its author, and the turn lock names
its holder.

**The library.** Every kind has a page under its plural: `/workflows`, `/datasets`,
`/agent-templates`, `/operators`, `/environments`, `/computing-units`, `/credentials`,
`/mcp-servers`, `/model-endpoints`, `/skills`, `/projects`, and `/settings` for
administrators. "New …" opens a form generated from the kind's schema. A resource's page has
its spec (a form, the JSON a click away), its versions, who can access it, its lineage and the
raw envelope; `?panel=` opens a second resource beside the first.

**Projects.** Everything lives in a project; you start with a home project. Names are unique
per project and kind (a duplicate is refused with 409). Share a project and everything in it
is shared the same way.

**Workflows.** The editor is a canvas over the spec: operators (the engine's built-ins and your
custom operators, by URI), links, properties from each operator's JSON Schema. A file property
takes a dataset file URI, `texera://datasets/{rid}@{vno}/files/{path}`. "Validate" compiles
the version on a unit and shows the output columns per port and any errors; "Run" starts an
execution and opens its page. Every save is a version; a run pins the version it used.

**Runs.** A run's page shows its phase, the operators with their states and counts as the unit
reports them (about once a second while it runs), the results of each output port (paged
rows), its inputs and its lineage. "Pause" holds a running run where it is and "Resume"
continues it; "Stop" cancels a live one; "Keep" marks a finished run so the retention policy
leaves its results alone; "Delete" removes it with its tables. The page follows the run
without reloading. Results live with the run: to use them again, rerun or read the rows.

**Datasets.** Upload files (they stay staged), then commit a version; download or presign any
file of any version. Uploading the same bytes twice stores them once.

**Sharing.** A resource is private or public. Grants give a person or group a relation:
`viewer` reads and runs, `editor` writes too, `owner` everything; `user` is "may use" for a
computing unit, a credential or a model endpoint, and viewing never implies using. The access
tab finds people by name or email, logged in or not.

**Settings** (administrators): branding, the defaults a run or a chat falls back to (template,
environment, unit, model endpoint) and retention (section 5).

## 3. Agents

An agent is an **agent template** running one turn of a conversation on the person's behalf,
with the person's own permissions. A template is a resource like any other: a card, a model
endpoint, a system prompt, skills loaded on demand, the MCP servers it mounts (the catalog
server with every operation as a tool is mounted unless `catalogTools` is false), the
templates it may hand off to, and the loop settings (`answer: free | after_result`,
`maxSteps`). Create your own from `/agent-templates`; it is versioned, shareable and appears
in the picker of a new chat.

- **Model endpoints** name a provider and a model (`anthropic`, or `openai_compatible` with a
  base URL) and the **credential** whose secret is the key. The runtime holds no key: it
  leases the credential for the turn. The platform's endpoint uses the key from `.env`.
- **Skills** are Markdown the agent loads by name when its index says they apply (the seeded
  ones: building workflows, Python operators, reading results, the literature review).
- **MCP servers** are any streamable-HTTP server; a header value `credential:<uri>` or
  `credential:<uri>#<field>` is replaced by the leased secret. The platform provides
  `catalog`, `dataflow` and the bio server (PubMed, genes, variants, proteins).
- The conversation keeps the history; the runtime is stateless, so one turn runs at a time
  (`409 turn_active` otherwise) and a crash loses nothing.

## 4. Workflows and runs, by the API

`bin/texera-2-0/examples/walkthrough.py` is the tour, runnable as is, and prints every
request it makes: sign in, a project, a dataset with a committed file, a workflow, the plan a
run would use, the run, its rows and lineage, the keep mark, sharing with Bob, the MCP tools,
cleanup (`--chat` adds one turn with the Data Analyst; `--gw http://localhost:28088` runs it
against the cluster). The pieces, as curl:

```
GW=http://localhost:8088
TOKEN=$(curl -s -d grant_type=password -d client_id=texera-app -d username=alice -d password=alice \
  $GW/auth/realms/texera/protocol/openid-connect/token | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
api() { curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }

api $GW/catalog/v1/me                                                   # who I am, my home project
api -X POST $GW/catalog/v1/datasets -d '{"name":"iris","spec":{"format":"csv"}}'          # -> metadata.rid
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/csv" -X PUT \
  --data-binary @bin/texera-2-0/examples/iris.csv $GW/catalog/v1/datasets/$DS/files/iris.csv
api -X POST $GW/catalog/v1/datasets/$DS/commit -d '{"message":"first upload"}'            # -> version 1
api -X POST $GW/catalog/v1/workflows -d @workflow.json                                    # {"name":..., "spec":{"operators":[...],"links":[...]}}
api $GW/catalog/v1/computing-units/available                                              # a unit with status.phase ready
api -X POST $GW/catalog/v1/workflows/$WF/validate -d '{}'                                 # compile: schemas, errors, and the plan
api -X POST $GW/catalog/v1/workflows/$WF/run -d '{"name":"first run","waitSeconds":240}'  # -> the execution, completed
api "$GW/catalog/v1/workflows/$WF/executions/$EID/operators/avg/ports/output-0/rows?limit=10"
api "$GW/catalog/v1/resources/$EID/lineage?direction=upstream"                            # the run used the file
api -X PATCH $GW/catalog/v1/resources/$EID -d '{"labels":{"texera.keep":"true"}}'         # keep its results
api -X PUT $GW/catalog/v1/resources/$PROJECT/grants/$BOB -d '{"relation":"viewer"}'       # share
```

A workflow spec names operators by type (`CSVFileScan`, `Aggregate`, `PythonUDFV2`, … ;
`GET /operators?q=Aggregate` gives each type's properties schema) or by a custom operator's
URI, and links ports `output-0` to `input-0`. The spec in the walkthrough is a complete
example. `viewResult: true` on an operator stores its output so the rows can be read; an
operator nothing reads is stored anyway.

**How a run works.** `POST /workflows/{rid}/run` goes through three phases in the catalog.
It authorizes everything the compiled plan names before anything is written: execute on the
workflow, run on the unit, read on the environment, every dataset file and custom operator,
use on every credential; a refusal leaves nothing behind. It compiles the version into a plan
that is data: the engine's logical plan with files and credentials still named by URI, the
custom operators compiled in, and one table per output port the engine writes, named
`<operator>_<port>` inside the run's own namespace `e_<rid>` in the lake. `validate` returns
the same plan, so a dry run shows what a run would do. Then it materializes: the execution is
stored with its plan (`spec.plan`, no secret, no URL that expires), its namespace is opened
for the unit's identity, and the engine receives a bound copy with presigned inputs and
leased secrets. The unit reports back as itself through OpenLineage events, and only the unit
running an execution may report on it. `status.ports[]` lists the tables from the start and
fills in rows and snapshots as they are reported; the rows are read by namespace and table,
so a restarted unit, or another unit, serves them from the lake.

With `waitSeconds` the call returns the finished execution; without it, watch it. Every
resource has an event stream, `GET /resources/{rid}/events`, server-sent events for as long
as the connection stays open: `resource` with the envelope after each change (for a run:
`status.phase`, the operators' states and counts, the ports as they fill), `message` for a
conversation's messages, `deleted` when it goes.

```sh
curl -sN -H "Authorization: Bearer $TOKEN" $GW/catalog/v1/resources/$EID/events
# event: resource
# data: {"kind":"execution",...,"status":{"phase":"running","operators":{"scan":{"state":"Running","tuples":80}}}}
```

A run's phases are pending, provisioning, running, paused, completed, failed and cancelled.
`POST .../executions/{eid}/pause` holds a running run (the phase turns `paused` when the unit
confirms), `.../resume` continues it, `.../cancel` ends it; a verb that does not fit the phase
answers 409. A workflow with a run still going on the same unit answers 409 to another run.

**Environments, custom operators, credentials.**

- An **environment** is a Python package list (PEP 508 lines, an optional version range),
  versioned; a unit builds it on first use (`POST /environments/{rid}/build` builds ahead).
  A run takes the request's environment, else the one its custom operators pin, else the
  workflow's, the project's and the settings' defaults, in that order; a pin that disagrees
  with the request is refused with 409.
- A **custom operator** is a Python class with the engine's UDF interface, with its ports, its
  properties schema, the columns it adds (`outputColumns`, so the engine can type the output)
  and optionally the environment it pins. A workflow uses it by URI with `@vno` as the
  `operatorType`; its instance properties reach the code as the dict `PROPS`. Deleting an
  operator a workflow version uses is refused, the dependents listed.
- A **credential** holds a secret written once (`PUT /credentials/{rid}/secret`) and never
  read back. A property whose schema says `format: credential` takes a credential URI; the
  catalog leases the secret for the run and puts it in the plan the engine receives, never in
  a version or an execution. The caller must be allowed to use the credential.

## 5. Keeping and losing results

Results are Iceberg tables in the lake, in the run's namespace, written by the unit's own
identity and readable through the catalog alone. The settings' `retention.results` (an ISO
8601 duration, `P30D`) is how long a finished run keeps its tables; absent, forever. The
catalog sweeps hourly (`POST /settings/retention/sweep` runs one now, for administrators);
an expired run keeps its record and summaries and answers 410 to its rows. The label
`texera.keep` on an execution (the Keep button) exempts it. `DELETE /workflows/{rid}/
executions/{eid}` removes a finished run with its tables; `retention.blobs` (default a day)
removes uploaded files nobody committed.

## 6. Computing units

A computing unit is the engine deployment a run goes to, and a resource: `provider: static`
is a unit already running at an `endpoint` (the dev stack's "local unit", started by
`run-unit.sh`, which presents the realm's `texera-unit` client to the lake), `provider:
kubernetes` is one the catalog starts and reconciles on the cluster (section 8). A unit
answers the catalog's client alone: there is no route to it through the gateway and no
person's token opens it; people and agents run through the catalog, which authorizes and
compiles first. Toward the lake and the catalog a unit has an identity of its own, and
reaches only the namespaces of the runs it executed. Grant `user` on a unit to let someone
run on it; `GET /computing-units/available` lists the ones you may use.

## 7. Your own agents and tools

Anything that holds a person's token can do what the person can:

- **The MCP servers.** `POST {gw}/mcp/catalog` and `POST {gw}/mcp/dataflow` are streamable
  HTTP MCP servers (`Accept: application/json, text/event-stream`), one tool per operation of
  the contract: the dataflow server has the workflow tools (`create_workflow`,
  `edit_workflow`, `validate_workflow`, `run_workflow`, `get_port_result`, the dataset file
  tools); the catalog server the rest (`whoami`, `search_resources`, `resolve_uri`,
  `grant_access`, …). Point Claude Code, an SDK agent or any MCP client at them with a
  bearer token. The walkthrough shows one call.
- **The chat protocol.** `POST {gw}/agents/conversations/{rid}/ag-ui` runs one turn of the
  conversation's template with an AG-UI `RunAgentInput` (only the new user message; the
  history is the catalog's) and streams AG-UI events back: text, tool calls and results,
  `texera.resource` cards, `texera.handoff`. `GET {gw}/agents/templates/{rid}/.well-known/
  agent-card.json` and `POST .../a2a` expose a template to A2A clients.
- **The contract.** `api/catalog/` (TypeSpec) is the source; `gen/openapi/3.1.0/
  Texera.Catalog.openapi.yaml` the OpenAPI document; `packages/catalog-client` the generated
  TypeScript client; `tests/e2e/texera_e2e/` a small Python client the scenarios use.
- **Tokens.** People sign in through Keycloak (the public client `texera-app`; the password
  grant works for scripts, PKCE for the app). Services use client credentials
  (`texera-services` is the platform's own). A token must carry the audience `texera`.

## 8. Testing and deploying

```
bin/texera-2-0/test.sh unit        # no stack: the catalog, the engine, the runtime, the frontend
bin/texera-2-0/test.sh contract    # the adapters and the engine against the stack's peers
bin/texera-2-0/test.sh scenario    # the end-to-end scenarios (pytest, tests/e2e), one module per use case
bin/texera-2-0/test.sh ui          # Playwright against the stack, no model
bin/texera-2-0/test.sh evals       # the real agents through the real model
bin/texera-2-0/test.sh gate        # a wiped stack, then everything
bin/texera-2-0/k8s.sh up           # the stack on a local kind cluster at http://localhost:28088
bin/texera-2-0/k8s.sh check        # the scenarios and Playwright against the cluster, plus a unit made as a resource
```

`docs/texera-2-0/TESTING.md` explains the layers, what each scenario proves, the fixtures and
how to add one. On the cluster, units are resources: create one from `/computing-units` with
`provider: kubernetes` and it becomes a Deployment the catalog reconciles; a changed spec
rolls it; `terminate` removes it. Details, the images and the manifests:
`bin/texera-2-0/README.md`, `bin/dockerfiles/`, `deploy/kubernetes/`.

## 9. When something does not work

- **The agents do not answer.** No model key: put `ANTHROPIC_API_KEY` in `.env` and run
  `up.sh` again (the key is loaded into the secret store; the runtime leases it per turn).
- **A port is held.** `up.sh` refuses to start a service on a port another process holds and
  names it; another worktree of this repository must be stopped with its own `down.sh`.
- **401 from the gateway.** The token is missing, expired or for another issuer; a realm
  change (`bin/texera-2-0/keycloak/texera-realm.json`) needs `down.sh --wipe`, Keycloak
  imports a realm once.
- **409.** A duplicate name in the project; a delete of something still referenced or still
  holding children (the response lists them); a run on a unit that already runs one of this
  workflow; a unit with a run on it being changed.
- **410** on a run's rows: its results expired under the retention policy; keep runs you need.
- **403** where you expected to be allowed: viewing never implies using; ask for `user` on the
  unit, credential or model endpoint, or `editor` to write.
- **The unit is not ready.** `logs/texera-2-0/unit.log`; the engine compiles with sbt on the
  first start and the catalog shows the unit as pending until its health answers.
- **Playwright has no browser.** `cd frontend-next && bunx playwright install chromium`, or
  `TEXERA_E2E_BROWSER_CHANNEL=chrome` for an installed Chrome.

## 10. Where to read more

| Document | What it holds |
| --- | --- |
| `bin/texera-2-0/README.md` | the dev stack: prerequisites, ports, the lake, Kubernetes |
| `docs/texera-2-0/TESTING.md` | the test layers, the scenario catalog, the rules, adding a scenario |
| `docs/texera-2-0/API-REQUESTS.md` | the conventions between the parts beyond the contract, including how a run works |
| `docs/texera-2-0/PLAN.md`, `PROGRESS.md` | the milestone with its decisions and acceptance list; what was done, verified and comes next |
| `docs/texera-2-0/claude-docs/handoff.md` | where things stand, the gotchas, the next steps |
| `catalog/README.md`, `agent-runtime/README.md`, `frontend-next/README.md` | each part's run instructions, layout and rules |
| `api/catalog/*.tsp` | the contract: every kind, route, permission and MCP tool |
| `AGENTS.md` | the map of the repository and the rules for working in it |
