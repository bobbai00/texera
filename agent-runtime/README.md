# Texera 2.0 agent runtime

The chat's host. It runs one turn of a conversation at a time, statelessly: the catalog holds
the conversation (its current agent template, its messages), the runtime takes the turn lock,
builds the agent of the template version, runs the ReAct loop on AI SDK 7 with the history
as context, streams AG-UI 1.0 events to the person who asked, keeps the assistant message in
the catalog close behind the stream (the others in the chat watch it there), and releases the
lock. Nothing survives a turn; scaling the runtime is running more copies.

An agent is a template version running one turn on the person's behalf: the template is the
definition (prompt, skills, MCP servers, model endpoint, handoffs, loop settings), the
conversation is the state, the turn is the loop. Agents act with the person's own token, so
the catalog applies the person's permissions to every tool call and records the turn as the
origin of everything it creates.

## The turn

1. `POST /agents/conversations/{rid}/ag-ui` with a `RunAgentInput`; only its newest user
   message is used, the history comes from the catalog. `forwardedProps.template` switches
   the conversation's template for this turn and the ones after.
2. A native command runs without a model: `/mode <name or uri>` switches the template.
3. The turn lock is taken (`409 turn_active` while another turn runs), the person's message
   is appended, and the runtime asks the catalog what the chat runs with (`GET
   /conversations/{rid}/settings`, as the person): the agent version, the model endpoint, the
   MCP servers and the computing unit, each the chat's choice or the default it falls back
   to. The runtime decides none of it. It builds that agent: the model from the endpoint with
   the key leased from the endpoint's credential; the skills; the servers, the platform's own
   (the catalog) with the person's token and the turn's origin, any other with its own
   headers, `credential:<uri>#<field>` values leased; the `handoff` tool when the agent lists
   handoffs. The catalog server holds the agent's basic tools and a turn fails without it;
   any other server is an add-on, left out of the turn and named to the agent when it cannot
   be reached. The agent is also told, at the end of every step's prompt
   (`src/agent/chat-context.ts`): the date, the chat's project, the computing unit an
   execution falls back to, what the person's app says they are looking at (the run input's
   AG-UI `context`, text only and bounded since a client writes it), and, in a chat several
   people write in, who they are and whom the turn answers. In such a chat each person's
   message reaches the model under its writer's name (`[Alice Liddell] ...`); one person's
   chat reads as it was written. Each answer records the agent version, the model endpoint
   and the servers mounted.
4. The loop streams: one model call per step, the step's tool calls run, until the model
   replies without a tool call, the step budget is spent, the run is aborted, or a handoff is
   called. The answer policy (`free` or `after_result`) decides whether a reply without a
   tool call is the answer. The prompt is laid out for Anthropic prompt caching.
5. A handoff sets the conversation's template, emits `texera.handoff`, and the target
   template finishes the same turn on the same stream (at most `TEXERA_AGENT_MAX_HANDOFFS`).
6. The assistant message is written to the catalog while it streams, at most every
   `TEXERA_AGENT_ANSWER_KEPT_EVERY_MS` and at the end of every step, one write at a time
   (`src/run/keeper.ts`), with the template version that wrote it: the catalog's event stream
   is how everyone else in the chat sees the answer arrive. A turn that fails before or
   outside the loop is recorded as an `error` part; the lock is released; `RUN_FINISHED` or
   `RUN_ERROR` ends the stream.

The platform ships one agent, the Texera Agent, which lists no handoffs: `/mode` and the
handoff tool are kept for agents that will.

## Run

```
cd agent-runtime
bun run dev          # http://localhost:3002, behind the gateway at /agents
bun test             # unit and HTTP tests, no network, no model
bun run typecheck
bun run lint
```

