<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# AGENTS.md — frontend-react

Rules for `frontend-react/`, on top of the repo-root [`AGENTS.md`](../AGENTS.md). Start at [`README.md`](README.md)
for the layout and the commands.

## Folders

- **`routes/`** files are thin: params, search, guard, loader, and which component. A loader calls
  `context.queryClient.ensureQueryData`, and the page reads the same query with `useSuspenseQuery`.
- **`features/<name>/`** owns its backend calls (`api.ts`: types, calls, query options) and its components.
  Mutations invalidate the queries they change. The backend's field names (`did`, `creationTime`, `accessPrivilege`)
  stop at `api.ts`, which turns each answer into the app's own shape.
- **`components/`** holds only what several features share, and never imports from a feature: what differs between
  features comes in through props. Never edit `components/ui/`: it is shadcn/ui code, kept as generated for its MIT
  license notice.
  - **`layout/`**: every page is a `Page` with a `PageHeader`, and its parts are `Section`s. A link to a page that
    may still be in the Angular app is a `PageLink`.
  - **`feedback/`**: an error is shown with `ErrorAlert`, and a list or section with nothing in it with `EmptyState`.
  - **`resource/`**: a workflow, a dataset, a model and a computing unit are each a `Resource` (`lib/resource.ts`).
    Use `ResourceListPage`, `ResourcePageHeader`, `ResourceActions`, `ShareDialog` and `VersionSelect` for them
    rather than writing one per kind, key their queries under `resourceKey` and `resourceListKey`, and say where a
    kind's pages are in `kinds.tsx`. A shared component never tests a kind's name: what differs between kinds is a
    field of `kinds.tsx`, such as whether a kind's resources can be public, or comes in through props. Every list of
    resources, of any kind, the user's or the hub's, is a `ResourceListPage` read through `resourceListQuery`, with
    its search, order and list or card view; a kind adds to its items through `itemDetails` and `itemPage`, never with
    a list of its own.
  - A version of a dataset or a model that something reads, such as an operator, is a `ResourceChip`, drawn from its
    path alone, which looks the resource up only once it is opened (`resourceLookupQuery`). A kind's color, its name
    and its page at a version are fields of `kinds.tsx` (`tone`, `singular`, `versionPage`), and the versions of any
    kind are read through `versionListQuery`.
  - A person anywhere (an owner, a collaborator, the user in the header) is a `UserAvatar` from `components/`.
  - **`floating/`**: a panel over a canvas is a `FloatingPanel` in a `FloatingArea`, never a panel positioned by hand;
    what lies under the panels makes room for the docked ones through `useFloatingInsets()`. A user's choice kept in
    their browser goes through `useStoredState`, never `localStorage` directly. Things the user puts in order by
    dragging use dnd-kit (`@dnd-kit/sortable`), as the workspace panel's rail does, with Alt and an arrow key to do
    the same from the keyboard.
- **Access**: whether a button that acts on a resource is shown is `can(resource, action)` from `lib/resource.ts`,
  never a comparison with an access level or a privilege.
- **Surfaces**: what sits on its own surface is a `Card` (a `Section` on a page), never its classes typed again.
- **Shared components fit the space they are in**, not the screen: use container queries (`@container`, `@2xl:`),
  and keep screen breakpoints (`md:`) to the shell. A shared component reads nothing from the address.
- **Forms** use `Field`, `FieldLabel` and `FieldError` from `components/ui/field`, and read their values with
  `formText` from `lib/form.ts`.
