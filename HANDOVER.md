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

# Texera 2.0 Working Branch: Handover

Branch `feat/texera-2-0`, on the fork `bobbai00/texera`. Handed over on November 25, 2026. Work on it is stopped
here: everything below is either in the branch or listed under What Is Left.

## What This Branch Is

1. Purpose: The working branch for Texera 2.0: a chat-centric Texera on one unified resource model, with the
   self-contained Amber engine. Each stage is meant to land on apache/texera later as small PRs under #9483, #9453
   and #5011.
2. Design of record: "Texera 2.0: Design And Plan" (https://claude.ai/artifact/PwbLuVQquDnKjfKcBk23xT, private to its
   author's account). Part 1 is the agent data model, Part 2 the services, Part 3 the Amber engine, Part 4 the
   interface; then the plan in six stages and ten open questions.
3. Base: the self-contained engine branch (local branch `claude/amber-engine-cleanup-review-8bf782`, tip
   `736a3fbfc`), not apache main. Apache main comes in only through the engine branch, which merges it. The engine
   branch's commits are on no remote but this branch.
4. Never merged: the Texera 2.0 prototype (branch `texera-2-0`, 549 conflicting paths). A stage copies the prototype's
   folders by path when it needs them, such as its contract in `api/`.

## Commits

| Commit | What it holds |
| --- | --- |
| `736a3fbfc` and before | The engine branch: one request creates an execution, the engine holds no metadata and checks no token, Envoy is the gateway in Docker and Kubernetes, and each execution gets a namespace and a catalog token |
| `a3b05cdb2` | The React app (`frontend-react/`, from `test/frontend-react-skeleton` at `4c7e75520`) merged |
| `1af562a04` | The React app starts and controls executions through the engine branch's API |
| `f9c98dc43` | The canvas: operator cards, editing in the card, holds, and lineage chips |
| This commit | Follow-ups from the review of the stories, the docs and the end-to-end page object, and this handover |

## Where The Plan Stands

1. Branch: Done. The React app's checks pass on the branch. The engine's end-to-end tests have not been run on a
   stack of the branch's own.
2. Contract and sign-in: Not started. It waits for open questions 1 (Scala or Go for the catalog), 4 (ids on the
   wire) and 6 (accounts into Keycloak).
3. Catalog: Not started.
4. Executions in the catalog: Not started.
5. Agent: Not started (the conversation, skill, MCP server and credential kinds, the Texera MCP Server, the Agent
   Service on them, OpenBao).
6. Chat-centric interface: The canvas part is built (`f9c98dc43`). The chat on every page, the home page as a chat,
   and the Lineage tab of each resource page are not.

## The Canvas

What Part 4 of the design asks of the canvas, built in `frontend-react/`:

1. Card: An operator is a card in the prototype's look: its picture, its name, its settings in one line (or every
   setting on a line of its own, as the viewer chooses), a status row such as "Completed 5,265 → 3 rows", and three
   buttons: the eye keeps its result, play executes the workflow up to it, the pencil opens it.
2. Editing in the card: The settings are edited inside the card, which grows wider and makes room below it while it
   is open. The floating Properties panel is gone, on the hub too.
3. Holds: A card someone else has open says "Grace is editing". Until she is done, it opens here only to read, and the
   menu and the keys leave it as it is. Its code stays shared text that everyone can type in.
4. Lineage chips: Above an operator are chips of the dataset and model versions it reads, each with a popover of what
   the backend says of it and a link to its page. Below it are chips of the results the execution on screen kept,
   which open in the Execution panel.

Where the code is:

| Concern | Files |
| --- | --- |
| The card and its buttons | `src/features/workflow/components/operator-node.tsx`, `card-canvas.ts`, `operator-name.ts`, `use-card-density.ts` |
| Editing in the card | `operator-node.tsx` (`OpenCard`), `operator-properties.tsx`, `workflow-editor.tsx` (`openCard`, `edit()`), `src/features/workflow/keys.ts` |
| Executing up to an operator | `src/features/execution/use-execution-up-to.ts` |
| Holds | `src/lib/workflow/holds.ts`, `src/lib/workflow/room.ts` (`Collaborator.editing`, `WorkflowRoom.edit`, `RoomState.me`) |
| Paths and what an operator reads | `src/lib/resource-path.ts` (mirrors `FileResolver.scala`), `src/lib/workflow/resources.ts` |
| Places of cards and chips | `src/lib/workflow/layout.ts`, `src/lib/workflow/canvas-geometry.ts` |
| Chips | `src/components/resource/resource-chip.tsx`, its lookup in `src/components/resource/api.ts`, `resource-chip-node.tsx`, `result-chip-node.tsx`, `use-chips-shown.ts` |
| Words | `src/lib/workflow/summary.ts` (settings in a line, `valueText`), `src/lib/format.ts` (`formatRows`) |
| Tests and stories | `workflow-canvas.test.tsx`, `src/routes/_signed-in/workflows/$workflowId.test.tsx`, `workflow-canvas.stories.tsx`, `workflow-editor.stories.tsx`, `src/testing/canvas.ts`, `editing.ts`, `stories.ts` |

