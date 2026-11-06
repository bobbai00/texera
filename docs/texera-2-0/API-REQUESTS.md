# Conventions between the Texera 2.0 parts

What one part relies on from another beyond what the contract (`api/catalog`) says. Each
section is owned by the part relying on it; when the contract grows to say it, the line
goes. Everything the first version of this file asked for (agent principals, `dataset://`
references, the engine WebSocket, a kind on resource parts) was settled by contract v2: names
are `texera://` URIs, runs are the catalog's, and a conversation runs a template, not an agent.

## frontend

1. **AG-UI run input.** The app posts to `POST /agents/conversations/{rid}/ag-ui` an AG-UI
   `RunAgentInput` whose `messages` holds only the new user message (`{id, role: "user",
   content}`); the runtime loads the history from the catalog (`threadId` is the conversation
   rid). An attachment travels by reference: AG-UI binary content `{type: "binary", mimeType:
   "application/vnd.texera.resource", url: "<the resource's URI>", filename}` beside the text.
   The runtime keeps it as a `resource` part of the person's message (its `text` the file
   name), and the model reads it as the line `Attached dataset "<name>" (<uri>)`.
   `forwardedProps.template` may name a template URI to run this turn and the ones after.
2. **Resources in tool results and events.** The app renders a card for any of these shapes
   found in a tool result (nested up to four levels): an envelope `{kind, metadata: {rid, uri,
   parent?}}`, a ref `{kind, rid, uri?, vno?}`, or a `texera://` URI string. The runtime also
   emits AG-UI `CUSTOM` events named `texera.resource` with a ref as the value, and
   `texera.handoff` with `{from?, to, name, by: "agent" | "person"}` when the conversation
   changes template.
3. **A change of hands in the history.** A system message whose parts hold a `resource` naming
   an agent template version records that the conversation changed template: written by the
   template that handed off (the message's `template` field) or, without one, by the person
   (`/mode`). The app renders it as a divider; the runtime keeps system messages out of the
   model's history. The app offers no way to change hands for now: every chat runs the
   deployment's one agent.
4. **Dataset file references in operator properties.** The app writes
   `texera://datasets/{rid}@{vno}/files/{path}` (and the version URI alone for version
   pickers), which the catalog resolves to presigned URLs when it builds the plan.
5. **Canvas positions.** The workflow spec is the engine's plan and holds no positions.
   Where operators sit is part of the document of the workflow's live session (item 10): one
   layout for everyone, laid out once by the live service (sources left, one column per hop),
   changed by whoever drags an operator, and kept with the document between sessions. A
   place is where an operator's card sits while cards say their settings in one line; how
   much the cards say is each viewer's own choice and is not in the document, so a canvas
   whose cards say more draws its rows further apart without moving anything. A version of a
   workflow records what runs, not how it is drawn, so an older version, and the workflow on
   an execution's page, is laid out afresh when it is shown.
6. **Compile result port keys.** `CompileResult.operatorOutputSchemas[op]` keyed by
   `"<port>_false"` (the engine's serializer) or `"<port>"`; both are read.
7. **Names.** Names are unique per project and kind (the catalog refuses a duplicate with
   409), so the app names a new chat by its agent and start time, and a second upload of the
   same file name gets its own dataset.

8. **Principals.** `search_principals` and the share form find people who have logged in
   and, through the Identity port's user search (Keycloak's admin API with the service
   client's `view-users` role), people in the directory who have not; the latter are recorded
   as principals when found, and their first login fills in the rest. Groups are catalog rows.
9. **What the person is looking at.** A message sent from the chat beside a resource's page
   carries AG-UI's `context` of the run: `{description: "The person is looking at", value:
   '<Kind> "<name>" (<the resource's URI, with @vno when a version is open>)'}` and, when the
   page adds something, `{description: "On that page", value: "the operator <id> is
   selected"}`. The runtime passes on text only, one line each, bounded. Nothing is stored
   with the chat; the app remembers the chat last used beside each page in the person's
   preferences under `dock[rid]` (the fifty most recent pages).
10. **A resource's live session.** `{gateway}/live/sessions` is a WebSocket speaking the
   Hocuspocus protocol (Yjs sync and awareness); the document's name is the resource's rid and
   the person's token goes in the protocol's first message. Whoever may read the resource
   joins. Everyone says who they are in their awareness state, `user: {pid, name}`: that is
   the presence shown on a page. A workflow's session also holds its document: maps
   `operators` (a map per operator id, with `operatorProperties` a map of its own), `links`
   (one value per link id), `settings` (the spec's other fields) and `places` (where each
   operator's card sits; `positions`, kept when operators were small icons, is dropped when
   the document is next saved); code that reads or writes it goes through
   `@texera/workflow-model/live`. Someone who may not write
   gets a read-only connection. The session's own awareness state holds how the document
   stands with the catalog, `catalog: {vno, refused?}`. `save:<id>` as a stateless message
   asks for a save now and is answered to the asker with `saved:<id>:<vno>` or
   `not-saved:<id>:<reason>`. A person who may no longer read is let go with the close reason
   `Forbidden`; the app then asks the catalog and shows its answer.
11. **A note.** A person's message of no turn (`POST /conversations/{rid}/messages` with
   `role: "user"` and no `turn`) asks the agent nothing: the chat marks it as a note, and the
   agent reads it, under its writer's name, the next time someone asks.

