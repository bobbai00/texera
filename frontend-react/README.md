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

# Texera React Frontend

An experimental implementation of Texera's frontend in React: every feature of today's frontend, built anew on a
clean organization rather than translated from the Angular app in `frontend/`. It talks to the same backend and is
served at `/alpha/` on the same site, so it shares the sign-in and runs beside that app while it grows.

Here so far:

- **Datasets** (list, files, versions, and what is in each file: a table of a CSV or Excel file's rows, text and code
  highlighted, JSON laid out, Markdown formatted, a page, an image, a PDF, a video or a sound; of a big file, its
  start), the lists of **workflows** and **models**, and sharing any of them, with people or with everyone through
  the hub.
- **The workflow editor**: the canvas, where each operator is a card whose settings are edited in the card itself,
  with chips around it of the datasets and models it reads and of the result it kept (see [The Canvas](#the-canvas));
  its menu, copying and pasting (through the system clipboard, so pieces move between workflows, tabs and apps),
  comments, an operator's code with the parameters it declares, editing together with other people, a workflow's
  settings, and the workflow as JSON or as Python. Panels float over the canvas, as in the Angular app: the workspace
  (operators, versions, executions, settings) on the left, the comments, the code and what a version changed on the
  right, and the execution at the bottom. Each is dragged by its header, resized by its edges, minimized, and docked
  again; the workspace's rail of views is put in another order by dragging its icons, or with Alt and an arrow key.
  The browser keeps all of it as the user left it.
- **A workflow's history**: each version with what its save changed, shown in place of the workflow with what
  changed marked on the canvas and listed beside it (code side by side), restored for everyone as one step to undo;
  and its executions, with their statistics and the version each executed.
- **Executing**: the controls, executing up to one operator (from its card or the canvas's menu), results, console
  and errors.
- **Computing units**, **environments**, **quota**, **sign-up**, the **hub** (public workflows, datasets and
  models, a public workflow to look inside, like and copy), and the administration's **users**, **executions**,
  **computing units** and **settings**. The navigation leaves out what the settings switch off.

A page that is not here yet (a model's own page, the administration's Gmail and curated images) opens in the
Angular app. The gateway
of the test backend serves the app from the output of `yarn build`, at http://127.0.0.1:18080/alpha/. The dev
server serves this app alone, so there its links to the Angular app lead nowhere.

## Layout

```
frontend-react/
├── .storybook/         # Storybook: the theme toolbar, and what every story has around it
├── e2e/                # end-to-end tests of user tasks, on this app and on the Angular app
│   ├── stack/          # the test backend: the services of bin/single-node, behind a gateway
│   └── support/        # fixtures, the API helper, and one page object per app
├── shared-editing-service/  # the service in whose rooms workflows are edited together; it runs on Node
└── src/
    ├── app/            # app-wide setup: router, query cache, session, navigation
    ├── routes/         # one file per URL
    ├── components/     # components that several features share
    │   ├── ui/         #   base components from shadcn/ui, kept as generated
    │   ├── layout/     #   the frame of the app and of a page: shell, page header, section
    │   ├── feedback/   #   how the app says what is going on: errors, empty states
    │   ├── resource/   #   what every kind of resource shares: list, page header, sharing, deleting, versions
    │   └── settings/   #   the deployment's public settings, which the navigation and the uploads follow
    ├── features/       # one folder per feature: its backend calls and its components
    │   ├── workflow/   #   the editor: canvas, cards, chips, menu, comments, code, history, who else is there
    │   ├── execution/  #   executing a workflow: unit, controls, results, console, errors, past executions
    │   ├── computing-unit/  # the user's computing units, and making one
    │   ├── hub/        #   what is public: the lists, a public workflow, likes and copies
    │   ├── admin/      #   users, executions, computing units and settings of the deployment
    │   └── auth/ dataset/ environment/ model/ quota/
    ├── lib/            # shared code without React: the API client, the session, the theme, the resource model
    │   ├── workflow/   #   a workflow as it is saved, its document and room for editing together, what compiles
    │   │               #   and what its cards say, and where the canvas draws them
    │   └── execution/  #   starting an execution and the engine's socket: their messages, and the client
    ├── styles/         # design tokens: colors, radius, fonts
    └── testing/        # test and story helpers, and the fake backend
```

## Quick Start

It needs Docker with Compose 2.24.4 or later, and Node 24 (24.15 or later, see `.nvmrc`). Yarn comes from corepack,
which Node 24 includes: run `corepack enable` once. Node 25 and later come without corepack, so install it first with
`npm install -g corepack`.

```bash
yarn install
yarn stack:up   # a small Texera backend in Docker, behind a gateway at http://127.0.0.1:18080
yarn dev        # the app at http://localhost:5173/alpha/
yarn shared-editing   # the shared editing service on port 1235: the workflow editor opens workflows through it
```

`VITE_DEVTOOLS=1 yarn dev` adds the router's and the query cache's devtools, whose buttons sit over the corners of
the app. `yarn build:shared-editing` builds the service into one file, `dist-shared-editing/main.js`, which Node runs
with nothing installed beside it; `shared-editing-service/Dockerfile` makes an image of it, and the test backend of
`yarn stack:up` runs it behind its gateway at `/shared-editing`.

Sign in as `texera` with the password `texera`. `yarn stack:down` stops the backend and deletes its data.

The dev server forwards `/api` and the engine's socket `/wsapi` to the gateway, since the backend sends no CORS
headers; `/shared-editing` to the shared editing service (`TEXERA_SHARED_EDITING` names another one); and
`/python-language-server` to the Pyright language service of `pyright-language-service/`, where one is running
(`TEXERA_LANGUAGE_SERVER`, by default port 3000). Without the language service, code is written without its help.
Executing a workflow needs a computing unit, which the test backend of `yarn stack:up` does not start.
Set `TEXERA_GATEWAY`, for the dev server and for the shared editing service alike, to use
another gateway, or `TEXERA_LOCAL_DEV=1` to use the services of a `bin/local-dev.sh` stack. `REACT_GATEWAY_PORT` and
`REACT_S3_PORT` move the test backend from ports 18080 and 19000; then point `TEXERA_GATEWAY` and `E2E_GATEWAY` at the
new gateway.

## The Canvas

Each operator on a workflow's canvas is a card: the picture of its type, its name, and its settings in one line under
it, or each setting on a line of its own once the viewer chooses "Show every setting on its card" in the editor's
menu. While or after an execution, a line under it says the operator's state and the rows it took and put out. Its
buttons execute the workflow up to it, keep its result after each execution (the eye), and open it. A card that
cannot be executed as it is says why, and one left out of executions is faded. The canvas is React Flow
(`src/features/workflow/components/workflow-canvas.tsx`).

An operator's settings are edited in its card, which opens in place with its pencil, a double click or Enter, and
closes with Done, Escape or a click on the empty canvas: one card open at a time, which holds the operator's name, its
settings and its code's button. A change is in the workflow as it is made, so closing saves nothing more. While a card
is open, the cards under it, in its column, are drawn lower to make room for it, and all the rows are drawn further
apart when the tallest card, with the most chips any card has, is taller than a row holds. That is the viewer's
drawing only (`src/lib/workflow/canvas-geometry.ts`): the workflow keeps its places as if every card were closed and
said its settings in one line, and a card that is moved is kept where it was dropped. A workflow laid out for the
Angular app's tiles, which stand closer, may need "Arrange the operators" for its cards to have their room.

Above a card stand chips of the versions of the datasets and models its operator reads, which its settings name by
their paths (`src/lib/resource-path.ts`, which reads them as the backend does, and `src/lib/workflow/resources.ts`).
A chip is drawn from its path alone, so everyone sees it; clicked, it says what the backend says of the resource, if
the viewer may read it, with a link to its page. Under a card stands the chip of the result its operator kept in the
execution shown, which shows the result in the execution's panel when it is clicked. "Show datasets, models and
results" in the menu hides the chips. The browser keeps both choices, for every canvas.

## Editing Together

A workflow is edited in its room on the shared editing service (`shared-editing-service/`, built on Hocuspocus, a
Yjs server). The service lets a person in if the backend lets them open the workflow, fills the room from the saved
workflow, passes each change on to the others, and saves, a moment after the last change and when the last person
leaves, in the name of whoever changed the workflow last. So no browser loads or saves a workflow, and someone who
may only view a workflow cannot change it, whatever their browser sends. The layout of the Yjs document is in
`src/lib/workflow/document.ts`, which the app and the service both use.

Each time the service fills a room from the saved workflow, the room starts a lineage. Two documents filled from
the same saved workflow are two histories to Yjs, and bringing them together would keep one or the other by chance,
so a document only ever goes back into the room it came from. The service keeps a room for five minutes after the
last person has left, so someone whose connection dropped comes back to the same room, with what they changed
while offline. Someone who comes back later than that, or after the service restarted, is told so: the workflow
opens again as it is saved, and what they changed while offline is not in it.

"Saved" in the toolbar means that the service has saved everything this browser holds: each save says how far it
reached, and a change made while it was under way waits for the next one. A room whose save failed is kept, and
saved again each time it has stayed its while, until it is saved, or until the backend refuses it for good, as for
a workflow that was deleted.

What each person sees of the others (who is there, what they have selected, their pointer, the card they are editing,
the code they have open and their cursor in it) is presence, kept by `src/lib/workflow/room.ts`, which also says how
the others see this person (`me`). Following someone is the editor's own doing: it selects what they select, and
opens and closes their code with them, never their card.

One person at a time edits an operator's settings. Whoever opens its card to change it tells the others, and of two
who open one card, whoever began first holds it until they close it or leave (`src/lib/workflow/holds.ts`, the one
answer to who holds what). The others see "Grace is editing" on its card, in her color, and until she is done they
open it only to read: its eye, the canvas's menu and the keys change, cut and delete nothing of it. They still move
it, link it and type in its code, which is shared text. A hold stops changing, never reading, and it coordinates
people in the app only: the service takes every change, and undo, redo and restoring a version do not look at holds.
Someone who may only view the workflow, or who looks at a version, holds nothing.

## A Workflow's History

The backend keeps a workflow as it is saved now, and for each save a JSON patch back to the save before it. The
app rebuilds every version from those patches (`src/lib/workflow/versions.ts`), rather than asking the backend for
one: the backend's own rebuilding gives the version before the one asked for. What a version changed is worked out
by comparing it with the one before it (`src/lib/workflow/diff.ts`): operators added, removed and changed property by
property, links, places, comments and settings. Looking at a version never touches the workflow: the canvas draws
the version, and everyone else goes on editing. Restoring one is an edit like any other, made in the room for
everyone, changing only what differs, and undone in one step.

## Tests

| Command             | What it runs                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `yarn test`         | Unit and component tests: Vitest on jsdom, with a fake backend (MSW) in `src/testing/mock-api/` |
| `yarn test:watch`   | The same, again on every change                                                                 |
| `yarn test:stories` | Every Storybook story, rendered as a test in Chrome                                             |
| `yarn test:e2e`     | A build, then the Playwright tests in `e2e/` against the `yarn stack:up` backend, in Chrome     |
| `yarn storybook`    | The component gallery, at http://localhost:6006                                                 |

The story and end-to-end tests use the installed Google Chrome. The end-to-end tests run each user task on this app
(the Playwright project `react`) and on the Angular app (`angular`), so the two are held to the same behavior;
`yarn test:e2e --project=react` runs one of them. `E2E_GATEWAY` points the tests at another gateway, and
`E2E_REACT_URL` at this app on a dev server, such as `http://localhost:5173/alpha/`.

The stories of the workflow canvas and of the editor draw them from literal data, the editor on a workflow of its own
that enters no room, and check in Chrome what jsdom cannot see: where cards and chips are drawn, what is seen, and
that no text is under 12px. Each checks that it asked the backend nothing, not even for a socket.

The tests in `e2e/workflow/`, `e2e/compute/` and `e2e/hub/` are of what only this app has: building a workflow, the
columns each operator is offered, executing, writing a Python UDF and its parameters, two people editing one
workflow, an execution watched from a second browser, the canvas's menu and comments, a workflow's history and
executions, computing units, and the hub. They need a backend with a running computing unit and the shared editing
service, so they run against a full Texera, with the app on a dev server:

```bash
TEXERA_GATEWAY=http://127.0.0.1:8080 yarn shared-editing
TEXERA_GATEWAY=http://127.0.0.1:8080 yarn dev
E2E_GATEWAY=http://127.0.0.1:8080 E2E_REACT_URL=http://localhost:5173/alpha/ yarn playwright test e2e/workflow e2e/compute e2e/hub --project=react
```

The Angular app under test is the build inside the Dashboard Service image, not the code in `frontend/`, and
`yarn stack:up` does not pull a newer image. To refresh it, run this from the repository root:
`docker compose -f bin/single-node/docker-compose.yml -f frontend-react/e2e/stack/compose.yml pull dashboard-service`.

`yarn typecheck`, `yarn lint` and `yarn format` check the code, and `yarn format:fix` formats it.

## Where New Code Goes

- **A page** is a file in `src/routes/`, named after its URL. It stays thin: it reads the URL, checks who may see
  it, loads the data, and renders a feature's component.
- **A feature** is a folder in `src/features/`: `api.ts` holds its backend calls and query options, and
  `components/` its UI.
- **A component that several features use** goes in `src/components/`. It takes what it shows through its props and
  fits the space it is given, so it also works in a narrow place, such as a side panel or a chat message.
  `src/components/ui/` holds the shadcn/ui components; add one with `yarn shadcn add <name>`, then pin the versions it
  adds to `package.json`, and add any color it uses to `tokens.css` and `globals.css`.
- **A kind of resource** (workflow, dataset, model, computing unit) is a `Resource` (`src/lib/resource.ts`), and
  `src/components/resource/api.ts` turns the backend's answers into that shape. Every list of resources, the user's
  or the hub's, is a `ResourceListPage`: one search box, one order, a list or cards (the user's choice, kept in their
  browser), and the same menu on each, read through `resourceListQuery`, whatever the kind. What one kind adds, such
  as where a computing unit stands, comes in through `itemDetails`. A resource's own page starts with a
  `ResourcePageHeader` and `ResourceActions`, and `kinds.tsx` says which of a kind's pages are in React. A button
  that acts on a resource asks `can(resource, action)` first. A person is drawn as a `UserAvatar`: their picture, or
  their initials.
- **A panel that floats over something**, such as the editor's over its canvas, is a `FloatingPanel` in a
  `FloatingArea` (`src/components/floating/`), with its state from `useFloatingPanel`. It is docked to an edge until
  the user moves it, and what is under it reads how much the docked panels cover with `useFloatingInsets()`, as the
  canvas does to fit the workflow into the free part. A choice the user's browser keeps for them, such as how they
  left a panel or a list's view, is `useStoredState`.
- **A property of an operator** gets its control from its schema (`src/lib/workflow/property-schema.ts`), which is
  the one place that reads Texera's schema keywords. A control that needs another feature, such as picking a file
  of a dataset, is that feature's component, which the page's route hands to the editor (`propertyControls`).
- **Code without React** goes in `src/lib/`.
- **A color, the corner radius or a font** is a token in `src/styles/tokens.css`, which components use through
  Tailwind utilities such as `bg-primary`. Spacing and widths come from Tailwind's spacing scale, such as `w-56` or
  `--spacing(72)`, never a raw length.
- **A test** sits beside the code it tests, as `*.test.ts(x)`, and a story beside its component, as `*.stories.tsx`.
  A fake endpoint goes in `src/testing/mock-api/`, and an end-to-end test of a user task in `e2e/`, one file per task.
