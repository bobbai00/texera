# Using Texera 2.0

Texera 2.0 is a chat-first data analysis platform. A person asks an agent; the agent builds and
runs workflows through the Texera MCP server; every dataset, workflow, execution, operator and
agent is a resource of one catalog, versioned, shareable, and linked by lineage. Everything
below runs on one machine with the dev stack, or on a local Kubernetes cluster with one
command. This guide goes from the first sign-in to executions, agents, the API by hand and your own
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
| Catalog (Go) | :8090 | the control plane: resources, versions, grants, executions, lineage, the MCP server |
| Computing unit (Amber) | :28085 | runs workflows; reached by the catalog only |
| Agent runtime (Bun) | :23002 | runs one chat turn at a time |
| Frontend (vite) | :5174 | the workspace, served through the gateway |
| Keycloak, OpenFGA, OpenBao, Postgres, RustFS, Lakekeeper | containers | identity, authorization, secrets, the store, blobs, the lake |

## 2. The workspace

**A chat.** The home page is where a chat starts: say what you want, and your first message
makes the chat, in the project you work in. Every chat runs the Texera Agent: it answers data
questions by building and running workflows, and grounds research questions in the biomedical
literature. The foot of the box shows what the chat runs with: the agent, its model, the
computing unit and the add-on tools. Change one and the chat stores your choice; a chat you
never touch stores nothing and follows its project's and the platform's defaults. The unit is a
preference, not a binding: "Automatic" lets each execution take the workflow's, the project's
or the platform's default, and a call can always name another unit. Attach a CSV from the box
and it becomes a dataset of the chat's project, shown as a card of your message. Every resource
the agent makes or touches shows as a card in the message and in the rail beside the chat.
Each answer is labelled with the version of the agent and the model that wrote it. A turn that
fails says why in the chat, and still does after a reload.