## catalog

1. **Usable by everyone.** `visibility: public` grants `viewer` to `user:*`; viewing never
   implies using. The system project additionally grants `user` to `user:*`, so the
   platform's unit, credentials and model endpoint are usable by everyone through `parent`.
   A person's own credential is usable by its owner and editors, or by whoever is granted
   `user` on it or on its project.
2. **A custom operator's output columns.** The engine's Python operator keeps the input
   columns and needs the ones the code adds declared up front: `implementation.python.
   outputColumns` on the operator's spec, which the catalog copies into the compiled plan.
3. **Credentials in properties.** A property whose schema has `format: credential` holds a
   credential URI, `texera://credentials/{rid}` or `...#field`; when an execution starts the catalog
   leases the credential for that execution (the caller must be allowed to use it) and puts
   the secret where the URI was, in the plan the engine receives. Versions and executions
   keep the URI. A compile (`validate`) leaves the URI in place.
4. **A custom operator's properties.** The instance properties of a custom operator do not go
   to the engine as operator properties; they reach its Python code as the dict `PROPS`,
   with credentials substituted. Dataset file URIs inside `PROPS` are not resolved.
5. **A unit's identity and the lake.** A computing unit runs as an OAuth client of its own:
   minted by the catalog for a unit it provisions (`status.identity` names the client and its
   subject; the secret lives in the secret store and the unit's Kubernetes Secret), or the
   operator's client for a static unit (`spec.clientId`). An execution's tables live in the namespace
   `e_<execution rid>` of its warehouse, which the catalog creates in the lake and opens for
   that identity before the engine starts (`ResultStore.warehouse`, the warehouse's name in
   the lake, and `ResultStore.namespace`); reads name both again. The lake
   authenticates every caller and authorizes with the catalog's grants, so a person reads
   results through the catalog only. Deleting an execution drops its namespace; deleting a
   provisioned unit deletes its client and credential.
6. **Retention.** `DELETE /workflows/{rid}/executions/{eid}` removes a finished execution with its
   tables (409 while it runs or while a dataset version derives from it; `can_delete`, so the
   runner and the owners above). The settings' `retention.results` (ISO 8601 duration) expires
   the result tables of older finished executions: the record keeps its summaries, gets
   `status.resultsExpiredAt`, and its rows, ports and saves answer 410 `expired`.
   `retention.blobs` (default a day) removes uploaded files that no version and no staging
   names. The catalog sweeps hourly; administrators run one with
   `POST /settings/retention/sweep`.
7. **Updating a unit.** `PUT /computing-units/{rid}` takes a new spec like any kind; a
   Kubernetes unit rolls its Deployment to it at once (image, memory, cpu), and the next
   status probes say pending until the new pod answers. The provider cannot change, and a
   unit with an execution on it (pending, provisioning or running) answers 409 until it is over.
   A static unit's identity follows its `clientId`.
8. **The unit's doors.** A unit's API answers the catalog's own client alone (start, cancel,
   compile, build, results, environments); people and agents reach a unit through the
   catalog, which authorizes and compiles first, and the gateway has no route to units. On the
   way back a unit reports as itself, with the client it was given for the lake, and
   `POST /lineage/v1/events` takes an execution's events from the unit that runs it alone: a
   unit's token is neither a person nor the service, and it may do nothing else.