- **Workflows** (`lib/workflow/`, `features/workflow/`):
  - The saved shape of a workflow (`model.ts`) keeps the engine's own names and every key it does not know.
  - Everything on the canvas is read and changed through `document.ts`; nothing else touches the Yjs types. Each
    method of `WorkflowDocument` is one step to undo and one change to everyone else in the room. The one
    exception is an operator's code, which is shared text that the code editor types into (`document.code()`).
  - The app never loads or saves a workflow's content: the shared editing service does (`shared-editing-service/`,
    `room.ts`). What the app and the service agree on is in `shared-editing.ts` and `document.ts`, and the service
    imports nothing else of the app.
  - Where each person is (selection, pointer, the card they edit, open code) goes through `WorkflowRoom`; components
    read it as `collaborators` and `me` (`RoomState`) and never touch the awareness, except the code editor for the
    cursors in code.
  - Who holds an operator is `holds.ts`'s answer: of those who opened its card to change it, whoever began first.
    Components never compare awareness fields. The editor asks once (`heldByOthers`) and gives the answer to the
    canvas and to the commands, which change only what no one else holds (`changeable`) and say who has the rest
    (`leftAlone`); a card someone else holds opens only to read. A hold stops changing, never reading, and coordinates
    people in the UI only: the service, undo, redo and restoring a version do not look at it. Someone who may only
    look, or who looks at a version, claims nothing.
  - Someone else is drawn in their color through `presenceClassNames`, and who is editing is worded by
    `editingNotice` (`presence.ts`).
  - An operator is a card on the canvas (`operator-node.tsx`), and its settings are edited in its card, never in a
    panel: one card open per viewer, which the editor alone opens and closes (`edit()`), with the operator's
    properties in it (`operator-properties.tsx`). The canvas takes the open card's body as a render prop (`card`), and
    what every card needs of the canvas reaches it through `CardCanvasContext` (`card-canvas.ts`), never through a
    node's data. What floats over the canvas is the workspace, the details (what a version changed, comments, code)
    and the execution's panel.
  - An operator's name is `operatorName` (`operator-name.ts`). What a card says of its settings is `summary.ts`, whose
    `valueText` is the one way a value is written, as in what a version changed; rows are `formatRows`
    (`lib/format.ts`). How much a card says, and whether its chips show, are each viewer's choices
    (`use-card-density.ts`, `use-chips-shown.ts`).
  - A path of a dataset's or a model's version, or of a file in one, is read and written by `lib/resource-path.ts`, as
    the server reads it (`FileResolver.scala`), never split by hand; the versions an operator reads are `resources.ts`.
  - Where the canvas draws what the workflow does not place (the chips around a card, the rows further apart for tall
    cards, the room an open card makes) is `canvas-geometry.ts`. Every place the canvas reports, as a drop, is one the
    workflow keeps (`keptPlaces`), never a drawn one.
  - What the canvas's own elements keep from it (keys, the clipboard, right and double clicks) is `ownEvents` for the
    open card and `chipEvents` for a chip, in `keys.ts`, beside `typing` and `undoing`, which every handler of keys in
    the editor asks.
  - Executing up to an operator is `useExecutionUpTo` (`features/execution/`), which the route gives the editor: the
    card's play button and the canvas menu's item ask it.
  - What a property is where its schema does not say (a dataset's file, a UDF's environment) is in the two
    tables of `property-schema.ts`, by the property's name. Add a row there, never a test of a name in a component.
  - An operator's problem keeps it from being executed (`validation.ts`); a warning, such as a column of an
    unexpected type, is shown under its field and keeps nothing from happening (`columnTypeWarnings`).
  - A document is only brought together with documents of its own lineage (`writeContent` in `document.ts`):
    nothing but the service fills a room, and a client whose room was filled anew starts with an empty document.
  - Which operator types hold code, and in which language, is the table in `code.ts`. CodeMirror is used only in
    `components/code/` (how code looks, the grammars, and a view of text to read, which datasets use too) and in
    `code-editor.tsx` (the editor, and two states of code side by side), and the language server's client only in
    `language-help.ts`.
  - The parameters a UDF's code declares are read from the code (`udf-parameters.ts`), by the person typing it, a
    moment after they stop (`use-udf-parameters.ts`): what someone else types is theirs to keep in step.
  - A workflow's versions are rebuilt from the backend's patches in `versions.ts`; never use the backend's own
    rebuilding of one version (`GET /version/{wid}/{vid}`), which is one save off. What changed between two states of
    a workflow is `diff.ts`, the one place that compares them; restoring one is `WorkflowDocument.restore()`.
  - What is copied from a canvas is a piece of a workflow in the content's own shape (`clipboard.ts`), on the system
    clipboard.
  - A Texera keyword of an operator's JSON schema (`autofill`, `hideTarget`, `toggleHidden`, `widget`) is read in
    `property-schema.ts` and nowhere else; the form draws what that file says.
  - The canvas library is React Flow, used only in `workflow-canvas.tsx` and the nodes it draws
    (`operator-node.tsx`, `comment-node.tsx`, `resource-chip-node.tsx`, `result-chip-node.tsx`). The canvas reports
    what is selected and where it was right-clicked; what can be done there is the editor's (`use-canvas-commands.ts`,
    `canvas-menu.tsx`). A menu item that cannot be chosen for a reason stays where the keyboard goes, and says why
    under its name.
- **A dataset's files** (`features/dataset/`): what kind a file is, and so how it is shown, is the table in
  `file-kinds.ts`, by its extension, since the storage server types every file the same. `preview.ts` reads what is
  shown: of text, only its start, with a range request, so a file of any size is shown at once; images, videos and
  sound stream from the file's link. A kind is added there and drawn in `file-preview.tsx`.
- **Executions** (`lib/execution/`, `features/execution/`): say "execution", "execute", never "run". An execution
  is created by the Dashboard service (`POST /api/executions`), which has the unit start it; the unit's socket
  follows it, and a pause, a resume or a kill names it. While the unit does not show the execution it follows, the
  client asks the service where it stands (`GET /api/executions/{eid}/state`). An execution up to an operator is
  sent the part of the workflow it needs, never a target, so every operator in it marked to keep its result keeps
  it. What the unit refuses is a notice beside the controls, never one of the execution's errors. The request that
  creates one and the messages of the socket are typed in `protocol.ts` from the Scala classes; a request holds
  exactly those fields.
