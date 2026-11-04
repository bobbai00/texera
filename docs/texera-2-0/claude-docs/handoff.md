# Texera 2.0 handoff

Nov 4, 2026 · JB

## Where things stand

Milestone M1, "the catalog contract, minimal and complete" (`docs/texera-2-0/PLAN.md`), is
closed on branch `texera-2-0` of the fork [bobbai00/texera](https://github.com/bobbai00/texera/tree/texera-2-0),
worktree `~/Desktop/texera-2-0` on this Linux box. For development every piece runs as a local
process over a Compose stack; the same stack also deploys to a local Kubernetes cluster in one
command, where computing units are created as resources. The lake (Lakekeeper) authenticates
every caller and authorizes with OpenFGA: each unit runs as a client of its own and reaches only
the namespaces of the runs it executed, which the catalog opens for it. All eleven acceptance
items of the plan are demonstrated by automated checks, and the close gate (`down.sh --wipe &&
up.sh && test.sh`) is green.

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
- The agent runtime as a stateless turn runner: a template version runs one turn of a
  conversation as the person; handoffs between templates; `/mode`; the platform key leased
  from OpenBao per turn. Two seeded templates, Data Analyst and Bio Researcher.
- The frontend: a generic page for every kind from its JSON Schema (spec, versions, access,
  lineage), the workflow editor, the run page with the port view, the agent template form, the
  chat with the agent switcher and labelled messages.
- Checks: Go, Bun and vitest suites; the engine's sbt suites; eight smoke scripts through the
  gateway; Playwright on Chrome with seven tests, two of them with the real model.

## Run and test

```bash
bin/texera-2-0/up.sh            # the stack and the host services; idempotent
bin/texera-2-0/test.sh          # suites, then the end-to-end checks (needs up.sh)
bin/texera-2-0/test.sh suites   # Go, TypeScript and sbt suites only
bin/texera-2-0/test.sh e2e      # end-to-end only
bin/texera-2-0/down.sh --wipe   # stop everything and drop the volumes
python3 bin/texera-2-0/smoke-chat.py --demo   # the M1 scenario with the real model
```

The model key is read at launch from the gitignored repo-root `.env` (`ANTHROPIC_API_KEY`) and
loaded into OpenBao; without it everything but the chat works. Playwright drives the installed
Google Chrome here (`TEXERA_E2E_BROWSER_CHANNEL=chrome`, set by the scripts).

## Next steps

The out-of-M1 table in `PLAN.md` lists what comes next with the interface each item builds on.
Done since the close: viewing never implies using, sharing with people who have not logged
in, typed operator output columns, kept canvas positions, credentials in operator properties,
images and the one-command Kubernetes deployment, the Kubernetes unit provider, Lakekeeper on
OpenFGA with one identity per unit. Nearest gaps: retention (an execution delete route, expiry
of results, unreferenced blobs), quotas and metering, groups beyond admins. Known limit: the
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

`docs/texera-2-0/PROGRESS.md` records every session's work, how it was verified and what came
next; `PLAN.md` is the milestone; `API-REQUESTS.md` the conventions beyond the contract;
`bin/texera-2-0/README.md` the stack; `catalog/README.md`, `agent-runtime/README.md` and
`frontend-next/README.md` their parts; `AGENTS.md` the map of the repository.