9. **Running a workflow, in three phases.** `POST /workflows/{rid}/run` authorizes first
   (execute on the workflow, then, on the compiled plan, run on the unit, use on the warehouse, read on every
   dataset, operator and environment it names, use on every credential; a refusal leaves nothing behind), compiles
   once (`validate` returns the same plan as `plan`), and materializes: the execution is
   stored with `spec.plan` (URIs only, one table per output port named by the catalog, no
   secret, no URL) and `spec.warehouse`, its namespace is opened there, and a bound copy with presigned inputs and
   leased secrets goes to the engine. A custom operator's pinned environment is the
   execution's when the request names none, and a different one is refused with 409. Results
   live with the execution: there is no save-as-dataset; the label `texera.keep` on an
   execution keeps its results past the retention policy.
10. **The catalog names the output tables.** The plan holds one table per output port the
   engine writes (the ports of operators marked `viewResult` and of operators nothing reads,
   the engine's own rule), `<operator>_<port>` in lower case inside the execution's namespace; a
   port that only feeds another operator has no table. The start request carries
   them (`resultStore.tables`), the engine writes each external output port's result under
   its name and reports it as `namespace.table`, and `status.ports[]` lists the tables from
   the start, rows and snapshots filled in as the unit reports. A reported table the plan
   does not name is refused with 400. The engine owns the schemas and creates the tables;
   internal ports, state, console and statistics tables keep the engine's own keys inside
   the namespace. Rows are read by warehouse, namespace and table, so a unit that did not run
   the execution, or restarted since, serves them from the lake.
11. **Watching a resource.** `GET /resources/{rid}/events` streams server-sent events to
   whoever may read the resource, for as long as the connection stays open: `resource` with
   the envelope after each change (status included), `message` with a conversation's message
   as it is appended or rewritten, `deleted` when the resource goes, after which the stream
   ends. The stream opens with the messages after `after` and the resource as it stands, so a
   client that listed first misses nothing; a comment line every fifteen seconds keeps the
   connection alive, and the gateway puts no timeout on this route. Each change is re-read
   through the watcher's permissions, and the right to read is asked again with every
   keepalive, so a grant taken back, on the resource or on the project it lives in, ends the
   stream within fifteen seconds though nothing about the resource changed. The frontend uses
   it for the workflow, the execution and the chat (`useWatch`), and a watch that was open
   and is then refused makes the app ask the catalog again about the resource; the generated
   TypeScript client leaves this
   one route out (its query plugin cannot type a stream) and `packages/kinds/src/watch.ts`
   reads it by hand. The broker is in-process; replicas would carry the same changes over
   Postgres LISTEN/NOTIFY.
12. **A shared chat is a group chat.** Nothing is added to the model: a grant on the
   conversation is the membership (viewers read and watch, editors post and take turns),
   every message records its `author`, and the turn lock records whose it is
   (`status.activeTurn`, `status.activeTurnBy`), cleared together when the turn ends. The
   assistant message of a turn is the turn-taker's too. The chat page shows the others'
   messages under their names as they arrive and waits while someone else's turn runs. The
   runtime rewrites the assistant message while the answer streams, so the watch is also how
   the others see it arrive.
13. **Execution controls.** `POST /workflows/{rid}/executions/{eid}/pause` and `.../resume`
   take `execute` like cancel, 409 `not_running` or `not_paused` when the execution is not in
   the phase the verb needs, and forward to the unit, whose answer is not trusted: the phase
   turns `paused` (a phase of its own, live but not terminal, so the retention sweep leaves
   it) or back to `running` when the unit reports it through lineage. While an execution goes
   the unit also reports every operator's state and count about once a second (OpenLineage
   `RUNNING` events), which land in `status.operators`; progress that arrives after the
   terminal report is ignored. Both verbs are MCP tools.
14. **What others shared.** `GET /resources?shared=true` (and `search_resources` with
   `shared`) lists what the caller holds a grant of their own on and does not own, whatever
   its kind and project, with no scope applied. What lies inside a shared project is reached
   through the project and is not on the list; a grant to a group the caller is in is not
   expanded.
15. **The live service's routes.** `GET` and `PUT /resources/{rid}/live` hold the document of
   a workflow's live session between sessions (`{basedOn, state}`: the version it was last
   level with, and the Yjs bytes). `POST /workflows/{rid}/edit` takes `onBehalfOf`, the people
   whose edits a version holds: the first is recorded as its creator, all of them as its
   `contributors` when there is more than one. Both are a service's alone; a person, the
   owner included, is refused (403).