**A chat with others.** Share a conversation like any resource and it is a group chat: an
editor posts and takes turns, a viewer reads along. Their messages arrive as they are sent,
under their names; one person talks to the agent at a time, and while Bob's turn runs Alice
sees "Bob is talking to the Texera Agent" and waits. The agent's answer to Bob's question is
Bob's turn, so the history says who asked what. A choice of the chat that someone in it may
not use (the owner's own model or unit) is passed over for them: their turn runs with the next
default, and the chat says so. The same works from the API: a grant on the conversation is the
membership, every message carries its author, and the turn lock names its holder.

**Projects.** Everything lives in a project, and you work in one at a time, picked at the top
of the sidebar: "Personal", your home project, until you pick another, or "All projects". The
lists show the project you work in and what it inherits, the built-ins; what you make goes
into it, and so does what the agent makes in a chat of that project. Names are unique per
project and kind (a duplicate is refused with 409). Share a project and everything in it is
shared the same way; make it public and everyone can read what is in it. A project can name
its own defaults: the agent, the model, the computing unit, the environment, and add-on tools
for all its chats.

**Built-in.** What the platform ships (the agent, its skills and MCP servers, the model
endpoint, the default unit and environment, the engine's operators) lives in one project,
"Built-in", and that is all that makes a resource built in. Everyone can view and use what is
in it; nobody changes it through the app or the API, an administrator included (`409
builtin`): it changes with a release. An administrator changes which agent, unit, environment
or model is the default in the settings, and a project in its own.

**The library.** Every kind has a page under its plural, linked from the sidebar: what you
make and keep (`/workflows`, `/datasets`, `/models`, `/operators`, `/environments`,
`/computing-units`), what happened (`/executions`, across workflows), what the agent is made
of (`/agent-templates`, `/skills`, `/mcp-servers`, `/model-endpoints`, `/credentials`),
`/projects`, and `/settings` for administrators. "New …" opens a form generated from the
kind's schema; a new computing unit asks for its memory and CPU. A resource's page has its
spec (a form, the JSON a click away), its versions, who can access it, its lineage and the raw
envelope; `?panel=` opens a second resource beside the first.

**Workflows.** The editor is a canvas over the spec: operators (the engine's built-ins and the
custom operators of the workflow's project, by URI), links, properties from each operator's
JSON Schema. A file property takes a dataset file URI,
`texera://datasets/{rid}@{vno}/files/{path}`. The editor compiles as you edit, on a unit, and
shows the output columns per port and any errors; "Run" starts an execution and opens its
page. Every save is a version; an execution pins the version it ran.

**Executions.** An execution's page shows its phase, the operators with their states and
counts as the unit reports them (about once a second while it runs), the results of each
output port (paged rows), its inputs and its lineage. "Pause" holds a running one where it is
and "Resume" continues it; "Stop" cancels a live one; "Keep" marks a finished one so the
retention policy leaves its results alone; "Delete" removes it with its tables. The page
follows the execution without reloading. Results live with the execution: to use them again,
run again or read the rows. An execution lives under its workflow; the sidebar lists them
across workflows because that is how people look for one.

**Datasets.** Upload files (they stay staged), then commit a version; download or presign any
file of any version. Uploading the same bytes twice stores them once.

**Sharing.** A resource is private or public. Grants give a person or group a relation:
`viewer` reads and runs, `editor` writes too, `owner` everything; `user` is "may use" for a
computing unit, a credential or a model endpoint, and viewing never implies using. The access
tab finds people by name or email, logged in or not.

**Settings** (administrators): branding, the defaults an execution or a chat falls back to
(agent, environment, unit, model endpoint) and retention (section 5).

## 3. Agents

One agent is the entry to every chat: the **Texera Agent**. It runs one turn of a
conversation at a time, on the person's behalf and with the person's own permissions.

**What it is made of.** A system prompt, tools, and skills.

- **Basic tools**: the platform's own MCP server, the catalog, plus `load_skill`. The catalog
  server holds every tool of the platform, because a workflow is a resource and running it is
  one of its verbs: resources with their versions, lineage and sharing, dataset files,
  operators, computing units, and `create_workflow`, `edit_workflow`, `validate_workflow`,
  `run_workflow`, `get_execution`, `get_port_result`, pause and resume. The agent lists it like
  any other server; nothing is mounted behind its back.
- **Add-ons**: any other MCP server; the platform ships the bio server (PubMed, genes,
  variants, proteins). An add-on that cannot be reached is left out of the turn and the agent
  is told, so it says so instead of answering from memory; the turn goes on with the rest.
- **Skills** are Markdown the agent loads by name when it needs them (building workflows,
  Python operators, reading results, the literature review), so the prompt stays short.
- The agent is told, at every step, today's date, the project the chat is in and the computing
  unit an execution falls back to. It works where the chat is: its searches cover the chat's
  project and the built-ins unless it names another scope, and what it makes goes there.

**What a chat runs with.** A chat stores choices and nothing else: its agent, the model, the
computing unit its executions prefer, its add-on servers. A turn runs with the chat's choice,
else the project's, else the agent's own or the platform's default. The add-ons a chat lists
take the place of the agent's and the project's; the catalog server is not an add-on and
stays. The catalog decides, in one place: `GET /conversations/{rid}/settings` says what a turn
would run with and which level chose each, `GET /projects/{rid}/chat-settings` the same for a
chat not started yet. The runtime builds what it says, and each answer records the agent
version, the model and the servers that wrote it.

**Where it is defined.** The agent is a file in the repository,
`catalog/internal/catalog/agents/texera-agent.md` (its card and its system prompt), next to the
skills in `skills/*.md`; the model endpoint, the skills and the MCP servers it uses are a few
lines of `seed.go`. The catalog seeds it at start into the Built-in project, as the settings'
default. A changed file is a new version at the next start; a turn runs the newest version,
and every message records the version that wrote it, so a change is traceable and is undone by
reverting the file. The Built-in project holds what the release ships and nothing else: what
an older release shipped is removed at the next start, and a chat that named it falls back to
the platform's. The model, its key and the bio server's address come from the deployment
(`TEXERA_MODEL_NAME`, the key in `.env`, `TEXERA_BIOMCP_URL`).

- **Model endpoints** name a provider and a model (`anthropic`, or `openai_compatible` with a
  base URL) and the **credential** whose secret is the key. The runtime holds no key: it
  leases the credential for the turn, as the person. Register your own and pick it in a chat's
  box.
- **MCP servers** are any streamable-HTTP server; a header value `credential:<uri>` or
  `credential:<uri>#<field>` is replaced by the leased secret. Register your own and switch it
  on in a chat's add-ons, or list it in a project for all its chats.
- The conversation keeps the history; the runtime is stateless, so one turn runs at a time
  (`409 turn_active` otherwise) and a crash loses nothing.

Not offered for now: making agents of your own in the app (the API makes them, and a chat can
name one), switching agents in a chat, handing a chat from one agent to another, and asking
before the agent acts. The `/mode` command and the handoff tool remain in the code for when
they return.

## 4. Workflows and executions, by the API

`bin/texera-2-0/examples/walkthrough.py` is the tour, runnable as is, and prints every
request it makes: sign in, a project, a dataset with a committed file, a workflow, the plan
an execution would use, the execution, its rows and lineage, the keep mark, sharing with Bob,
the MCP tools, cleanup (`--chat` adds one turn with the Texera Agent; `--gw http://localhost:28088` runs it
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
api -X POST $GW/catalog/v1/workflows/$WF/run -d '{"name":"first execution","waitSeconds":240}'  # -> the execution, completed
api "$GW/catalog/v1/workflows/$WF/executions/$EID/operators/avg/ports/output-0/rows?limit=10"
api "$GW/catalog/v1/resources/$EID/lineage?direction=upstream"                            # the execution used the file
api -X PATCH $GW/catalog/v1/resources/$EID -d '{"labels":{"texera.keep":"true"}}'         # keep its results
api -X PUT $GW/catalog/v1/resources/$PROJECT/grants/$BOB -d '{"relation":"viewer"}'       # share
```

A workflow spec names operators by type (`CSVFileScan`, `Aggregate`, `PythonUDFV2`, … ;
`GET /operators?q=Aggregate` gives each type's properties schema) or by a custom operator's
URI, and links ports `output-0` to `input-0`. The spec in the walkthrough is a complete
example. `viewResult: true` on an operator stores its output so the rows can be read; an
operator nothing reads is stored anyway.

**How an execution starts.** `POST /workflows/{rid}/run` goes through three phases in the catalog.
It authorizes everything the compiled plan names before anything is written: execute on the
workflow, run on the unit, read on the environment, every dataset file and custom operator,
use on every credential; a refusal leaves nothing behind. It compiles the version into a plan
that is data: the engine's logical plan with files and credentials still named by URI, the
custom operators compiled in, and one table per output port the engine writes, named
`<operator>_<port>` inside the execution's own namespace `e_<rid>` in the lake. `validate`
returns the same plan, so a dry run shows what an execution would do. Then it materializes: the execution is
stored with its plan (`spec.plan`, no secret, no URL that expires), its namespace is opened
for the unit's identity, and the engine receives a bound copy with presigned inputs and
leased secrets. The unit reports back as itself through OpenLineage events, and only the unit
running an execution may report on it. `status.ports[]` lists the tables from the start and
fills in rows and snapshots as they are reported; the rows are read by namespace and table,
so a restarted unit, or another unit, serves them from the lake.

With `waitSeconds` the call returns the finished execution; without it, watch it. Every
resource has an event stream, `GET /resources/{rid}/events`, server-sent events for as long
as the connection stays open: `resource` with the envelope after each change (for an execution:
`status.phase`, the operators' states and counts, the ports as they fill), `message` for a
conversation's messages, `deleted` when it goes.

```sh
curl -sN -H "Authorization: Bearer $TOKEN" $GW/catalog/v1/resources/$EID/events
# event: resource
# data: {"kind":"execution",...,"status":{"phase":"running","operators":{"scan":{"state":"Running","tuples":80}}}}
```

An execution's phases are pending, provisioning, running, paused, completed, failed and
cancelled. `POST .../executions/{eid}/pause` holds a running one (the phase turns `paused`
when the unit confirms), `.../resume` continues it, `.../cancel` ends it; a verb that does not
fit the phase answers 409. A workflow with an execution still going on the same unit answers
409 to another.

**Environments, custom operators, credentials.**

- An **environment** is a Python package list (PEP 508 lines, an optional version range),
  versioned; a unit builds it on first use (`POST /environments/{rid}/build` builds ahead).
  An execution takes the request's environment, else the one its custom operators pin, else the
  workflow's, the project's and the settings' defaults, in that order; a pin that disagrees
  with the request is refused with 409.
- A **custom operator** is a Python class with the engine's UDF interface, with its ports, its
  properties schema, the columns it adds (`outputColumns`, so the engine can type the output)
  and optionally the environment it pins. A workflow uses it by URI with `@vno` as the
  `operatorType`; its instance properties reach the code as the dict `PROPS`. Deleting an
  operator a workflow version uses is refused, the dependents listed.
- A **credential** holds a secret written once (`PUT /credentials/{rid}/secret`) and never
  read back. A property whose schema says `format: credential` takes a credential URI; the
  catalog leases the secret for the execution and puts it in the plan the engine receives, never in
  a version or an execution. The caller must be allowed to use the credential.

## 5. Keeping and losing results

Results are Iceberg tables in the lake, in the execution's namespace, written by the unit's own
identity and readable through the catalog alone. The settings' `retention.results` (an ISO
8601 duration, `P30D`) is how long a finished execution keeps its tables; absent, forever. The
catalog sweeps hourly (`POST /settings/retention/sweep` runs one now, for administrators);
an expired execution keeps its record and summaries and answers 410 to its rows. The label
`texera.keep` on an execution (the Keep button) exempts it. `DELETE /workflows/{rid}/
executions/{eid}` removes a finished execution with its tables; `retention.blobs` (default a day)
removes uploaded files nobody committed.

## 6. Computing units

A computing unit is the engine deployment an execution goes to, and a resource: `provider:
static` is a unit already running at an `endpoint` (the dev stack's "local unit", started by
`run-unit.sh`, which presents the realm's `texera-unit` client to the lake), `provider:
kubernetes` is one the catalog starts and reconciles on the cluster (section 8): one pod of
the engine, with the memory and CPU its master node asks for (the "New computing unit" dialog
asks for both; changing them rolls the pod). A unit answers the catalog's client alone: there
is no route to it through the gateway and no person's token opens it; people and agents run
through the catalog, which authorizes and compiles first. Toward the lake and the catalog a
unit has an identity of its own, and reaches only the namespaces of the executions it ran.
Grant `user` on a unit to let someone run on it; `GET /computing-units/available` lists the
ones you may use.

An execution goes to the unit the request names, else the one its chat prefers, else the
workflow's, the project's or the platform's default. A chat is not bound to a unit: it has a
preference only when someone picked one in its box, and "Automatic" removes it. The catalog
applies the preference to every compile and execution the agent starts in that chat, so the
agent need not be told, and names a unit itself only when you ask for another. A preference
gives no right to the unit: it is passed over for someone in the chat who may not run on it.

## 7. Your own agents and tools

Anything that holds a person's token can do what the person can:

- **The MCP server.** `POST {gw}/mcp/catalog` is a streamable HTTP MCP server (`Accept:
  application/json, text/event-stream`) with one tool per operation of the contract: what
  exists (`whoami`, `search_resources`, `resolve_uri`, `get_resource`, `list_versions`,
  `get_version`, `get_lineage`, `grant_access`, `search_principals`, the dataset file tools,
  `list_operators`, `list_computing_units`) and the verbs of a workflow and its executions
  (`create_workflow`, `get_workflow`, `edit_workflow`, `validate_workflow`, `run_workflow`,
  `get_execution`, `pause_execution`, `resume_execution`, `get_port_result`). A list takes a
  `scope`, a project: it then holds that project and the built-ins. A tool that fails answers
  with the status and the words of the error, the engine's own when the engine refused. Point
  Claude Code, an SDK agent or any MCP client at it with a bearer token. The walkthrough shows
  one call.
- **The chat protocol.** `POST {gw}/agents/conversations/{rid}/ag-ui` runs one turn of the
  conversation's agent with an AG-UI `RunAgentInput` (only the new user message; the
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
- **409.** A change to a built-in resource, or to the Built-in project (`builtin`); a
  duplicate name in the project; a delete of something still referenced or still holding
  children (the response lists them); an execution on a unit that already runs one of this
  workflow; a unit with an execution on it being changed.
- **410** on an execution's rows: its results expired under the retention policy; keep the
  ones you need.
- **403** where you expected to be allowed: viewing never implies using; ask for `user` on the
  unit, credential or model endpoint, or `editor` to write.
- **An execution failed.** Its page and `get_execution` give the reason: an operator's own
  exception (a Python operator that raises fails it, with its traceback, instead of waiting), a
  compile error per operator, or what the engine refused.
- **The unit is not ready.** `logs/texera-2-0/unit.log`; the engine compiles with sbt on the
  first start and the catalog shows the unit as pending until its health answers.
- **Playwright has no browser.** `cd frontend-next && bunx playwright install chromium`, or
  `TEXERA_E2E_BROWSER_CHANNEL=chrome` for an installed Chrome.

## 10. Where to read more

| Document | What it holds |
| --- | --- |
| `bin/texera-2-0/README.md` | the dev stack: prerequisites, ports, the lake, Kubernetes |
| `docs/texera-2-0/TESTING.md` | the test layers, the scenario catalog, the rules, adding a scenario |
| `docs/texera-2-0/API-REQUESTS.md` | the conventions between the parts beyond the contract, including how an execution works |
| `docs/texera-2-0/PLAN.md`, `PROGRESS.md` | the milestone with its decisions and acceptance list; what was done, verified and comes next |
| `docs/texera-2-0/claude-docs/handoff.md` | where things stand, the gotchas, the next steps |
| `catalog/README.md`, `agent-runtime/README.md`, `frontend-next/README.md` | each part's run instructions, layout and rules |
| `api/catalog/*.tsp` | the contract: every kind, route, permission and MCP tool |
| `AGENTS.md` | the map of the repository and the rules for working in it |