- **A page of two features** is put together in its route, which gives each what it needs of the other through
  props, as `routes/_signed-in/workflows/$workflowId.tsx` does for editing and executing.
- **`lib/`** never imports React. Every backend call goes through `api()` in `lib/api-client.ts`.
- **Who may read what**: a query of what anyone may read, signed in or not (the hub, how people sign in, the
  public settings), has a key that starts with `publicKey` (`lib/session.ts`); everything else is the signed-in
  user's, and goes when the session changes. An area of the navigation that the settings switch off is left out of
  it (`app/navigation.ts`), and the administration's pages are not found for anyone but an administrator.
- **Code depends downward only**: `routes/` -> `features/` -> `components/` -> `lib/`. A feature never imports
  another feature, and a shared component never imports a feature or `app/`. The linter fails an import that goes
  the other way, a color value or a color of Tailwind's palette in a component, a raw length, and a comparison of
  an access level outside `can()`.
- **`styles/`** defines the colors, the corner radius and the fonts as tokens. Components use Tailwind utilities mapped
  to them, never color values, and take spacing and widths from Tailwind's spacing scale, never a raw length.
- **`src/routeTree.gen.ts`** is written by the router plugin when `yarn dev`, `yarn test` or `yarn build` runs, so
  after adding a route, run one of them before `yarn typecheck`. Commit it; never edit it.
- **Dependencies** have exact versions, with no `^` or `~` (re-pin what `yarn shadcn add` adds), and a license the
  ASF allows in a release, such as MIT, BSD, ISC or Apache-2.0.

## Tests First

Write the failing test, see it fail, then write the code. Each test covers valid input, invalid input and edge
cases, including bad server answers (4xx, 5xx, malformed bodies).

- A test sits beside its code. In `src/testing/render.tsx`, `renderApp(url, { session })` opens the whole app and
  `renderWithProviders(ui, { session })` renders one component, signed in when given a session (`sessionFor(user)`).
  A test that renders nothing signs in with `signInAs(user)` from `src/testing/session.ts`.
- The fake backend in `src/testing/mock-api/` follows the real API and resets before each test. A test changes an
  answer with `server.use(...)`, and a request with no handler fails the test. It has a stand-in engine
  (`engine.ts`) that computes a few operator types from tables in `db.files`, and the engine's socket. The shared
  editing service is not faked: its own code runs in the test (`shared-editing.ts`) and works with the fake
  backend, so compiling, executing and editing together are tested without Docker. Someone else in a workflow's
  room is a second `WorkflowRoom` that the test makes.
- jsdom cannot type into the code editor: a test tells CodeMirror what is typed (`EditorView.findFromDOM`), and
  typing with a keyboard is tested end to end.
- On the canvas, jsdom drags with `dragOnCanvas` (`src/testing/canvas.ts`). Test linking through `WorkflowDocument`,
  and open an operator's card with the keyboard, Enter on its group, as `$workflowId.test.tsx` does. jsdom lays
  nothing out: sizes, places and what is seen are checked in a story.
- Find elements by role and accessible name, as a user does, and name each test after a behavior.
- Vitest serves the app at `/`, not at `/alpha/`, so links in unit tests have no `/alpha` prefix.
- A story never calls the network: it puts its data in the query cache. A story whose data comes from the cache, or
  whose layout depends on the screen's width, checks it in a `play` function, as the share dialog's and the shell's
  stories do. A story imports nothing that only a test loads, such as Vitest, Testing Library's renderer or the fake
  backend.
- The canvas's stories draw `WorkflowCanvas` from literal data (`@/testing/workflow`), and the editor's open it on a
  document of their own that enters no room (`useLocalEditing` in `src/testing/editing.ts`). After each, they check
  that nothing reached the backend and that no text is under 12px (`src/testing/stories.ts`).
- An end-to-end test is one user task, written once against a page-object interface in `e2e/support/apps/` (such as
  `DatasetApp`), so it runs on both apps.

## Before Finishing

Run from `frontend-react/`, and fix everything they report:

```bash
yarn test && yarn typecheck && yarn lint && yarn format && yarn build
yarn build-storybook && yarn test:stories   # when a story or a component with a story changed
yarn test:e2e                               # with the backend of `yarn stack:up` running
```

Every new text file starts with the Apache license header; check them from the repository root with
`license-eye -c .licenserc.yaml header check`. Install it with
`go install github.com/apache/skywalking-eyes/cmd/license-eye@v0.8.0`, the version CI uses. `yarn format:fix` formats
the code.
