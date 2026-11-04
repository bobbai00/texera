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
   rid). An attached dataset is named in the text as `Attached dataset "<name>" (<uri>)`.
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
   (`/mode`, typed or picked from the switcher). The app renders it as a divider; the runtime
   keeps system messages out of the model's history.
4. **Dataset file references in operator properties.** The app writes
   `texera://datasets/{rid}@{vno}/files/{path}` (and the version URI alone for version
   pickers), which the catalog resolves to presigned URLs when it builds the plan.
5. **Canvas positions.** The workflow spec is the engine's plan and holds no positions; the
   app lays the graph out (sources left, one column per hop) and keeps a person's moves in
   their preferences under `canvas[rid]`, so a layout is theirs and survives a reload.
6. **Compile result port keys.** `CompileResult.operatorOutputSchemas[op]` keyed by
   `"<port>_false"` (the engine's serializer) or `"<port>"`; both are read.
7. **Names.** Names are unique per project and kind (the catalog refuses a duplicate with
   409), so the app names a new chat by its agent and start time, and a second upload of the
   same file name gets its own dataset.

8. **Principals.** `search_principals` and the share form find people who have logged in
   and, through the Identity port's user search (Keycloak's admin API with the service
   client's `view-users` role), people in the directory who have not; the latter are recorded
   as principals when found, and their first login fills in the rest. Groups are catalog rows.

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
   credential URI, `texera://credentials/{rid}` or `...#field`; when a run starts the catalog
   leases the credential for that execution (the caller must be allowed to use it) and puts
   the secret where the URI was, in the plan the engine receives. Versions and executions
   keep the URI. A compile (`validate`) leaves the URI in place.
4. **A custom operator's properties.** The instance properties of a custom operator do not go
   to the engine as operator properties; they reach its Python code as the dict `PROPS`,
   with credentials substituted. Dataset file URIs inside `PROPS` are not resolved.
5. **A unit's identity and the lake.** A computing unit runs as an OAuth client of its own:
   minted by the catalog for a unit it provisions (`status.identity` names the client and its
   subject; the secret lives in the secret store and the unit's Kubernetes Secret), or the
   operator's client for a static unit (`spec.clientId`). A run's tables live in the namespace
   `e_<execution rid>`, which the catalog creates in the lake and opens for that identity
   before the engine starts (`ResultStore.namespace`); reads name it again. The lake
   authenticates every caller and authorizes with the catalog's grants, so a person reads
   results through the catalog only. Deleting an execution drops its namespace; deleting a
   provisioned unit deletes its client and credential.

## agent runtime

1. **Turn headers.** Every catalog call made during a turn carries the person's token and the
   origin headers (`X-Texera-Conversation`, `X-Texera-Turn`, `X-Texera-Template`) the catalog
   records as the origin of what the turn creates; the service token identifies the runtime.
2. **Built-in MCP servers.** A server resource with `spec.builtin` set (`catalog`, `dataflow`,
   `biomcp`) is reached with the person's token; any other server with the headers its spec
   lists, `credential:<uri>[#field]` values replaced by a lease taken for the turn.
