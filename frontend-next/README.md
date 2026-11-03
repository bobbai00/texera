# Texera frontend

The one React app of Texera 2.0: a chat-first workspace where every resource the chat touches
(workflows, datasets, runs, agent templates, MCP servers, units, environments, projects, skills)
is a first-class card, panel and page. It talks to the catalog through the generated client,
to agents through AG-UI, and to a running unit through the engine WebSocket.

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
| `bun run e2e` | Playwright against the live stack (`e2e/texera2.spec.ts`) |
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
  workflow-model/     pure: the workflow JSON, graph edits and link rules, logical plan,
                      property schemas, compile interpretation, React Flow mapping
  ui/                 tokens (oklch, light/dark), Base UI primitives, Shell, panel stack,
                      ResourceHeader, DataTable, SandboxedFrame
  kinds/              one folder per kind + the registry + ResourceView; the engine WS client
  chat/               AG-UI client, conversation reducer, message parts, composer, mode picker
```

Routes:

| Path | Page |
|---|---|
| `/` | new chat: pick a mode (an agent template) and a unit |
| `/c/$rid` | a conversation, with the resources it produced in a rail |
| `/w/$rid`, `/d/$rid`, `/x/$eid`, `/t/$rid`, `/m/$rid`, `/u/$rid`, `/e/$rid`, `/p/$rid`, `/s/$rid` | one resource page per kind (`?vno=` pins a version) |
| `/library/$kind` | the library of one kind (`workflows`, `datasets`, `runs`, `templates`, `mcp-servers`, `units`, `environments`, `skills`, `projects`) |
| `/login`, `/callback` | Keycloak sign-in |

`?panel=kind:rid[@vno]` on any page names the resource open beside it.

## The kind registry

`packages/kinds/src/registry.ts` is the only place that maps a kind to code. Each kind is a
folder exporting a `KindSpec`:

```ts
interface KindSpec {
  kind: KindId;                 // "workflow", "dataset", "execution", ...
  label: string; plural: string;
  slug: string;                 // the page segment: /w/<rid>
  librarySlug: string;          // /library/workflows
  icon: LucideIcon;
  accent: string;               // "bg-kind-workflow/12 text-kind-workflow" (a token)
  Card: lazy component;         // inside chat messages and lists
  View: lazy component;         // the side panel and the full page (mode = "panel" | "page")
  prefetch?: (queryClient, ref) => Promise<unknown>;
  create?: (input) => Promise<ResourceRef>;   // the library's "New …" dialog
  facts?: (resource) => string[];             // short facts for lists and cards
}
```

`ResourceView({ ref, mode })` renders a kind at three sizes through the registry; the chat,
the library, the panel and the page never import a kind directly. A tool result that carries
a resource (an envelope `{kind, metadata}`, a ref `{kind, rid, vno}`, an execution `{eid,
workflow}`) renders that kind's card, never a tool name.

### Adding a kind

1. Add it to `KIND_IDS` in `packages/kinds/src/types.ts` and an accent token
   `--kind-<name>` in `packages/ui/src/styles/tokens.css`.
2. Create `packages/kinds/src/<name>/` with `spec.ts` (the `KindSpec`, its queries and
   `create`), `Card.tsx` and `View.tsx` (use `CardShell`, `KindHeader`, `Versions`, `Lineage`).
3. Register it in `registry.ts`; add it to `LIBRARY_KINDS` if it belongs in the sidebar.

The registry test checks slugs, accents and components for every kind.

## Rules

- Generated types only: no hand-written DTO, no endpoint string. The client comes from the
  contract; drift fails the build.
- Tokens only: no hex, no arbitrary pixel values outside `tokens.css`; light and dark from one
  set of variables.
- The access token stays in memory (oidc-client-ts, sessionStorage for the tab); it goes in the
  `Authorization` header and, for the engine WebSocket only, in `access_token=`.
- Workflow-produced HTML renders only inside the opaque-origin `SandboxedFrame`.
- Apache-2.0, MIT and BSD dependencies only, pinned.