16. **An edit names the head it was made on.** `expectedHead` on an edit is refused with 409
   (`head is N, expected M`) when the head moved, before a patch is applied: a patch names
   operators by their place in the spec its writer read. A patch that names no head is
   applied to the head as it is and saved onto no other.
17. **An execution's warehouse.** A warehouse is a resource (`/warehouses`). Its
   `status.name` is its name in the lake, what an Iceberg client passes as `warehouse`: the
   configured one for the platform's built-in warehouse, `w_<rid without dashes>` for any
   other. An execution keeps its results in the warehouse the request names (`warehouse`),
   else the workflow's `defaultWarehouse`, the project's, the settings' `defaults.warehouse`;
   none at all is 409 `no_warehouse`, and one the caller may not `use` is 403. The engine is
   told the warehouse by that name with the namespace, at the start (`resultStore`) and on
   every read of rows (`warehouse` in the query); the lake's address is the unit's own
   configuration. Without `spec.storage` a warehouse is kept on the deployment's store under
   `w/<rid>`; with it, on the store it names, which must be the deployment's own or one of the
   settings' `warehouseEndpoints`, with the key its credential holds (`accessKeyId`,
   `secretAccessKey`), handed to the lake again when the secret is replaced. The lake tries a
   storage before it takes it: a refusal is 400 with `details.field: /storage` and the lake's
   reason, and nothing is made. Where a warehouse keeps its tables cannot change afterwards
   (400). `DELETE` answers 409 `in_use` while an execution that is neither deleted nor expired
   keeps results in the warehouse. After the last one goes, the lake clears the files of the
   dropped tables for some seconds and refuses to drop the warehouse meanwhile: the catalog
   waits for it, up to half a minute, and answers 409 `not_empty` with the lake's words if
   the lake still holds something then. An execution of a release that had one warehouse is
   given the platform's at the next start.

18. **A visualization's result.** A visualization operator puts out one row whose one column,
   `html-content`, holds the page it drew. A page of rows cuts any string longer than 100
   characters to its start and `...`, which keeps a table's page small; the cell of such a
   result is served whole, since cut it is no page. The app shows a result of that shape as
   the page itself, in a frame that can reach nothing of the app's.
19. **Rows while an execution goes.** A port's rows can be read while the execution still
   writes them; what a page holds then is what is there at that moment. The app reads the
   result on screen again as the port reports more rows, and reads it once when the
   execution is over.
20. **What a run keeps.** A result is a port the plan keeps a table for: the ports of the
   operators marked `viewResult` (the eye), of the operators nothing reads from, and of the
   operator a run went up to. The engine stores other ports for its own schedule; the catalog
   lists none of them in `status.ports`, and their rows are refused (`404`, "no result is kept
   for ..."), never asked of the unit.
21. **A run up to an operator.** `RunWorkflow.upTo` runs only that operator and what it reads
   from, directly or not; nothing reads from it there, so its result is kept. The workflow does
   not change; the execution records `spec.upTo`. An operator that is not in the version or is
   turned off is refused (`400`).
22. **Rows in and rows out.** An operator's status says the rows it has read (`rowsIn`, over
   all its input ports) and put out (`rowsOut`, over all its output ports) so far; the unit
   reports both with its state, about once a second. They replace `tuples`, which was the rows
   put out.

## catalog and its tools

1. **What a chat runs with.** A conversation stores choices only, each optional:
   `spec.template`, `modelEndpoint`, `computingUnit`, `mcpServers`. `GET
   /conversations/{rid}/settings` resolves them for the caller: the chat's choice, else its
   project's default (`defaultAgentTemplate`, `defaultModelEndpoint`, `defaultComputingUnit`,
   `mcpServers`), else the agent's own model and servers or the settings' defaults. Each
   setting says which level chose it (`from`: `chat`, `project`, `agent`, `platform`). The
   add-ons a chat lists replace the agent's and the project's; the platform's own server, the
   one whose URL is the catalog's MCP address, is `platform: true` and stays. A choice that
   names something gone, or not the caller's to use (no read; no `use` on a model endpoint's
   credential; no `run_on` on a unit), is passed over and listed in `skipped`. `POST
   …/turns` pins the agent version the settings resolve to. `GET
   /projects/{rid}/chat-settings` is the same for a chat not started yet.
