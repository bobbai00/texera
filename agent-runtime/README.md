# Texera 2.0 agent runtime

The chat's host. It runs one turn of a conversation at a time, statelessly: the catalog holds
the conversation (its current agent template, its messages), the runtime takes the turn lock,
builds the agent of the template version, runs the ReAct loop on AI SDK 7 with the history
as context, streams AG-UI 1.0 events to the app, persists the assistant message after every
step, and releases the lock. Nothing survives a turn; scaling the runtime is running more
copies.

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
   is appended, the template version is resolved, and the agent is built: the model from the
   template's model endpoint with the key leased from the endpoint's credential; the skills;
   the MCP servers (the catalog server for every template unless `catalogTools` is false,
   the platform's servers with the person's token and the turn's origin, any other server
   with its own headers, `credential:<uri>#<field>` values leased); the `handoff` tool when
   the template lists handoffs. The platform's servers are the agent's basic tools and a
   turn fails without them; any other server is an add-on, left out of the turn and named
   to the agent when it cannot be reached. The agent is also told the date and the chat's
   computing unit, at the end of every step's prompt (`src/agent/chat-context.ts`).
4. The loop streams: one model call per step, the step's tool calls run, until the model
   replies without a tool call, the step budget is spent, the run is aborted, or a handoff is
   called. The answer policy (`free` or `after_result`) decides whether a reply without a
   tool call is the answer. The prompt is laid out for Anthropic prompt caching.
5. A handoff sets the conversation's template, emits `texera.handoff`, and the target
   template finishes the same turn on the same stream (at most `TEXERA_AGENT_MAX_HANDOFFS`).
6. The assistant message is persisted after every step with the template version that wrote
   it; a turn that fails before or outside the loop is recorded as an `error` part; the lock
   is released; `RUN_FINISHED` or `RUN_ERROR` ends the stream.

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
| `TEXERA_PUBLIC_URL` | `http://localhost:8088` | the gateway; the platform's MCP servers are `${TEXERA_PUBLIC_URL}/mcp/{catalog,dataflow}` |
| `TEXERA_CATALOG_URL` | `http://localhost:8088` | base URL for catalog calls |
| `TEXERA_OIDC_ISSUER` | `http://localhost:8088/auth/realms/texera` | issuer user tokens must carry |
| `TEXERA_OIDC_AUDIENCE` | `texera` | audience user tokens must carry |
| `TEXERA_OIDC_JWKS_URL` | `${issuer}/protocol/openid-connect/certs` | key set |
| `TEXERA_OIDC_TOKEN_URL` | `${issuer}/protocol/openid-connect/token` | client-credentials endpoint |
| `TEXERA_SERVICE_CLIENT_ID` / `_SECRET` | `texera-services` / `texera-services-secret` | the runtime's own identity, which vouches for the turn's origin |
| `TEXERA_AGENT_MAX_STEPS` | `40` | model steps per turn, unless the template's `loop.maxSteps` says otherwise |
| `TEXERA_AGENT_ANSWER_POLICY` | `free` | `free` or `after_result`, for templates whose `loop` names none |
| `TEXERA_AGENT_MAX_HANDOFFS` | `2` | handoffs in one turn |
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
src/auth/              user token verification (jose), service token (client credentials)
src/catalog/           the catalog client over the contract's routes (types from @texera/catalog-client)
src/agent/             build an agent for a turn: model endpoint + lease, skills, MCP mounts, handoff tool, system prompt
src/run/               the ReAct loop (react-loop.ts) and the turn: lock → history → loop → AG-UI events → persisted messages
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
- **Durable turns**: the per-step persistence is where a checkpoint would go.
- **Sandbox**: `LocalSandbox` runs commands as child processes; nothing uses it yet.
