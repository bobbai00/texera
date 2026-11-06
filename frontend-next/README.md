# Texera frontend

The one React app of Texera 2.0: a chat-first workspace where every kind of the catalog
(workflows, executions, datasets, models, operators, environments, computing units,
warehouses, agents, skills, MCP servers, model endpoints, credentials, projects, settings) is
a card, a side panel
and a page. It talks to the catalog through the generated client and to agents through AG-UI;
executions are the catalog's, so the app never talks to an engine directly.

## Run it

```
# from the repository root, once
bun install

# the dev stack (Envoy, Keycloak, OpenFGA, Postgres, RustFS, Lakekeeper)
cd bin/texera-2-0 && docker compose up -d

# the catalog on :8090 and the agent runtime on :23002 (see their READMEs), then
cd frontend-next && bun run dev        # vite on :5174

# or all of the above in one command, from the repository root
bin/texera-2-0/up.sh
```

Open **http://localhost:8088/** — the gateway — not the vite port. The gateway proxies `/` to
vite (HMR included), checks the Keycloak token on `/catalog`, `/mcp` and `/agents`, and
serves Keycloak at `/auth`; computing units are not reachable through it, the catalog talks
to them. Test users: `alice`/`alice`, `bob`/`bob`.

| Script | What |
|---|---|
| `bun run dev` | vite on 5174 behind the gateway |
| `bun run build` | production bundle in `dist/` (route tree regenerated) |
| `bun run typecheck` | `tsc` over the app and, through imports, every package |
| `bun run test` | vitest: the app's tests and `packages/*/src/**/*.test.*` |
| `bun run e2e` | Playwright against the live stack (`e2e/*.spec.ts`: the app, the agent beside a page, sharing, people together); `TEXERA_E2E_SKIP_MODEL=1` leaves out the real-model scenarios |
| `bun run lint` | biome over the app's `src`. The packages are named in the script and the config but lie outside the config's root, so biome skips them: they are not linted or formatted yet (see `PROGRESS.md`, Nov 5) |

## Layout

```
frontend-next/src
  main.tsx            client config (token), query client, router, toasts
  auth/               oidc-client-ts session: PKCE login, silent renew, /callback, sign-out
  app/                AppShell (Shell + panel + ⌘K), Sidebar and the rail it collapses to,
                      CommandMenu, PanelSync (?panel= ⇄ stack)
  routes/             TanStack file routes (below)
packages/
  catalog-client/     generated from the OpenAPI contract: types, SDK, TanStack Query options, Zod
  workflow-model/     pure: the workflow spec, graph edits and link rules, the canvas layout,
                      operator schemas, an operator's settings in words (summary.ts), compile
                      interpretation, React Flow mapping, and the spec as a document several
                      people edit at once (live.ts, shared with the live service)
  service-auth/       a service's own token (client credentials), for the runtime and the
                      live service
  ui/                 tokens (oklch, light/dark; nothing on screen under 12px), Base UI
                      primitives, Shell, panel stack, ResourceHeader, DataTable, SandboxedFrame
  kinds/              the URI grammar, the kind registry, the generic page, one module per kind,
                      a resource's live session (live/), what the person is looking at
                      (shell/viewing.ts), sharing (shell/Share.tsx, library/Shared.tsx), the
                      results of an execution under a canvas (results/), the lineage graph
                      (lineage/), the person's preferences (preferences.ts)
  chat/               AG-UI client, conversation reducer, message parts, composer, new chat,
                      the chat beside a page (ChatDock.tsx)
```

Routes are the catalog's paths: a resource's page is its URI without the scheme.

| Path | Page |
|---|---|
| `/` | a new chat: type to start. The box shows the agent and picks the model, the computing unit (Automatic by default) and the add-on servers |
| `/conversations/$rid` | a chat: its messages and the resources it produced in a rail |
| `/{plural}` | the library of one kind: `/workflows`, `/datasets`, `/operators`, … |
| `/{plural}/$rid` | the page of one resource (`?vno=` pins a version) |
| `/workflows/$rid/executions/$eid` | an execution, nested under its workflow as its URI is |
| `/shared` | what other people shared with the person, of any kind and project |
| `/settings` | the deployment's settings (administrators) |
| `/login`, `/callback` | Keycloak sign-in |

`?panel=datasets/$rid@2` on any page names the resource open beside it.

## Names

