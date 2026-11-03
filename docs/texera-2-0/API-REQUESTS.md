# API requests across the Texera 2.0 teams

Things one part needs from another that the contract does not yet say. Each section is owned
by the part asking; the owner of the contract or the service answers in place.

## frontend

Conventions the app relies on, coded against the shapes below:

1. **AG-UI run input.** The app posts to `POST /agents/{pid}/ag-ui` an AG-UI `RunAgentInput`
   whose `messages` holds only the new user message (`{id, role: "user", content}`); the
   runtime loads the history from the catalog (`threadId` is the conversation rid).
   `forwardedProps` is `{ conversation: <rid>, attachments: ResourceRef[] }` where a ref is
   `{kind, rid, vno?}`; attached datasets are also named in the message text as
   `Attached dataset "<name>" (dataset:<rid>@<vno>)`.
2. **Resources in tool results.** The app renders a card for any of these shapes found in a
   tool result (nested up to four levels): an envelope `{kind, metadata: {rid}}`, a ref
   `{kind, rid, vno?}`, an execution `{eid, workflow: {...}}`. The runtime may also emit AG-UI
   `CUSTOM` events named `texera.resource` with a ref as the value.
3. **Persisted resource parts.** `MessagePart.type = "resource"` carries only a `VersionRef`;
   the app needs the kind. Proposed: the runtime sets `file: {kind}` on such parts, or the
   contract adds `kind` to `MessagePart`. Until then the app assumes `workflow`.
4. **Approvals.** A run that ends with `RUN_FINISHED{outcome: {type: "interrupt"}}` shows an
   approval part; resuming needs a documented resume shape (AG-UI `resume[]` in the next run
   input). Not wired yet.
5. **Dataset file references in operator properties.** The app writes
   `dataset://<rid>@<vno>/<path>` (and `dataset://<rid>@<vno>` for version pickers), matching
   the catalog's resolution to presigned URLs at run time.
6. **Engine WebSocket through the gateway.** The app connects to
   `/units/{unitRid}/wsapi/workflow-websocket?wid=<workflow rid>&cuid=<unit rid>&access_token=…`
   and expects the engine's existing frames (`WorkflowStateEvent`,
   `OperatorStatisticsUpdateEvent`, `WebResultUpdateEvent`, `WorkflowErrorEvent`,
   `ConsoleUpdateEvent`, `PaginatedResultEvent`); runs start through
   `POST /catalog/v1/workflows/{rid}/executions`, never through the socket.
7. **Conversation status.** The app reads the principal agent's pid from
   `Conversation.status.agent` after `agentsSpawn`; if absent it spawns one on open.
8. **Compile result port keys.** `CompileResult.operatorOutputSchemas[op]` keyed by
   `"<port>_false"` (the engine's serializer) or `"<port>"`; both are read.
