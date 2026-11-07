# Texera 2.0 handoff

Nov 4, 2026 · JB (design statements brought up to date on Nov 5; session 9 added the same day)

## Where things stand

Milestone M1, "the catalog contract, minimal and complete" (`docs/texera-2-0/PLAN.md`), is
closed on branch `texera-2-0` of the fork [bobbai00/texera](https://github.com/bobbai00/texera/tree/texera-2-0),
worktree `~/Desktop/texera-2-0` on this Linux box. For development every piece runs as a local
process over a Compose stack; the same stack also deploys to a local Kubernetes cluster in one
command, where computing units are created as resources. The lake (Lakekeeper) authenticates
every caller and authorizes with OpenFGA: each unit runs as a client of its own and reaches only
the namespaces of the executions it ran, which the catalog opens for it. An execution runs on a
computing unit and keeps its results in a warehouse, and both are resources: the platform's
warehouse is built in, a project can have its own, on the platform's store or on a store of
its own. Running a workflow goes through the
catalog in three phases: authorize (everything the plan names, before anything is written),
compile (one plan, as data, the same a dry run returns), materialize (the execution with its
plan, its namespace, a bound copy with presigned inputs and leased secrets to the engine, which
writes the tables the catalog named). A unit answers the catalog alone and reports as itself,
and while an execution goes it reports progress; it is paused and resumed through the catalog.
Every resource can be watched (an event stream the frontend follows), which makes a shared
conversation a group chat. All eleven acceptance items of the plan are demonstrated by
automated checks, and the close gate (`down.sh --wipe && up.sh && test.sh`) is green.

| Piece | Where | How to reach it |
| --- | --- | --- |
| Gateway (Envoy) | http://localhost:8088 | the only entry point; sign in as alice/alice or bob/bob |
| Catalog (Go) | :8090 | `/catalog/v1`, and its one MCP server at `/mcp/catalog` (every tool: resources, files, operators, units, and the workflow verbs) |
| Computing unit (Amber) | :28085 | reached by the catalog only |
| Agent runtime (Bun) | :23002 | `/agents/conversations/{rid}/ag-ui` |
| Live service (Bun, Hocuspocus) | :23003 | `/live/sessions`, a WebSocket: who is on a resource, and a workflow's document edited together |
| Bio MCP server | :23010 | `/bio-mcp`, its key a seeded credential |
| Frontend (vite) | :5174 | served through the gateway at `/` |
| Keycloak, OpenFGA, OpenBao, Postgres, RustFS, Lakekeeper | Compose project `texera2` | see `bin/texera-2-0/README.md` for ports; Lakekeeper takes a token (the catalog is its operator, the dev unit is `texera-unit`) |
| The same stack on Kubernetes | kind cluster `texera2`, namespace `texera2` | `bin/texera-2-0/k8s.sh up`, then http://localhost:28088; `k8s.sh check` proves a unit made as a resource |

## Since Nov 6: operators as lines, functions and models, caching, the resource graph

Built on Nov 7 (session 15; `docs/texera-2-0/PROGRESS.md` has the details and the checks), from
the plans in the Claude Docs "Texera 2.0: Operators, Runtimes and Caching" and "Texera 2.0: The
Resource Graph", each of which now carries a dated status under its Plan heading.

- The agent works in four phases: it reads and asks (`ask`), says its plan (`start_work`), then
  changes things; in a chat's manual work mode each change is an approval card
  (`agent-runtime/src/agent/work.ts`, `src/run/turn.ts`).
- Ten built-in operators with flat settings and a SQL expression language
  (`common/workflow-operator/.../operator/builtin/`), written by the agent as lines,
  `set night: filter(readings, where="...")` (`packages/workflow-model/src/lines.ts`,
  `agent-runtime/src/agent/workflow-lines.ts`): files and models by name, ports per type, each
  mistake on its line.
- A Python function under `@returns(...)` is a custom operator the catalog reads from its code
  (`catalog/internal/catalog/pyfunc.go`); the engine's `function` operator calls it per worker,
  whole groups with `by` (`Function.scala`, `pytexera/udf/function_operator.py`).
- A model version has a contract; `predict` runs it through a loader on Python workers and the run
  records that it used the version (`predict.go`, `Predict.scala`, `pytexera/udf/model_operator.py`).
- Caching: stored ports carry a fingerprint of the work; a run serves costly operators from what
  the project's runs stored, through the engine's `stored` source (`reuse.go`, `Stored.scala`).
- Profiles Small, Medium, Large, ML and GPU, each saying whether this deployment can start it.
- The resource graph beside a chat that started work: `GET /conversations/{rid}/graph`
  (`chat_graph.go`) and `packages/kinds/src/graph/`.
- Skills: texera-workflows, python-udf, reading-results, computing-units, exploring-resources,
  using-models (`catalog/internal/catalog/skills/`).
- A diabetes research team's project from public data, with a scientist's session through the
  real model: `bin/texera-2-0/examples/diabetes/`.

## What is done

- One contract (`api/catalog/`, TypeSpec) for sixteen kinds behind one envelope, with `texera://`
  URIs equal to REST paths, immutable versions with digests, executions nested under workflows with
  ports, grants, lineage, search, AuthZEN and OpenLineage routes. `cmd/catalogen` generates the
  kind table, the JSON Schema bundle, the MCP tool tables, the permission table and the indexes.
- The catalog: a twelve-table store, six ports (Identity, Authorizer, SecretStore, BlobStore,
  UnitProvider, LineageSink) with one adapter each and contract suites, a generic service and
  server, the generated MCP bridge. OpenFGA decides every call; viewing never implies using.
  Running a workflow is authorized, compiled and materialized in the catalog; the execution stores its
  plan (`spec.plan`, URIs only) and the engine gets one bound copy. Every resource has an
  event stream (`GET /resources/{rid}/events`, server-sent events through the gateway) fed by
  an in-process broker on the store's writes; an execution has pause and resume, forwarded to the
  unit, whose lineage reports (progress once a second, paused, running) drive the phase.
- The agent runtime as a stateless turn runner: a template version runs one turn of a
  conversation as the person; the platform key leased from OpenBao per turn. One seeded
  agent since Nov 5, the Texera Agent, the entry to every chat (it replaced the Data Analyst
  and the Bio Researcher). What a turn runs with is resolved by the catalog, in one place
  (`GET /conversations/{rid}/settings`): the chat's own choice, else its project's default,
  else the agent's own or the platform's. A chat stores choices only (agent, model, computing
  unit, add-on servers; a new chat stores `{}`) and is bound to no unit. The catalog's server
  holds the basic tools and always stays; the bio server is an add-on a chat can switch off and
  a turn can go without. Handoffs between templates and `/mode` remain in the runtime, unused
  by the shipped agent.
- Built in means "in the platform's project" (named Built-in, public, usable by everyone):
  the agent, the skills, the two MCP servers, the model endpoint, the unit, the operators.
  Nothing on a resource marks it; nobody but the platform changes one or adds to the project
  (`409 builtin`, administrators included), and each start makes the project what the release
  ships. Lists are scoped to a project plus the platform's (`?scope=`); a call made in a chat
  defaults to the chat's project, for lists and for where new resources go.
- The frontend: a generic page for every kind from its JSON Schema (spec, versions, access,
  lineage), the workflow editor, the execution page with the port view, and the chat. The
  sidebar picks the project a person works in (Personal by default); a chat starts by typing,
  and its box shows the agent and picks the model and the add-ons (a chat names no computing
  unit: a run goes where any run goes); the Agents page shows the built-in agent, read-only.
  The canvas edits like an editor (several cards picked and deleted at once, undo and redo of
  one's own edits, column settings picked from the input's columns), and an execution's
  results float in a window over the canvas, named as their operators' cards. Every page
  offers only what the catalog lets the person do (`useMay`). The execution page and
  the chat follow their
  resource's event stream, so a shared chat is a group chat (authors named, the other's turn
  shown and waited for) and an execution shows its progress and its pause and resume buttons.