2. **A call made in a chat.** The chat is the call's origin (`X-Texera-Origin`), which the
   catalog honors only with the runtime's service token. The catalog applies the chat's
   context itself, so no agent has to pass it. A compile or an execution takes its unit from
   the request, else the chat's preference when the caller may run on it, else the workflow,
   the project and the settings. A list that names no `scope`, `project`, `parent` or `origin`
   is scoped to the chat's project. A resource made with no `parent` goes into the chat's
   project when the caller may write there, else into their home project.
3. **Scope.** `scope=<project rid>` on a list (`GET /resources`, every kind's list, `GET
   /computing-units/available`) keeps what is in that project and in the platform's, whose
   built-ins every project inherits. Projects themselves are never narrowed, `project=` stays
   exact, and a scope that does not name a project is `400 invalid`.
4. **Built-ins.** A resource is built in when its project is the platform's
   (`Me.systemProject`: named "Built-in", public, `user` for everyone). Nothing on the
   resource marks it. A permission that changes one or adds to the project (write, share,
   delete, rotate, execute) answers `409 builtin` for everyone but the platform's own
   identity, an administrator included; reads go by the usual checks. At every start the seed
   makes the project what the release ships: a new version for what changed, and removal of
   what the platform made there and no longer ships; the settings' defaults move off a
   removed one, and a chat that named it falls back.
5. **Lists and checks.** A check is the authorizer's (`viewer from parent`, to any depth). A
   list is filtered in the store by the same rule for the three levels there are: public,
   owned or granted, on the resource, its parent or its project. Grants to a group are not
   expanded in lists.
6. **A unit's errors.** A unit answers an error in the contract's shape, `{code, message}`
   with a string code and the engine's own words. The catalog keeps the class and the words:
   a 400 or 422 of the unit is `400 invalid`, a 404 `404 not_found`, a 409 `409 conflict`,
   anything else `502 unit_error`; `502 unavailable` is left for a unit that did not answer.
   It reads the message from any JSON body that has one, whatever the code's type, so a unit
   of another version still says what went wrong. A tool call answers `<status>: <body>`
   with `isError`, so an agent reads the same words.
7. **A port before its table is written.** While an execution goes, reading the rows of an
   output port the plan names answers an empty page, not an error; once it is over, a missing
   table is `404`.
8. **An operator that raises.** A Python operator's exception fails the execution: the unit
   reports `failed` with the exception as the execution's error and as the operator's,
   instead of leaving the worker paused for an interactive console nobody attends.
9. **One MCP server.** Every `x-mcp` operation of the contract is a tool of `/mcp/catalog`.
10. **What an answer records.** An assistant message carries the agent version (`template`),
   the model endpoint (`modelEndpoint`) and the servers its turn mounted (`mcpServers`).

## agent runtime

1. **Turn headers.** Every catalog call made during a turn carries the person's token and the
   origin header (`X-Texera-Origin: conversation=…;turn=…;template=…`) the catalog records as
   the origin of what the turn creates, with `X-Texera-Service-Token` to vouch for it.
2. **What a turn mounts.** The runtime decides nothing: at the start of a turn, and after a
   handoff, it asks the catalog what the chat runs with (`GET /conversations/{rid}/settings`,
   as the person) and builds that agent version, model endpoint and list of servers. A server
   marked `platform` is the catalog's own: it is reached at the gateway, on the path of its
   URL, with the person's token and the turn headers, and a turn fails without it. Any other
   server is an add-on, reached at its own URL with the headers its spec lists,
   `credential:<uri>[#field]` values replaced by a lease taken for the turn; one that cannot
   be reached within ten seconds, or whose credential cannot be leased, is left out of the
   turn and named to the agent.
3. **What the agent is told about the chat.** Every step's prompt ends with the turn state
   and the chat's facts: today's date, the project the chat is in, the computing unit an
   execution falls back to (or that none is set), what the app says the person is looking at
   (frontend item 9), who is in a chat several people write in and whom the turn answers,
   and the add-ons left out. The instructions before it are the same text for every chat.
   In a chat with more than one writer, each person's message reaches the model with its
   writer's name in front, `[Alice Liddell] ...`; the catalog keeps the words as they were
   said.
4. **A turn that fails.** Whatever ends a turn in error is written to the conversation as an
   `error` part of an assistant message, so the reason outlives the stream.
5. **The answer in the catalog.** The assistant message of a turn is appended empty when the
   answer starts and rewritten as it streams, at most every 400 ms and at the end of each
   step, one write at a time. The person who asked reads the AG-UI stream; everyone else in
   the chat reads the catalog's event stream.
