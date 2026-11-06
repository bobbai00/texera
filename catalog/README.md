# Texera catalog

The control plane of Texera 2.0: one Go binary that serves the catalog API (`/catalog/v1`),
decides every call through the authorizer, runs workflows on computing units, records
lineage, and exposes every tool of the platform as one generated MCP server (`/mcp/catalog`). It is
generated from the TypeSpec contract under `api/catalog/`; nothing about a kind is written by
hand twice.

## Run it

```
# from the repository root: the dev stack starts it on :8090 (see bin/texera-2-0/README.md)
bin/texera-2-0/up.sh

# by hand, against a running stack
cd catalog && go build -o bin/catalog ./cmd/catalog && ./bin/catalog

# regenerate after a contract change (OpenAPI, Go types, the kind table, the MCP tool
# tables, the permission table, the index migration, the TypeScript client)
make generate && make check-drift

# tests: the store and server suites use the stack's Postgres (TEXERA_TEST_DATABASE_URL)
go test -p 1 ./...
go test -tags integration ./internal/adapters/...   # the port contract suites against OpenBao, RustFS, OpenFGA
```

## Layout

| Package | What it is |
| --- | --- |
| `cmd/catalog` | wires configuration, the store, the adapters and the server |
| `cmd/catalogen` | reads the OpenAPI document and emits `kinds.gen.go`, `schema.gen.json`, `tools.gen.go`, `permissions.gen.go`, `0002_indexes.gen.sql` and the TypeScript kind table |
| `internal/api` | the Go types `oapi-codegen` generates from the contract |
| `internal/kinds` | the generated kind table and JSON Schema validation of specs and statuses |
| `internal/uri` | the one grammar of names: `texera://{plural}/{rid}[@vno][/subresource]`, executions nested under workflows, and the reference extractor |
| `internal/store` | Postgres: twelve tables, generic over kinds (resources, versions, grants and the access index, the outbox, blobs and staging, edges and lineage events, messages, leases, the document of a live session) |
| `internal/ports` | the eight ports: Identity, Workloads (unit identities), Authorizer, SecretStore, BlobStore, UnitProvider, Lake (the table catalog: its warehouses and the namespaces in them), LineageSink |
| `internal/adapters` | one adapter per port (keycloak for Identity and Workloads, openfga, openbao, s3cas, staticunit, kube, lakekeeper, noop), `unitmux` to offer static and Kubernetes units side by side, and the memory adapters tests use |
| `internal/auth`, `internal/authz` | who is calling (OIDC claims to a principal) and the policy decision point with the outbox relay to the authorizer |
| `internal/catalog` | the domain service, one file per area: resources, hooks per kind, files, plan, executions, warehouses, lineage, compute, conversations, chat settings, events (a resource's watch), live (what the live service keeps and saves for people), iam, credentials, seed, the shipped agent (`agents/`) and skills (`skills/`) |
| `internal/server` | the HTTP server: generic routes from the kind table plus the actions, validated against the contract in tests |
| `internal/mcp` | the MCP bridge: a tool call becomes the operation's request against the API in process, with the caller's token |
| `internal/engine` | the client of a computing unit's engine API |

## Rules

- The contract is the only hand-written description of the API; every `*.gen.*` file is
  generated and committed, and `make check-drift` fails when they disagree.
- Every route and tool names its permission (`x-texera-permission`); the server test asserts
  every operation of the permission table is routed.
- The catalog is a client of its peers and copies only immutable facts: no secret in Postgres,
  no authorization decision cached, a peer's storage never read directly.
- Names are unique per project and kind; the rid is the identity and URIs carry rids.
- A watch is for someone who may read: the right is asked again on every beat of an open
  stream (15 seconds), so a grant taken back ends it.
- The live service is a service like the runtime: only it reads and writes the document of a
  workflow's session (`/resources/{rid}/live`) and saves a version in the names of the people
  who edited it (`onBehalfOf`). A person goes through it.
- An edit that names the head its writer saw (`expectedHead`) is refused as a conflict when
  the head moved, before a patch is tried on a spec the writer never read.