- People together, since Nov 5 (session 9). A live service holds one session per resource:
  whoever may read a resource and has its page open is shown at its top right, and a workflow
  is one document its editors change at once (Yjs: operators and their properties merge per
  field, the layout is shared), loaded and saved by the service alone as versions that name
  the people whose edits they hold. The catalog stays the authority, and a session says how
  its document stands with it ("Not saved" and why, when the catalog refuses a version). A
  chat is a group chat with notes (a message that asks the agent nothing), names the model
  reads, and the answer arriving for everyone as it is written. Sharing has a button on every
  page, a "Shared with me" list and a page that says a link was not shared. Every resource's
  page has the agent a click away, told what the person is looking at.
- Checks in four layers (`docs/texera-2-0/TESTING.md`): unit (Go, sbt, Bun, vitest), contract
  (adapters and the engine against the stack's peers), scenario (44 pytest scenarios in
  `tests/e2e/`, twenty modules, one per use case, each in a project of its own), ui
  (Playwright, 29 tests in four files, four of them with the model);
  plus evals (the real agents through the real model) and the same against the cluster.

## Run and test

```
bin/texera-2-0/up.sh              # the stack: containers, then the catalog, unit, runtime, bio server, frontend
bin/texera-2-0/test.sh unit       # no stack: catalog, engine, runtime, frontend
bin/texera-2-0/test.sh scenario   # the end-to-end scenarios (pytest, tests/e2e) against the stack
bin/texera-2-0/test.sh ui         # Playwright against the stack
bin/texera-2-0/test.sh evals      # the real agents through the real model (needs the key)
bin/texera-2-0/test.sh gate       # down --wipe, up, then everything: the close gate
bin/texera-2-0/k8s.sh up && bin/texera-2-0/k8s.sh check   # the cluster, then the scenarios against it
```

