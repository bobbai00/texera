# Texera frontend: why we propose moving to React

Nov 2, 2026 · @JB

Texera needs a modern frontend: a chat with the agent as a main surface, a workflow editor that stays fast on large workflows, quick builds, and a small dependency tree that is easy to keep patched. Angular, as Texera uses it, falls short on four counts. The chat and canvas libraries a modern AI interface needs are built for React. The build kit is slow and pinned. And the dependency tree is large and falls behind. We propose switching the frontend to React, with the mainstream library for each part. A prototype already runs on it against the real backend.

## 1. What we need from the frontend

Texera is becoming chat-first. A user asks a question; the agent finds data, builds a workflow, runs it and explains the result; the user keeps chatting or opens the workflow beside the conversation. That puts four requirements on the frontend:

1. A rich chat: streamed text and markdown, code, tables, charts, images and files in both directions, tool steps and reasoning.
2. A workflow canvas that opens a large workflow in about a second and drags within one frame.
3. Fast builds and dev loops for contributors, and light pages for users.
4. A dependency tree that is small, maintained and Apache Category A, so staying patched is routine.

## 2. Why Angular doesn't meet it

Angular's runtime is not the problem: in public benchmarks it is as fast as React (2.3). The problem is everything around it: the libraries we can use, the canvas, the build kit, and how much we carry and keep current.

### 2.1 The modern UI libraries are built for React, and chat shows it most

Texera's agent chat is written from scratch: 5,356 lines of Angular components and services over a custom WebSocket protocol ([server.ts](https://github.com/apache/texera/blob/05c19a43e/agent-service/src/server.ts#L448)). Ant Design for Angular, our component library, has 71 components and none for chat ([ng-zorro-antd](https://ng.ant.design/components/overview/en)). So streaming, markdown, attachments, tool steps, stop and regenerate are all ours to build and maintain.

React has several mature, open-source chat libraries that do this out of the box, across media types:

| React library | License | What it covers | Downloads a week |
| --- | --- | --- | --- |
| [Ant Design X](https://x.ant.design/components/overview) | MIT | Message bubbles, input with attachments, file cards, thought chains, sources, code and Mermaid blocks | 104 k |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT | Attachments, image and audio messages, markdown and code, speech input, tool calls, reasoning, sources | 2.9 M |
| [CopilotKit](https://github.com/CopilotKit/CopilotKit) | MIT | Chat panels, attachments, audio transcription, tool rendering | 664 k |
| [AI SDK](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot#attachments) `useChat` with [streamdown](https://github.com/vercel/streamdown) | Apache-2.0 | One message stream with file, reasoning, source and tool parts; markdown that renders while it streams, with math, diagrams and code highlighting | 13.1 M and 10.5 M |
| [AI Elements](https://elements.ai-sdk.dev/overview), moving into [shadcn/ui](https://ui.shadcn.com/docs/ai-elements) | Apache-2.0 | 50 components, including attachments, images, audio, speech input, reasoning, tool steps and sources | copied into projects |

The Angular options are recent, pre-1.0 or commercial:

- [ng-zorro-x](https://ng.ant.design/x/), from the NG-ZORRO team, runs on Angular 21. It is at 0.5, its source is not public yet, its package ships no license file, and it is downloaded 373 times a week.
- [CopilotKit for Angular](https://docs.copilotkit.ai/angular) (0.6) and Hashbrown already require Angular 22. [AI SDK for Angular](https://ai-sdk.dev/docs/getting-started/angular) provides state classes and no components. Nebular's chat has no markdown, streaming or tool steps, and Nebular gets only yearly version bumps.
- The mature Angular chat kits (Kendo UI, Syncfusion, DevExtreme) are commercial, which an Apache release cannot include ([ASF licensing](https://www.apache.org/legal/resolved.html)).

The gap is far wider than the framework's own. React is downloaded 29 times as often as Angular. Ant Design X is downloaded 279 times as often as its Angular port, and AI SDK's React hooks 401 times as often as its Angular package.

The same holds beyond chat. Ant Design's runtime theme tokens and dark mode exist only in its React version ([ant.design](https://ant.design/docs/react/customize-theme)). TanStack Query for Angular is still experimental. Our forms library, ngx-formly, is on 7.1, and its current release requires Angular 22.

### 2.2 The leading workflow canvas is React-only

Texera's canvas is JointJS 3.5.4, from March 2022. npm marks that package deprecated in favor of `@joint/core`; it still bundles jQuery and Backbone, and its MPL-2.0 license is Apache Category B ([npm](https://www.npmjs.com/package/jointjs)).

Upgrading to `@joint/core` 4 would work in Angular, but JointJS itself now says "React has first-class, native support; the others have integration guides and examples" ([JointJS](https://github.com/clientIO/joint)). Its [Angular guide](https://docs.jointjs.com/learn/integration/angular/) is written for its commercial edition.

React Flow is the most used node-graph library: MIT, 38.9 k GitHub stars, 19.6 M downloads a week, built for React and Svelte only ([xyflow](https://github.com/xyflow/xyflow)). It powers Apache Airflow 3, Kubeflow Pipelines, Langflow and Dify. The Angular-native libraries (Foblex Flow, ngx-vflow, ngx-graph, Rete's Angular plugin) are run by individuals or small teams, and together get 1/117 of React Flow's downloads. Vue and Svelte each have a widely used option; Angular does not.

Activepieces moved its flow builder from Angular to React in 2024 for this reason: "when building our own graph editor in Angular, we had to address issues like zooming, panning, and touchpad handling ourselves. In contrast, libraries like React Flow handle these challenges out of the box" ([Activepieces](https://www.activepieces.com/blog/we-moved-from-angular-to-react-part-1)).

What it costs today: with the CPU slowed 4 times, a 400-operator workflow takes 102 s to open and each drag move takes 191 ms. Most of the open time is how Texera feeds JointJS, one cell at a time, so batching would help in place. The drag cost is the 47 SVG elements drawn per operator. The prototype on React Flow opens the same workflow in 0.7 s and drags within one frame (A.1).

### 2.3 The build kit is slow and pinned

The cost is on the developer side; Angular's runtime is not slower.

- Deprecated builder. Texera builds with webpack through `@angular-builders/custom-webpack`. Angular has deprecated its webpack builders, and has printed a warning when they run since May 2026 ([angular.dev](https://angular.dev/tools/cli/build-system-migration), [angular-cli#33127](https://github.com/angular/angular-cli/pull/33127)). The code editor's packages need custom webpack rules, which keep us there. A production build takes 96 s and 10 GB of memory. Angular's newer esbuild builder, tried in place, still takes 25 s and 6 GB.
- No TypeScript 7. TypeScript 7 runs full builds 8 to 12 times faster ([Microsoft](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)). Angular's compiler hooks into TypeScript's JavaScript API, and "this deep integration cannot work with a Go-compiled version of TypeScript". Angular is rewriting its compiler in Rust, with an experimental version planned "later this year" and no stable date ([Angular blog](https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a)). React components are plain TypeScript and check on TypeScript 7 today.
- A closed toolchain. Angular uses Vite only as a dev server and does not expose its configuration: "Exposing vite configuration does not align with the Angular CLI design goals" ([angular-cli#26859](https://github.com/angular/angular-cli/issues/26859)). A React app uses Vite directly. 98% of Vite's users would use it again, against 26% for webpack ([State of JS 2025](https://2025.stateofjs.com/en-US/libraries/build-tools/)).
- On Texera's code, the prototype builds in 0.9 s against 96 s, shows the first dev page in 0.8 s against 16 s, and lints and formats in 0.23 s against 25 s. It is a twelfth of the code and has no code editor yet, so the dev loop compares better than the totals (A.4).

For users, the framework is not the bottleneck. In the latest js-framework-benchmark, Angular 22 scores 1.51 to 1.53 and React 19 scores 1.56 to 1.61 (lower is faster), and Angular's bundle is smaller ([results](https://krausest.github.io/js-framework-benchmark/2026/chrome156.html)). Users pay for the stack instead. Every page, sign-in included, downloads 4.2 MB of compressed JavaScript, 58% of it the code editor. Ant Design's CSS is 642 KB of the 679 KB each page loads. Each page holds 36 to 45 MB of JavaScript memory, and the editor leaks on every visit. Each of these could be fixed one by one in Angular. In the React stack proposed here, route splitting, headless components and a query cache are the defaults: the prototype's pages load 0.13 to 0.31 MB and hold 3 to 7 MB (A.2, A.3).

### 2.4 A large dependency tree that falls behind

The risk is not the framework's own code; it is how far behind we fall and how much we carry.

- Falling behind. Texera ran Angular 16 until April 20, 2026, 17 months after Angular stopped patching it on November 8, 2024 ([endoflife.date](https://endoflife.date/angular)). Two Angular advisories from that window, an XSRF token leak ([CVE-2025-66035](https://github.com/angular/angular/security/advisories/GHSA-58c5-g7wp-6w37)) and a stored XSS ([CVE-2025-66412](https://github.com/angular/angular/security/advisories/GHSA-v4hv-rgfq-gp49)), were never fixed for version 16. The catch-up to 21 took five pull requests in eight days ([#4403](https://github.com/apache/texera/pull/4403) to [#4534](https://github.com/apache/texera/pull/4534)). The hard part is less the code than moving every Angular-specific library in step: ngx-formly is still four majors behind. Angular 21 is supported until June 2027 ([angular.dev](https://angular.dev/reference/releases)).
- A large tree. The current lockfile resolves 1,719 packages; the prototype's resolves 419. Scanned against the OSV database on November 2, 2026, the current tree has 177 known advisories in 66 packages (5 critical, 100 high) and the prototype's has none. Most sit in build and dev tools, and many are fixed in releases we have not taken yet, so a fresh lockfile closes part of the gap. What lasts is four times fewer packages to watch.
- Deprecated and end-of-life parts: the `jointjs` package, ESLint 8 (end of life since October 2024, [eslint.org](https://eslint.org/version-support/)), `@ngneat/until-destroy` (last release August 2024), and 23 deprecated packages in all, against none. OWASP ranks supply-chain failures third in its 2025 Top 10 and advises to "remove unused dependencies" and to "monitor for libraries and components that are unmaintained" ([OWASP](https://top10.owasp.org/2025/A03_2025-Software_Supply_Chain_Failures)).

Framework CVEs are not a reason either way. Angular has had about ten client-side advisories in 2025 and 2026, partly because it ships its own sanitizer, HTTP client and i18n. React's advisories, including the CVSS 10 [CVE-2025-55182](https://react.dev/blog/2025/12/03/critical-security-vulnerability-in-react-server-components), are all in server components, which a browser-only app does not use. The 2025 npm supply-chain attacks hit both ecosystems, including Nx, which our build uses; Texera was pinned to a safe version.

## 3. The proposal: switch the framework to React

Switch the frontend to React 19 and take the mainstream library for each part. All are MIT or Apache-2.0 (Category A). The engine's WebSocket protocol, the REST endpoints, the workflow format and Plotly stay as they are.

| Part | Today | Proposed | License | Reason |
| --- | --- | --- | --- | --- |
| Framework | Angular 21.2, zone.js, RxJS | React 19.3 with the React Compiler | MIT | 2.1 |
| Agent chat UI | Hand-built, 5,356 lines, custom WebSocket protocol | AI SDK 7 `useChat` and streamdown; components from AI Elements and shadcn/ui | Apache-2.0 | 2.1 |
| AI agent SDK | AI SDK 7 on the server; AI SDK 5 in the browser for two helpers | AI SDK 7 end to end, one protocol | Apache-2.0 | 2.1 |
| UI components and theme | ng-zorro-antd 21.3, Less variables and SCSS overrides | Base UI 1, Tailwind CSS 4 and our own design tokens | MIT | 2.1, 2.3 |
| Operator property forms | ngx-formly 7.1 with its ng-zorro adapter | A schema-to-form renderer over Base UI; react-jsonschema-form as the off-the-shelf option | MIT, Apache-2.0 | 2.1 |
| Workflow canvas | `jointjs` 3.5.4 (deprecated, MPL-2.0) with dagre | React Flow 12 | MIT | 2.2 |
| Event stream and state | RxJS Subjects, 563 hand-written subscriptions, no cache | TanStack Query 5 for server data, Zustand 5 for editor state, the same engine events | MIT | 2.3 |
| Code editor | Monaco through @codingame 37.6, on every page | Monaco or CodeMirror 6, loaded on the UDF route only | MIT | 2.3 |
| Build kit | Angular CLI on custom webpack, TypeScript 5.9, ESLint 8, Nx, Yarn 4 | Vite 8, TypeScript 7, Biome 2, Bun 1.3, Vitest | MIT, Apache-2.0 | 2.3, 2.4 |

### 3.1 What the prototype shows

The prototype on branch `feat/frontend-next-poc` runs against the real backend: sign-in, chat with a real model (Claude Haiku 5.5 through the existing LiteLLM gateway), datasets, the workflow editor and runs, and run history. In two recorded demos, the agent turns uploaded CSV files into a dataset, a workflow and charts, and answers a biology question by finding a UniProt table, which the user attaches and the agent then analyzes. Either workflow opens beside the chat or as a full page.

- Chat: 922 lines against 5,356, on the same AI SDK message stream the agent service already produces.
- Canvas: a 400-operator workflow opens in 0.7 s against 102 s, and a drag move stays within one frame (A.1).
- Pages: 0.13 to 0.31 MB of compressed JavaScript against 4.2 MB, 56 KB of CSS against 679 KB, and 3 to 7 MB of memory against 36 to 45 MB, flat over repeated navigation (A.2, A.3).
- Build kit: 0.9 s production builds and 32 direct dependencies against 106 (A.4).

It covers the core flows, not every current feature. Shared editing with Yjs, the code editor and most operator-specific widgets are not built yet; the roadmap is in `frontend-next/ROADMAP.md`.

The screenshots below were taken with the scripted test model on the same backend.

&#91;image: A chat that turned an uploaded CSV into a dataset and a workflow, with the workflow and its results open beside it\]

&#91;image: The prototype's workflow editor: React Flow canvas, operator list, property form and results\]

### 3.2 Why React, and not Vue or Svelte

Vue and Svelte each have a good canvas library, but the chat libraries in 2.1 are React-first, and so is the contributor pool: React is the most used framework in both large developer surveys ([State of JS 2025](https://2025.stateofjs.com/en-US/libraries/front-end-frameworks/), [Stack Overflow 2026](https://survey.stackoverflow.co/2026/technology/data)).

&#91;embedded content: State of JavaScript 2025 (13,002 responses) and Stack Overflow Developer Survey 2026 (10,281 answers to the web-framework question)\]

### 3.3 Keeping it that way

A new stack only helps if the new code follows different rules, enforced in review and CI:

1. One source of truth per resource: server data in the query cache, editor state in one store; views derive from them and never keep synced copies.
2. Libraries own subscriptions: no hand-written subscribe-and-clean-up pairs; effects only at the edges, each returning its own cleanup.
3. Load on demand: each route loads its own code; the code editor, charts and canvas load when used.
4. Render plain markup: headless components styled with tokens, long lists and large graphs virtualized, no overrides of a library's internals.
5. Measure every change: `frontend-bench` runs in CI against the budgets in A.5, and a change that breaks one fails.

## Appendix: measurements and sources

Unless noted, browser and build numbers come from one Apple M3 Max laptop, with both UIs against the same isolated Texera stack or the same mock backend, on `main` at 00395b8 (October 27, 2026). Versions and code counts were rechecked on `main` at 05c19a43e (November 2, 2026). npm downloads are for the week of October 26 to November 1, 2026, the latest week without the registry's zero-count days; they include CI installs, so they overstate use, but the ratios hold.

### A.1 Workflow canvas

The current editor's cost grows with workflow size because each operator and link is added to JointJS one at a time and drawn as 47 SVG elements. Texera's async-rendering setting, off by default, cuts the 400-operator open from 102 s to 13 s and leaves the drag unchanged. The proposed editor draws all nodes in one batched update from one store, so opening barely grows with size and a drag moves one node by a CSS transform.

&#91;embedded content: frontend-bench canvas scenario · 3 runs × 60 pointer moves per gesture · Chromium 156 on an M3 Max with 4× CPU throttling · mock backend\]

### A.2 Page loads

Every current page first downloads the same 4.2 MB of compressed JavaScript (15 MB unpacked), 58% of it the code editor. Proposed pages download 0.13 to 0.31 MB because code is split by route. The mock backend answers instantly, so a real server adds the same time to both.

&#91;embedded content: frontend-bench load scenario · 5 runs per page and profile · Chromium 156 on an M3 Max · Lighthouse desktop and mobile network profiles · mock backend\]

### A.3 Memory across pages

Memory was read from Chrome's counters after forced garbage collection on the isolated Texera stack, then over 15 rounds of in-app navigation between editor, dataset and list without reloads. Current pages hold 36 to 45 MB of JavaScript memory; proposed pages hold 3 to 7 MB. The current UI's leak is in the editor: each visit leaves about 900 DOM nodes and 21 listeners referenced after the page is gone. The dataset page does not leak, and the proposed UI's node and listener counts do not grow at all.

### A.4 Build kit

Each step ran 2 to 5 times on the same laptop; the chart shows medians. Angular's esbuild builder, tried in place, brings the production build from 96 s to 25 s and peak memory from 10 GB to 6 GB; the rest of the loop stays. The prototype is a twelfth of the code and has no code editor yet, which would grow its build and its editor page but not sign-in or the dev loop. Both UIs run unit tests on Vitest at about the same cost per test.

&#91;embedded content: toolchain timings · 2 to 5 runs per step · main at 00395b8 vs feat/frontend-next-poc · Node 24.15, Yarn 4.14, Bun 1.3.14\]

| Packages | Current (Yarn 4.14) | Proposed (Bun 1.3) |
| --- | --- | --- |
| Direct dependencies, runtime + development | 58 + 48 | 18 + 14 |
| Packages in the lockfile | 1,719 | 419 |
| Known advisories (OSV, November 2, 2026) | 177 in 66 packages | 0 |
| Size of `node_modules` | 1.0 GB | 0.37 GB |
| Bundled packages outside Apache Category A | 1 (JointJS, MPL-2.0) | 0 |

### A.5 CI budgets

| Budget, checked in CI | Limit | Prototype today |
| --- | --- | --- |
| Compressed JavaScript for sign-in | 150 KB | 134 KB |
| JavaScript memory per page after load | 10 MB | 3 to 7 MB |
| Memory growth over 10 editor visits | 0.2 MB and 0 DOM nodes per visit | 0.12 MB, 0 nodes |
| Open a 200-operator workflow, CPU slowed 4 times | 1 s | 0.65 s |
| Drag move at 200 operators, CPU slowed 4 times | One frame (17 ms) | 16.6 ms |
| Production build plus type-check | 10 s | 1.4 s |

### A.6 Method

- Code. Current: `frontend/src`, 314 TypeScript files and 68,285 lines excluding tests. Proposed: `frontend-next/src`, 70 files and 7,602 lines. Chat counts cover each UI's agent chat feature, tests excluded.
- Browser runs. The `frontend-bench` scripts drive Chromium through Playwright and read the browser's own performance timeline. A mock backend answers every API call with fixed data, using the real catalogue of 168 operators, with Texera's default `asyncRenderingEnabled: false`. Page loads ran 5 times per page and profile; canvas runs ran 3 times, with 60 pointer moves per drag or pan.
- Profiles. Chrome CPU profiles of a 400-operator open and a 60-move drag, on a production build of `main` with source maps, attributed to packages through the maps.
- Build tools. Each step ran 2 to 5 times; medians are reported. Peak memory is the whole process tree. Cold Angular builds start with `.angular/cache` deleted.
- In-place tests. In a separate worktree of `main`: the esbuild builder (`@angular/build:application`), zoneless change detection, and `asyncRenderingEnabled: true`, each against a baseline run in the same session.
- Advisories. Every package and version in `frontend/yarn.lock` and `frontend-next/bun.lock`, queried against the OSV database (`api.osv.dev/v1/querybatch`) on November 2, 2026, counting GitHub advisories by their severity.
- Upgrade history. `@angular/core` versions in `frontend/package.json` (formerly `core/gui`) over `main`'s history; end-of-support dates from endoflife.date and angular.dev.
- Rerun. `frontend-bench/run-baseline.sh` and `run-next.sh` give the browser numbers. The build-tool, profiling, in-place, memory and advisory scripts will move into `frontend-bench` before review.

## Sources

- Chat libraries: [ng-zorro-antd components](https://ng.ant.design/components/overview/en), [ng-zorro-x](https://ng.ant.design/x/), [Ant Design X](https://x.ant.design/components/overview), [assistant-ui](https://github.com/assistant-ui/assistant-ui), [CopilotKit](https://github.com/CopilotKit/CopilotKit) and [its Angular package](https://docs.copilotkit.ai/angular), [AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui/overview) and [for Angular](https://ai-sdk.dev/docs/getting-started/angular), [streamdown](https://github.com/vercel/streamdown), [AI Elements](https://elements.ai-sdk.dev/overview) and [in shadcn/ui](https://ui.shadcn.com/docs/ai-elements)
- Canvas: [jointjs on npm](https://www.npmjs.com/package/jointjs), [JointJS](https://github.com/clientIO/joint) and its [Angular guide](https://docs.jointjs.com/learn/integration/angular/), [xyflow](https://github.com/xyflow/xyflow), [Activepieces: moving from Angular to React](https://www.activepieces.com/blog/we-moved-from-angular-to-react-part-1)
- Build kit: [Angular build system migration](https://angular.dev/tools/cli/build-system-migration), [angular-cli#33127](https://github.com/angular/angular-cli/pull/33127), [angular-cli#26859](https://github.com/angular/angular-cli/issues/26859), [Angular's TypeScript 7 compiler update](https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a), [TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [Vite 8](https://vite.dev/blog/announcing-vite8), [js-framework-benchmark, Chrome 156](https://krausest.github.io/js-framework-benchmark/2026/chrome156.html)
- Surveys: State of JavaScript 2025, [front-end frameworks](https://2025.stateofjs.com/en-US/libraries/front-end-frameworks/) and [build tools](https://2025.stateofjs.com/en-US/libraries/build-tools/); [Stack Overflow Developer Survey 2026](https://survey.stackoverflow.co/2026/technology/data)
- Security and upkeep: [Angular releases](https://angular.dev/reference/releases), [endoflife.date: Angular](https://endoflife.date/angular), [CVE-2025-66035](https://github.com/angular/angular/security/advisories/GHSA-58c5-g7wp-6w37), [CVE-2025-66412](https://github.com/angular/angular/security/advisories/GHSA-v4hv-rgfq-gp49), [React server components advisory](https://react.dev/blog/2025/12/03/critical-security-vulnerability-in-react-server-components), [ESLint version support](https://eslint.org/version-support/), [OWASP Top 10 2025: A03](https://top10.owasp.org/2025/A03_2025-Software_Supply_Chain_Failures), [ASF third-party licensing](https://www.apache.org/legal/resolved.html)
- Downloads: npm, for the week of October 26 to November 1, 2026, for example [react](https://api.npmjs.org/downloads/point/2026-10-26:2026-11-01/react)