`packages/kinds/src/uri.ts` is the one grammar of names, the same as the catalog's
`internal/uri`: `texera://{plural}/{rid}[@vno][/subresource]`, with executions nested as
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
  CreateFields?: component;                  // what that dialog asks besides a name (a unit's memory and CPU)
  facts?: (resource) => string[];            // short facts for lists, cards and the chat box's pickers
  long?: string[]; hidden?: string[];        // hints for the schema form
}
```

The generic page (`shell/GenericView.tsx`) renders any kind from its envelope: the name and
description, the kind's own tabs, then the spec as a form generated from the kind's JSON Schema
(`schema/SchemaForm.tsx`, with the raw JSON a click away), its versions, who can access it
(visibility and grants, with principal search), its lineage (a graph, below) and the envelope
itself. Most kinds are a single file under `kinds/` that declares the registry entry; the ones
with their own surfaces are folders: `workflow/` (the canvas, below), `execution/` (the
workflow as it ran with its results, the controls, the keep mark),
`agent-template/` (the form over card, model endpoint, prompt, skills, MCP servers, handoffs and
loop), `files/` (the files and staging tabs datasets and models share).

`ResourceView({ ref, mode })` renders a kind at three sizes through the registry; the chat, the
library, the panel and the page never import a kind directly. A tool result or an event that
carries a resource (an envelope, a ref, a URI) renders that kind's card, never a tool name.

### Adding a kind

1. Declare it in the contract (`api/catalog/kinds/<name>.tsp`, imported by `main.tsp` and
   named in `ResourceKind` of `core.tsp`) and run `make generate`; the kind table, the JSON
   Schema bundle and the client follow.
2. Add an accent token `--kind-<name>` in `packages/ui/src/styles/tokens.css`.
3. Add `packages/kinds/src/kinds/<name>.ts` with the `KindSpec` (icon, `defaultSpec`, `facts`,
   and tabs or an editor when the schema form is not enough), register it in `registry.ts`,
   and name its create and update calls in `api.ts` when the app makes or changes it.

The registry test checks that every kind of the contract is registered with its accent.

## The canvas

A workflow, and an execution of one, are shown on one canvas (`packages/kinds/src/workflow/`).

- **An operator is a card** (`OperatorNode.tsx`). It says the operator's name and its settings
  in words (`describeProperties` in `workflow-model/summary.ts`: a file by its name, a list of
  conditions as written, code by its length, defaults left out), in one line or with each
  setting on a line. How much the cards say is the viewer's choice (`canvas-view.ts`:
  "Compact | Detailed" for the canvas), kept in the browser, never in the workflow.
- **The operator's own buttons** are on its card: the eye (`viewResult`, its result kept on
  every run; in sight while on) and a run up to it (`upTo` on a run). Turning it off and
  deleting it are on a right click.
- **It is edited in place.** The pencil, or a double click, opens the card into the
  operator's form (`PropertyForm.tsx`; code a few lines in the card and all of it in a larger
  editor); every change goes into the workflow as it is made. The open card stays within its
  column and the cards under it are drawn lower while it is open (`room.ts`). There is no
  panel beside the canvas. The list of operators opens from "Add operator".
- **Places are for cards that say one line** (`workflow-model/layout.ts`). Cards that say
  more are taller, so while they do the rows are drawn further apart by one factor for the
  canvas (`density.tsx`); nothing is moved in the workflow. The canvas opens at a size its
  words can be read at and is moved by hand from there (`framing.ts`), and keeps in view the
  operator whose result is on screen and the card that is open.
- **Nothing lies over the operators unasked** (`controls.tsx`). The zoom buttons sit in a
  corner; a workflow of a dozen operators or more has a map, which the viewer opens from a
  button there and which stays as they left it (`canvas-view.ts`).
- **An execution shows on the cards** (`execution/overlay.ts`): where each operator stands,
  the rows it read and put out, why it failed, and which of its results are kept. A running
  card has a moving bar; an arrow moves while its operator runs and has put rows out. The
  workflow's page shows its latest execution; an execution's page shows the version that ran
  (`WorkflowCanvas.tsx` with a view), laid out from its graph.
- **Results are tied to where they came from** (`results/`). Under the canvas one tab per
  output port whose result is kept (a port the catalog keeps a table for); a click on a card
  shows its result, rings the card and lights the port it came out of. A result whose one
  column is `html-content` is what a visualization operator drew and is shown as that page in
  `SandboxedFrame`; the unit serves such a cell whole and cuts any other long string for a
  table's cell.
- **Every graph draws its arrows the same way** (`shell/canvas.ts`, the `--edge` token): the
  canvas and the lineage graph.

## Lineage

`shell/Lineage.tsx` is the tab; `lineage/` holds the graph. `model.ts` turns the catalog's
edges into cards and arrows at one of two levels: "Resources" (one card per resource and per
execution, an execution's results folded in, parallel arrows merged) and "Data flow" (files,
versions, executions and one card per result). Data runs left to right, so `used`,
`references`, `derivedFrom` and `reused` are drawn the reverse of how they are stored; an arrow
is dashed when a spec only names the thing. A workflow's two most recent executions are cards
and earlier ones fold into one. `layout.ts` is a layered layout with no dependency.

## Projects and built-ins

The sidebar picks the project a person works in (`packages/kinds/src/scope.tsx`): Personal by
default, kept in their preferences, or "All projects". A library lists that project's resources
and the platform's (`?scope=`), and so do the chats listed below the picker. What a person
makes goes into the project they work in, wherever they make it (`useDestination`): the "New
…" dialog names it; with every project in view the dialog and the chat box ask, the chat
beside a page starting from that page's project; nothing is made while the working project is
not known yet. A project made in the app is worked in at once. Preferences are one object the
catalog replaces whole, so one writer changes them (`preferences.ts`): it reads what the
catalog has, changes that, and writes it back, one change at a time. A resource of the
platform's project is built in: its row carries a badge, its page is read-only and has no
delete, and its access tab says why (`shell/builtin.ts`). The workflow editor lists what the
workflow's own project can use, wherever the person is working.

## The chat

A conversation's spec holds the chat's own choices and nothing else: the agent, the model
endpoint, the computing unit and the add-on MCP servers, each optional, none in a new chat.
What a turn runs with is the catalog's answer (`GET /conversations/{rid}/settings`, or
`/projects/{rid}/chat-settings` before the chat exists): the chat's choice, else the project's
default, else the agent's own or the platform's. The chat box (`ChatSettingsBar.tsx`) shows
that answer and writes a choice only when the person makes one; "Automatic" stores no unit, so
a chat is bound to none. A chat is created by its first message (`NewChat.tsx`).

The chat posts each turn to the agent runtime's AG-UI endpoint
(`/agents/conversations/{rid}/ag-ui`) and reduces the event stream into messages of parts
(`packages/chat/src/model.ts`); when the turn ends, the catalog's persisted messages replace
the live ones, except an error the catalog never got, which stays on screen. Every assistant
message carries the agent version and the model endpoint that wrote it, shown as a label. The
platform ships one agent, shown read-only under Agents; a `texera.handoff` event or a system
note naming another template (from a chat of an older release) still renders as a divider.

A shared chat is a group chat. The others' messages and the answer to someone else's turn
arrive through the conversation's event stream (`packages/kinds/src/watch.ts`), the answer as
it is written; one turn runs at a time, and the box says whose. A message asks the agent
unless it is posted as a note (`useConversation().note`): a message of no turn, marked as a
note and outlined instead of filled.

## The agent beside a page

`ChatDock.tsx`, mounted once in the app shell, puts a chat button at the bottom right of every
resource's page. The chat it opens is an ordinary conversation; what makes it about the page is
what each message carries: AG-UI's `context` of a run, built by `shell/viewing.ts` from the
page's address (`pageResource`) and from what the page itself adds (`useTellViewing`: the
operator selected on a canvas). The runtime writes it into the turn's state and the agent's
prompt says what "this" then means. Nothing is bound: the app remembers the chat last used
beside each page in the person's preferences (`dock.ts`), and the chat is made in the project
the person works in, like anything they make. Before a
message is sent the page settles (`settleViewing`): a workflow's session saves, so the agent
reads what is on screen.

## People together

A resource's page joins the resource's live session (`packages/kinds/src/live/room.ts`): one
connection per resource for every view of it, left when the last view goes. `Presence.tsx`
shows who is in it, at the top right of every page and chat.

A workflow's editor reads and writes the session's document, not the catalog
(`workflow/document.ts`, `workflow/editor.ts`): an edit is the difference between the spec the
person saw and what they made of it, written into the document, and it comes back from the
document the same way someone else's does. The store holds no draft and saves nothing; the
live service does, and the page shows what the session says: "Saved", "Saving", "Offline", or
"Not saved" with the catalog's reason. `Run` asks the session to save first and runs the
version it answers with. An older version is the same editor over a document that never
changes; a session that cannot be reached shows the head read-only.

A person the session or the resource's watch turns away may no longer read the resource: the
app asks the catalog again about it (`askAgain` in `queries.ts`) and the view shows the answer,
which is `shell/OpenError.tsx`: "has not been shared with you" or "does not exist" instead of
a failure.

## Rules

- Generated types only: no hand-written DTO, no endpoint string. The client comes from the
  contract; drift fails the build.
- Tokens only: no hex, no arbitrary pixel values outside `tokens.css`; light and dark from one
  set of variables.
- The access token stays in memory (oidc-client-ts, sessionStorage for the tab); it goes in the
  `Authorization` header and nowhere else.
- Workflow-produced HTML renders only inside the opaque-origin `SandboxedFrame`.
- Apache-2.0, MIT and BSD dependencies only, pinned.