`docs/texera-2-0/TESTING.md` explains the layers, the scenario catalog (one module per use
case), the fixtures (a project per test that goes away with it, guards for settings and
grants) and how to add a scenario. Reports: `logs/texera-2-0/reports/*.xml`.

## Next steps

The out-of-M1 table in `PLAN.md` lists what comes next with the interface each item builds on.
Done since the close: viewing never implies using, sharing with people who have not logged
in, typed operator output columns, kept canvas positions, credentials in operator properties,
images and the one-command Kubernetes deployment, the Kubernetes unit provider, Lakekeeper on
OpenFGA with one identity per unit, retention (an execution delete route, a results expiry
policy with an hourly sweep, unreferenced blobs), running a workflow in three phases with the unit's
doors closed and the output tables named by the catalog (steps 1 to 3 of the note "Texera
2.0: Authorize, Compile, Materialize"; results live with the execution, `texera.keep` keeps them),
the resource event stream with the group chat and the execution controls built on it, the
canvas as a shared document with a live service beside the runtime, a reply reaching the
other members of a chat as it is written (the runtime rewrites the message every 400 ms), and
on Nov 6 the fixes that using it found (session 14 in `PROGRESS.md`: names as labels, refusals
that say what is missing, the results window, resource control on every page). Designed and
not built: the resource graph beside the chat (the Claude Doc "Texera 2.0: The Resource
Graph", https://claude.ai/artifact/HKWSujDmAbLpRHM7JEkQ9Z, phases G1 to G5), and simpler
operators with runtimes, parallelism and caching (the Claude Doc "Texera 2.0: Operators,
Runtimes and Caching", https://claude.ai/artifact/YTxrrUqJfphVt6Sa5zv15v, phases E0 to E6).
Nearest gaps: steps 4 and 5 of that note; a turn that outlives the request of the person who
asked, with a stop any member can use; other people's cursors and selections on the canvas;
text merged inside a property (a Python operator's code is last write wins); a grant to a
group expanded in "Shared with me"; more than one live service (Hocuspocus's Redis
extension); the rest of the engine's interactive protocol (retry, skip, reconfigure, the
Python console) as catalog verbs; quotas and metering, groups beyond admins, a purge of
soft-deleted resources. Known limit: the
units still hold the store's static S3 key for large binaries (`STORAGE_S3_AUTH_*`), which also
reaches the warehouse's files; a key scoped to the objects prefix closes that.

## Gotchas

- **Never touch the remote EKS cluster** from this machine.
- **Other stacks share this machine.** Ports 8085, 18085, 2552, 3002, 5173 and 8080 belong to
  them; never stop their processes. `up.sh` refuses a port held by anything outside this worktree.
- **Keycloak.** A realm is imported once: a change to `keycloak/texera-realm.json` needs
  `down.sh --wipe` (`k8s.sh down` on the cluster). After a re-import, restart Envoy (it caches
  the key set) and the agent runtime (its service token). A person exists in the catalog once
  they have logged in.
- **Units talk to the catalog only, and only about their own executions.** A unit's API answers the
  catalog's client alone; the gateway has no route to units; a unit reports lineage as itself
  and the catalog refuses events from anyone but the execution's unit. A unit with no client
  configured reports nothing the catalog accepts.
- **Results live with the execution.** Save-as-dataset left the MVP (acceptance item 4 now reads as
  the execution's own lineage); an execution's `texera.keep` label keeps its results past the retention
  policy. Every execution stores the plan it was started with in `spec.plan`.
- **Watch, do not poll.** `GET /resources/{rid}/events` streams a resource's changes to whoever
  may read it; the frontend's `useWatch` and the scenarios' `events.Watch` use it. The broker
  is in-process (one catalog); replicas need Postgres LISTEN/NOTIFY behind the same type.
- **A paused execution is live.** `paused` is a phase between `running` and the end: not terminal,
  so no sweep, no delete; cancel works on it. The catalog never sets it itself; the unit's
  lineage report does.
- **The lake takes a token.** `curl` against Lakekeeper answers 401 without one; the catalog's
  client `texera-services` is the operator and sees everything, a unit's client only its executions.
  Keycloak's discovery document names the public issuer, which Lakekeeper reaches through a
  `socat` forward in its own network namespace (`lakekeeper-net` in Compose, the `auth`
  sidecar in the pod).
- **A name is a label**: two resources of a kind in one place may share one (since Nov 6);
  the rid and the URI are the identity.
- **The authorizer is a copy.** Grants reach OpenFGA through the outbox relay, one relay at a
  time and idempotently (`on_duplicate: ignore`); before Nov 5 two relays at the same moment
  could drop a new tuple that shared a request with one already there, leaving an owner
  refused on their own resource. Every start of the catalog writes the whole copy again
  (`access rebuilt` in its log), which heals an older stack; the work grows with the catalog.
- **Nobody's browser saves a workflow.** The live service does, and only it reads and writes
  the session's document (`/resources/{rid}/live`). A workflow page with the live service down
  shows the head read-only. A document the catalog has not taken stays in the service's
  memory until it is; restarting the service in that state loses those edits.
- **Hocuspocus on Bun.** Its `Server` class needs Node's `ws`; `live/src/server.ts` hands
  Bun's own WebSockets to `hocuspocus.handleConnection` instead.
- **The gateway's `/mcp/` and `/live/` routes** are prefixes with the trailing slash: `/mcp`
  alone also matched the app's `/mcp-servers/...` pages.
- **Browser scenarios run one at a time** (`workers: 1`): they act as the same two people and
  some change what a person works in.
- **Python for engine tests.** The uv-managed `.venv` at the repo root; `test.sh` sets
  `UDF_PYTHON_PATH`. Without it the engine's integration suites hang.
- **Engine ids** are derived from the catalog's UUIDs; a result table replaces one of the same
  name, so ids must never repeat.
- **Running the unit.** `sbt runMain` must fork; `run-unit.sh` does this.
- **test.sh's exit code** is the summary's; do not pipe it through `tail` when you need it.

## Where to read more

`docs/texera-2-0/GUIDE.md` is how to use the whole thing, from the first sign-in to the API
by hand and your own agents (`bin/texera-2-0/examples/walkthrough.py` is the runnable tour);
`PROGRESS.md` records every session's work, how it was verified and what came
next; `PLAN.md` is the milestone; `API-REQUESTS.md` the conventions beyond the contract;
`bin/texera-2-0/README.md` the stack; `catalog/README.md`, `agent-runtime/README.md` and
`frontend-next/README.md` their parts; `AGENTS.md` the map of the repository.