The dev stack (`bin/texera-2-0/`) routes `http://localhost:8088/agents/*` here after the
gateway has verified the person's Keycloak token. The runtime holds no model key: the
platform's model endpoint names a credential whose value `up.sh` loads into the secret store.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `TEXERA_AGENT_PORT` | `3002` | listen port |
| `TEXERA_PUBLIC_URL` | `http://localhost:8088` | the gateway; the platform's MCP server is `${TEXERA_PUBLIC_URL}/mcp/catalog` |
| `TEXERA_CATALOG_URL` | `http://localhost:8088` | base URL for catalog calls |
| `TEXERA_OIDC_ISSUER` | `http://localhost:8088/auth/realms/texera` | issuer user tokens must carry |
| `TEXERA_OIDC_AUDIENCE` | `texera` | audience user tokens must carry |
| `TEXERA_OIDC_JWKS_URL` | `${issuer}/protocol/openid-connect/certs` | key set |
| `TEXERA_OIDC_TOKEN_URL` | `${issuer}/protocol/openid-connect/token` | client-credentials endpoint |
| `TEXERA_SERVICE_CLIENT_ID` / `_SECRET` | `texera-services` / `texera-services-secret` | the runtime's own identity, which vouches for the turn's origin |
| `TEXERA_AGENT_MAX_STEPS` | `40` | model steps per turn, unless the template's `loop.maxSteps` says otherwise |
| `TEXERA_AGENT_ANSWER_POLICY` | `free` | `free` or `after_result`, for templates whose `loop` names none |
| `TEXERA_AGENT_MAX_HANDOFFS` | `2` | handoffs in one turn |
| `TEXERA_AGENT_ANSWER_KEPT_EVERY_MS` | `400` | how closely the catalog's copy of an answer follows it while it streams |
| `TEXERA_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Protocol surface

| Route | Protocol | Notes |
|---|---|---|
| `GET /healthz` | – | liveness |
| `POST /agents/conversations/{rid}/ag-ui` | AG-UI 1.0 | `RunAgentInput` in, SSE events out: `RUN_STARTED`, `STEP_*`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `CUSTOM` (`texera.resource` `{kind, rid, uri?, vno?}`; `texera.handoff` `{from?, to, name, by}`; `texera.correction` `{reason}`), `RUN_FINISHED` / `RUN_ERROR`. The thread is the conversation, the run is the turn. |
| `GET /agents/templates/{rid}/.well-known/agent-card.json` | A2A 1.0 | the card built from the template |
| `POST /agents/templates/{rid}/a2a` | A2A 1.0 JSON-RPC | `SendMessage` and `SendStreamingMessage` run a turn of the template; the A2A context is a conversation, and a message without one opens a new conversation for the caller |

## Layout

```
src/config.ts          environment → RuntimeConfig
src/auth/              user token verification (jose); the service token comes from @texera/service-auth
src/catalog/           the catalog client over the contract's routes (types from @texera/catalog-client)
src/agent/             build an agent for a turn: model endpoint + lease, skills, MCP mounts, handoff tool, system prompt
src/run/               the ReAct loop (react-loop.ts) and the turn: lock → history → loop → AG-UI events → the answer kept in the catalog (keeper.ts)
src/protocol/          AG-UI and A2A HTTP handlers
src/host/sandbox.ts    the sandbox seam for code-execution tools (unused yet)
src/server.ts          Hono app;  src/main.ts  Bun server
test/                  bun tests with a fake catalog, a scripted model and in-memory MCP servers
```

## Extension points

- **Tool approval**: AI SDK's `toolApproval` on the loop's `streamText` and AG-UI's
  `RUN_FINISHED` interrupt outcome are the seam for human-in-the-loop; not wired yet.
- **Agents as tools**: a template could call another template over A2A and continue with
  the answer; the A2A endpoint exists, the tool does not.
- **A router**: a host step that picks the template from the first message of a new
  conversation; today the person picks, or the default template applies.
- **Durable turns**: a turn lives in the request of the person who asked, and ends when they
  leave; the answer kept in the catalog is where a turn that outlives its request would
  continue from.
- **Sandbox**: `LocalSandbox` runs commands as child processes; nothing uses it yet.
