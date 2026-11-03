# Texera 2.0 agent runtime

Runs the agents that people chat with. Each agent is an AI SDK 7 `ToolLoopAgent` built
from a catalog agent template: model, system prompt, skills (SKILL.md, loaded on demand)
and the MCP servers the template binds, the built-in Texera "dataflow" server among them.
The runtime speaks AG-UI 1.0 to the app and A2A 1.0 to other agents; the catalog is the
source of truth for conversations, templates, skills and MCP servers.

## Run

```
cd agent-runtime
ANTHROPIC_API_KEY=... bun run dev        # http://localhost:3002, behind the gateway at /agents
bun test                                  # unit and HTTP tests, no network, no model
bun run typecheck
```

The dev stack (`bin/texera-2-0/`) routes `http://localhost:8088/agents/*` here after the
gateway has verified the person's Keycloak token.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `TEXERA_AGENT_PORT` | `3002` | listen port |
| `TEXERA_PUBLIC_URL` | `http://localhost:8088` | the gateway; the built-in MCP server is `${TEXERA_PUBLIC_URL}/mcp` |
| `TEXERA_CATALOG_URL` | `http://localhost:8088` | base URL for catalog calls |
| `TEXERA_OIDC_ISSUER` | `http://localhost:8088/auth/realms/texera` | issuer user tokens must carry |
| `TEXERA_OIDC_AUDIENCE` | `texera` | audience user tokens must carry |
| `TEXERA_OIDC_JWKS_URL` | `${issuer}/protocol/openid-connect/certs` | key set |
| `TEXERA_OIDC_TOKEN_URL` | `${issuer}/protocol/openid-connect/token` | client-credentials endpoint |
| `TEXERA_SERVICE_CLIENT_ID` / `_SECRET` | `texera-services` / `texera-services-secret` | the runtime's own identity |
| `TEXERA_LLM_PROVIDER` | `anthropic` | `anthropic` or `openai-compatible` (LiteLLM) |
| `TEXERA_LLM_BASE_URL` | – | required for `openai-compatible` |
| `TEXERA_LLM_API_KEY` | `ANTHROPIC_API_KEY` | provider key |
| `TEXERA_LLM_DEFAULT_MODEL` | `claude-haiku-5-5` | model when a template names none |
| `TEXERA_AGENT_MAX_STEPS` | `40` | model steps per turn |
| `TEXERA_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Protocol surface

| Route | Protocol | Notes |
|---|---|---|
| `GET /healthz` | – | live agent count |
| `POST /agents/{pid}/ag-ui` | AG-UI 1.0 | `RunAgentInput` in, SSE events out: `RUN_STARTED`, `STEP_*`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `CUSTOM` (`texera.resource` with `{kind, rid, vno}`), `RUN_FINISHED` / `RUN_ERROR`. Only the newest user message of the input is used; history comes from the catalog. |
| `GET /agents/{pid}/.well-known/agent-card.json` | A2A 1.0 | the card built from the template |
| `POST /agents/{pid}/a2a` | A2A 1.0 JSON-RPC | `SendMessage` and `SendStreamingMessage` run the same turn and answer with one agent message |

`pid` is the agent principal the catalog spawned (`GET /catalog/v1/agents/{pid}`); its
record names the template version and the conversation.

## Identity and delegation

Every request carries the person's bearer token, verified against the Keycloak JWKS. Calls
to the catalog forward that token in `Authorization` (the person's permissions apply) plus
`X-Texera-Agent: <pid>` and `X-Texera-Service-Token: <client-credentials token>` so the
catalog records the acting agent. The built-in MCP server is called with the person's token
as well, so the PDP decides every tool call.

## Layout

```
src/config.ts          environment → RuntimeConfig
src/auth/              user token verification (jose), service token (client credentials)
src/catalog/           typed catalog client (types from @texera/catalog-client)
src/agent/             model resolution, system prompt, skills, MCP mounting, agent builder
src/host/              AgentHost + Spawner (in-process), Sandbox (local)
src/run/               the turn: history → stream → AG-UI events → persisted messages
src/protocol/          AG-UI and A2A HTTP handlers
src/server.ts          Hono app;  src/main.ts  Bun server
test/                  bun tests with a fake catalog, a scripted model and in-memory MCP
```

## Extension points

- **Spawner**: `InProcessSpawner` runs agents in this process; a Kubernetes spawner that
  starts one process per agent on a sandbox node implements the same interface.
- **Sandbox**: `LocalSandbox` runs commands as child processes; nothing uses it yet. It is
  the seam for code-execution tools and for stdio MCP servers, which are refused today.
- **Tool approval**: `toolApproval` on the `ToolLoopAgent` and AG-UI's
  `RUN_FINISHED` interrupt outcome are the seam for human-in-the-loop; not wired yet.
- **A2A tasks**: the executor answers with one message per request; long-running tasks,
  artifacts and push notifications are not implemented.
- **Sub-agents**: the template's `subagents` policy is read but not acted on.
- **Model provider**: `TEXERA_LLM_PROVIDER=openai-compatible` points the same code at
  LiteLLM.

Known gap: `@texera/catalog-client`'s generated bootstrap imports a wrong relative path
(see `docs/texera-2-0/API-REQUESTS.md`), so this package imports only its types and uses a
small fetch layer over the contract's routes.
