# Texera 2.0 handoff

Nov 4, 2026 · JB

## Where things stand

Milestone M1, "the catalog contract, minimal and complete" (`docs/texera-2-0/PLAN.md`), is
closed on branch `texera-2-0` of the fork [bobbai00/texera](https://github.com/bobbai00/texera/tree/texera-2-0),
worktree `~/Desktop/texera-2-0` on this Linux box. For development every piece runs as a local
process over a Compose stack; the same stack also deploys to a local Kubernetes cluster in one
command, where computing units are created as resources. The lake (Lakekeeper) authenticates
every caller and authorizes with OpenFGA: each unit runs as a client of its own and reaches only
the namespaces of the runs it executed, which the catalog opens for it. A run goes through the
catalog in three phases: authorize (everything the plan names, before anything is written),
compile (one plan, as data, the same a dry run returns), materialize (the execution with its
plan, its namespace, a bound copy with presigned inputs and leased secrets to the engine, which
writes the tables the catalog named). A unit answers the catalog alone and reports as itself,
and while a run goes it reports progress; a run is paused and resumed through the catalog.
Every resource can be watched (an event stream the frontend follows), which makes a shared
conversation a group chat. All eleven acceptance items of the plan are demonstrated by
automated checks, and the close gate (`down.sh --wipe && up.sh && test.sh`) is green.

| Piece | Where | How to reach it |
| --- | --- | --- |
| Gateway (Envoy) | http://localhost:8088 | the only entry point; sign in as alice/alice or bob/bob |
| Catalog (Go) | :8090 | `/catalog/v1`, the MCP servers at `/mcp/catalog` and `/mcp/dataflow` |
| Computing unit (Amber) | :28085 | reached by the catalog only |
| Agent runtime (Bun) | :23002 | `/agents/conversations/{rid}/ag-ui` |
| Bio MCP server | :23010 | `/bio-mcp`, its key a seeded credential |
| Frontend (vite) | :5174 | served through the gateway at `/` |
| Keycloak, OpenFGA, OpenBao, Postgres, RustFS, Lakekeeper | Compose project `texera2` | see `bin/texera-2-0/README.md` for ports; Lakekeeper takes a token (the catalog is its operator, the dev unit is `texera-unit`) |
| The same stack on Kubernetes | kind cluster `texera2`, namespace `texera2` | `bin/texera-2-0/k8s.sh up`, then http://localhost:28088; `k8s.sh check` proves a unit made as a resource |

## What is done

- One contract (`api/catalog/`, TypeSpec) for fifteen kinds behind one envelope, with `texera://`
  URIs equal to REST paths, immutable versions with digests, runs nested under workflows with
  ports, grants, lineage, search, AuthZEN and OpenLineage routes. `cmd/catalogen` generates the
  kind table, the JSON Schema bundle, the MCP tool tables, the permission table and the indexes.
- The catalog: an eleven-table store, six ports (Identity, Authorizer, SecretStore, BlobStore,
  UnitProvider, LineageSink) with one adapter each and contract suites, a generic service and
  server, the generated MCP bridge. OpenFGA decides every call; viewing never implies using.
  A run is authorized, compiled and materialized in the catalog; the execution stores its
  plan (`spec.plan`, URIs only) and the engine gets one bound copy. Every resource has an
  event stream (`GET /resources/{rid}/events`, server-sent events through the gateway) fed by
  an in-process broker on the store's writes; a run has pause and resume, forwarded to the
  unit, whose lineage reports (progress once a second, paused, running) drive the phase.
- The agent runtime as a stateless turn runner: a template version runs one turn of a
  conversation as the person; handoffs between templates; `/mode`; the platform key leased
  from OpenBao per turn. Two seeded templates, Data Analyst and Bio Researcher.
- The frontend: a generic page for every kind from its JSON Schema (spec, versions, access,
  lineage), the workflow editor, the run page with the port view, the agent template form, the
  chat with the agent switcher and labelled messages; the run page and the chat follow their
  resource's event stream, so a shared chat is a group chat (authors named, the other's turn
  shown and waited for) and a run shows its progress and its pause and resume buttons.
- Checks in four layers (`docs/texera-2-0/TESTING.md`): unit (Go, sbt, Bun, vitest), contract
  (adapters and the engine against the stack's peers), scenario (fifteen pytest scenarios in
  `tests/e2e/`, one per use case, each in a project of its own), ui (Playwright, nine tests);
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
policy with an hourly sweep, unreferenced blobs), the run in three phases with the unit's
doors closed and the output tables named by the catalog (steps 1 to 3 of the note "Texera
2.0: Authorize, Compile, Materialize"; results live with the run, `texera.keep` keeps them),
the resource event stream with the group chat and the run controls built on it.
Nearest gaps: steps 4 and 5 of that note; token-level streaming of a reply to the other
members of a chat (today they see it step by step, as the runtime rewrites the message);
the canvas as a shared document (Yjs, as the 1.0 frontend had, with a sync service beside
the runtime); the rest of the engine's interactive protocol (retry, skip, reconfigure, the
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
- **Units talk to the catalog only, and only about their own runs.** A unit's API answers the
  catalog's client alone; the gateway has no route to units; a unit reports lineage as itself
  and the catalog refuses events from anyone but the execution's unit. A unit with no client
  configured reports nothing the catalog accepts.
- **Results live with the run.** Save-as-dataset left the MVP (acceptance item 4 now reads as
  the run's own lineage); a run's `texera.keep` label keeps its results past the retention
  policy. Every run stores the plan it was started with in `spec.plan`.
- **Watch, do not poll.** `GET /resources/{rid}/events` streams a resource's changes to whoever
  may read it; the frontend's `useWatch` and the scenarios' `events.Watch` use it. The broker
  is in-process (one catalog); replicas need Postgres LISTEN/NOTIFY behind the same type.
- **A paused run is live.** `paused` is a phase between `running` and the end: not terminal,
  so no sweep, no delete; cancel works on it. The catalog never sets it itself; the unit's
  lineage report does.
- **The lake takes a token.** `curl` against Lakekeeper answers 401 without one; the catalog's
  client `texera-services` is the operator and sees everything, a unit's client only its runs.
  Keycloak's discovery document names the public issuer, which Lakekeeper reaches through a
  `socat` forward in its own network namespace (`lakekeeper-net` in Compose, the `auth`
  sidecar in the pod).
- **Names are unique per project and kind**; the catalog answers 409 on a duplicate.
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
