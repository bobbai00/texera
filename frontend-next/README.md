# Texera frontend

The one React app of Texera 2.0: a chat-first workspace where every kind of the catalog
(workflows, runs, datasets, models, operators, environments, computing units, agent templates,
skills, MCP servers, model endpoints, credentials, projects, settings) is a card, a side panel
and a page. It talks to the catalog through the generated client and to agents through AG-UI;
runs are the catalog's, so the app never talks to an engine directly.

## Run it

```
# from the repository root, once
bun install

# the dev stack (Envoy, Keycloak, OpenFGA, Postgres, RustFS, Lakekeeper)
cd bin/texera-2-0 && docker compose up -d

# the catalog on :8090 and the agent runtime on :3002 (see their READMEs), then
cd frontend-next && bun run dev        # vite on :5174
```

Open **http://localhost:8088/** — the gateway — not the vite port. The gateway proxies `/` to
vite (HMR included), checks the Keycloak token on `/catalog`, `/agents` and `/units`, and
serves Keycloak at `/auth`. Test users: `alice`/`alice`, `bob`/`bob`.

| Script | What |
|---|---|
| `bun run dev` | vite on 5174 behind the gateway |
| `bun run build` | production bundle in `dist/` (route tree regenerated) |
| `bun run typecheck` | `tsc` over the app and, through imports, every package |
| `bun run test` | vitest: the app's tests and `packages/*/src/**/*.test.*` |
| `bun run e2e` | Playwright against the live stack (`e2e/texera2.spec.ts`); `TEXERA_E2E_SKIP_MODEL=1` leaves out the real-model scenarios |
| `bun run lint` | biome over the app and the packages |

## Layout

```
frontend-next/src
  main.tsx            client config (token), query client, router, toasts
  auth/               oidc-client-ts session: PKCE login, silent renew, /callback, sign-out
  app/                AppShell (Shell + panel + ⌘K), Sidebar, CommandMenu, PanelSync (?panel= ⇄ stack)
  routes/             TanStack file routes (below)
packages/
  catalog-client/     generated from the OpenAPI contract: types, SDK, TanStack Query options, Zod
  workflow-model/     pure: the workflow spec, graph edits and link rules, the canvas layout,
                      operator schemas, compile interpretation, React Flow mapping
  ui/                 tokens (oklch, light/dark), Base UI primitives, Shell, panel stack,
                      ResourceHeader, DataTable, SandboxedFrame
  kinds/              the URI grammar, the kind registry, the generic page, one module per kind
  chat/               AG-UI client, conversation reducer, message parts, composer, template picker
```

Routes are the catalog's paths: a resource's page is its URI without the scheme.

| Path | Page |
|---|---|
| `/` | new chat: pick an agent template and a unit |
| `/conversations/$rid` | a chat: its messages, the agent switcher, the resources it produced in a rail |
| `/{plural}` | the library of one kind: `/workflows`, `/datasets`, `/agent-templates`, … |
| `/{plural}/$rid` | the page of one resource (`?vno=` pins a version) |
| `/workflows/$rid/executions/$eid` | a run, nested under its workflow as its URI is |
| `/settings` | the deployment's settings (administrators) |
| `/login`, `/callback` | Keycloak sign-in |

`?panel=datasets/$rid@2` on any page names the resource open beside it.

## Names

`packages/kinds/src/uri.ts` is the one grammar of names, the same as the catalog's
`internal/uri`: `texera://{plural}/{rid}[@vno][/subresource]`, with runs nested as
`texera://workflows/{rid}/executions/{eid}`. Every reference the app handles (a message part, a
lineage edge, a template's skills, a conversation's template, a file an operator reads) is one
of these, parsed into a `ResourceRef {kind, rid, vno?, parent?}` and written back with `uriOf`.

## The kind registry

`packages/kinds/src/registry.ts` is the only place that maps a kind to code. What the contract
knows about a kind (its plural, whether it is versioned, nested or a singleton, the name of its
spec schema) comes from the generated kind table (`kinds.gen.ts`); the registry adds what the
app knows:

```ts
interface KindSpec {
  kind: KindId;                 // "workflow", "dataset", "execution", "agent-template", ...
  label: string; plural: string;
  icon: LucideIcon;
  accent: string;               // "bg-kind-workflow/12 text-kind-workflow" (a token)
  Card?: lazy component;        // replaces the generic card (name, description, facts)
  View?: lazy component;        // replaces the generic page and panel
  Editor?: component;           // replaces the schema form in the page's spec tab
  tabs?: KindTab[];             // tabs the generic page shows before the shared ones
  Actions?: component;          // header actions
  defaultSpec?: (input, defaults) => spec;   // the library's "New …" dialog
  facts?: (resource) => string[];            // short facts for lists and cards
  long?: string[]; hidden?: string[];        // hints for the schema form
}
```

The generic page (`shell/GenericView.tsx`) renders any kind from its envelope: the name and
description, the kind's own tabs, then the spec as a form generated from the kind's JSON Schema
(`schema/SchemaForm.tsx`, with the raw JSON a click away), its versions, who can access it
(visibility and grants, with principal search), its lineage (the edge table walked upstream and
downstream, plus the specs that reference it) and the envelope itself. Most kinds are a single
file under `kinds/` that declares the registry entry; the ones with their own surfaces are
folders: `workflow/` (the canvas editor; the spec holds no positions, the app lays the graph
out), `execution/` (phase, operators, the port view with paged rows, save as dataset),
`agent-template/` (the form over card, model endpoint, prompt, skills, MCP servers, handoffs and
loop), `files/` (the files and staging tabs datasets and models share).

`ResourceView({ ref, mode })` renders a kind at three sizes through the registry; the chat, the
library, the panel and the page never import a kind directly. A tool result or an event that
carries a resource (an envelope, a ref, a URI) renders that kind's card, never a tool name.

### Adding a kind

1. Declare it in the contract (`api/catalog/kinds/<name>.tsp`) and run `make generate`; the
   kind table, the JSON Schema bundle and the client follow.
2. Add an accent token `--kind-<name>` in `packages/ui/src/styles/tokens.css`.
3. Add `packages/kinds/src/kinds/<name>.ts` with the `KindSpec` (icon, `defaultSpec`, `facts`,
   and tabs or an editor when the schema form is not enough) and register it in `registry.ts`.

The registry test checks that every kind of the contract is registered with its accent.

## The chat

A conversation's spec names the agent template its next turn runs. The chat posts each turn to
the agent runtime's AG-UI endpoint (`/agents/conversations/{rid}/ag-ui`) and reduces the event
stream into messages of parts (`packages/chat/src/model.ts`); when the turn ends, the catalog's
persisted messages replace the live ones. Every assistant message carries the template version
that wrote it, shown as a label where the agent changes. Switching agents goes through the
host's `/mode` command, whether typed or picked from the switcher; a handoff by an agent and a
switch by the person both arrive as `texera.handoff` events and are kept as system notes that
name the new template, rendered as dividers.

## Rules

- Generated types only: no hand-written DTO, no endpoint string. The client comes from the
  contract; drift fails the build.
- Tokens only: no hex, no arbitrary pixel values outside `tokens.css`; light and dark from one
  set of variables.
- The access token stays in memory (oidc-client-ts, sessionStorage for the tab); it goes in the
  `Authorization` header and nowhere else.
- Workflow-produced HTML renders only inside the opaque-origin `SandboxedFrame`.
- Apache-2.0, MIT and BSD dependencies only, pinned.