Choices made while building, which the design leaves open and nobody has confirmed yet:

1. Size: A card is 248 pixels wide (296 open), and arranging puts columns 320 apart and rows 128 apart. A workflow laid
   out for the Angular app's 60-pixel tiles may need "Arrange the operators".
2. Opening: Enter on an operator selects it and opens its card; a double click and the pencil open it; Done, Escape
   and a click on the empty canvas close it. Opening a card, or adding an operator, stops following someone.
3. Panels: The floating details panel keeps "What changed", Comments and Code.
4. Holds: A hold stops changing, never reading. Holds coordinate people in the app only: undo, redo, restoring a
   version, arranging and pasting are not guarded, and the shared editing service does not check them.
5. Viewer choices: "Show every setting on its card" and "Show datasets, models and results" are kept in the browser.
6. Lookup: A chip's popover finds its dataset or model through the dashboard search, by owner and exact name, or the
   public search when signed out.
7. Two existing bugs were fixed on the way: the dataset picker dropped every path segment named "dataset", and a
   second execution could show the first one's result rows.

## How To Run And Check

From `frontend-react/`, with Node 24 and Yarn 4.14.1 through corepack:

```bash
corepack yarn
```

```bash
corepack yarn test && corepack yarn typecheck && corepack yarn lint && corepack yarn format && corepack yarn build
```

```bash
corepack yarn build-storybook && corepack yarn test:stories
```

```bash
corepack yarn storybook
```

At this commit, 1,078 unit tests and 29 story tests pass, and typecheck, lint, format, build and the Storybook
build are clean. Storybook shows the canvas without a backend: compact and detailed cards, status rows, an open
card, a held card, the chips and their popover, results, and the dark theme.

The dev server needs a backend: `TEXERA_GATEWAY` pointing at a gateway, or `TEXERA_LOCAL_DEV=1` with the services of
`bin/local-dev.sh`. The end-to-end tests have never run on this branch: their stack (`frontend-react/e2e/stack`,
behind nginx) still needs porting to the engine branch's Envoy compose.

The Scala code compiled at `736a3fbfc` with `sbt -batch "compile; Test/compile"`, given the `STORAGE_JDBC_*` and
`STORAGE_ICEBERG_CATALOG_*` settings of a Postgres that holds `sql/texera_ddl.sql` (`texera_db` and
`texera_iceberg_catalog`), and a Python 3.12 environment with amber's three requirement files on the `PATH`.

## What Is Left

1. Review of the stories, docs and end-to-end page object: Its one major finding is fixed. A fixer addressed most of
   its 16 minor findings in this commit (the docs' words, the end-to-end row checks, opening the canvas menu on an
   open card, the shared-execution chip check, the story checks, unused helper options), and stopped before it
   reported. Check each against the code.
2. Leftovers of the canvas: one `Size` type for `canvas-geometry.ts` and `components/floating/geometry.ts`;
   `operatorName` moved into `lib/workflow/`, so that the version list names an operator by its type's friendly name
   (`diff.ts`'s `nameOf` and `summaryOf`); pasting and duplicating one card-sized step away (`clipboard.ts` steps 40
   pixels); `patchOperator` deleting a key set to `undefined`; `file-preview.tsx` saying its rows with `formatRows`;
   one tested `chipReach` in `canvas-geometry.ts`; no chips on the minimap; "Selected by" names never under a
   resource chip; a `--presence-foreground` token in place of `text-white` in `presence.ts`; the contrast of the
   result chip's edge; comment lines over 120 columns in `workflow-canvas.tsx` and `workflow-editor.tsx`.
3. A final review of the whole canvas change, for bugs, the design, the rules and the tests, has not run.
4. End-to-end: Port `frontend-react/e2e/stack` to the engine branch's Envoy compose, then run
   `corepack yarn test:e2e`.
5. Left out by design until a later stage: the agent's operators arriving on the canvas as it adds them (#9464),
   "Read from" for rows reused from an earlier execution, the columns a model reads and adds (no such metadata before
   the catalog), and the size of text when the canvas is zoomed out.
6. Engine branch: Merge each of its new commits into this branch. While it has work in progress, leave its paths
   alone: `bin/single-node`, `bin/k8s`, `bin/local-dev`, `common/auth`, `common/config`, the storage code of
   `workflow-core`, `access-control-service` and `result-service`.
7. Stages 2 to 6 of the plan, and the design's open questions.
