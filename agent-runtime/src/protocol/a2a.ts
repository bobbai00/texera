/**
 * A thin A2A 1.0 surface per agent: the agent card and a JSON-RPC endpoint whose
 * message/send and message/stream run the same turn as AG-UI. It is the seam for
 * agent-to-agent calls and the engine's agent operator; richer task semantics come later.
 */
import { type AgentCard, type Message, Role } from "@a2a-js/sdk";
import {
  type AgentExecutor,
  DefaultRequestHandler,
  type ExecutionEventBus,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  type RequestContext,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import type { Context } from "hono";
import { AuthError, bearerToken } from "../auth/jwt.ts";
import type { CatalogAuth } from "../catalog/types.ts";
import type { AgentInstance } from "../host/spawner.ts";
import { runTurn } from "../run/turn.ts";
import { BadRequest } from "./ag-ui.ts";
import type { RuntimeDeps } from "./deps.ts";

/** Builds the agent card for a live instance. */
export function agentCardFor(instance: AgentInstance, publicUrl: string): AgentCard {
  const card = instance.template.spec.card;
  return {
    name: card.name,
    description: card.description,
    supportedInterfaces: [
      {
        url: `${publicUrl.replace(/\/$/, "")}/agents/${instance.pid}/a2a`,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: "1.0",
      },
    ],
    provider: { organization: "Texera", url: publicUrl },
    version: String(instance.template.ref.vno),
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: (card.skills ?? []).map((s) => ({
      id: s.id,
      name: s.name ?? s.id,
      description: s.description ?? "",
      tags: [],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    })),
    signatures: [],
  };
}

function textOf(message: Message): string {
  return message.parts
    .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
    .filter(Boolean)
    .join("\n");
}

/** Runs a turn for an incoming A2A message and replies with one agent message. */
export function executorFor(
  deps: RuntimeDeps,
  instance: AgentInstance,
  conversationRid: string,
  auth: CatalogAuth,
): AgentExecutor {
  return {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus) {
      const text = textOf(requestContext.userMessage);
      let reply = "";
      let error: string | undefined;
      const turn = runTurn(
        { catalog: deps.catalog, log: deps.log, newId: deps.newId },
        {
          instance,
          conversationRid,
          auth,
          input: {
            threadId: conversationRid,
            runId: requestContext.taskId,
            messages: [{ id: requestContext.userMessage.messageId, role: "user", content: text }],
            tools: [],
            context: [],
            state: {},
          },
        },
      );
      for await (const event of turn) {
        if (event.type === "TEXT_MESSAGE_CONTENT") reply += (event as unknown as { delta: string }).delta;
        if (event.type === "RUN_ERROR") error = (event as unknown as { message: string }).message;
      }
      eventBus.publish({
        kind: "message",
        data: {
          messageId: crypto.randomUUID(),
          contextId: requestContext.contextId,
          taskId: requestContext.taskId,
          role: Role.ROLE_AGENT,
          parts: [
            {
              content: { $case: "text", value: error ? `error: ${error}` : reply },
              metadata: undefined,
              filename: "",
              mediaType: "text/plain",
            },
          ],
          metadata: error ? { error } : undefined,
          extensions: [],
          referenceTaskIds: [],
        },
      });
      eventBus.finished();
    },
    async cancelTask() {
      // Turns are short; cancellation arrives through the HTTP abort signal.
    },
  };
}

async function resolveInstance(deps: RuntimeDeps, c: Context) {
  const pid = c.req.param("pid");
  if (!pid) throw new BadRequest("pid is required");
  const token = bearerToken(c.req.header("authorization"));
  if (!token) throw new AuthError("missing bearer token");
  const user = await deps.verifyUser(token);
  const serviceToken = await deps.serviceTokens.get().catch(() => undefined);
  const auth: CatalogAuth = { userToken: user.token, agentPid: pid, serviceToken };
  const record = await deps.catalog.getAgent(pid, auth);
  const instance = await deps.host.acquire(pid, record, auth);
  return { instance, auth, user, conversationRid: record.conversation ?? pid };
}

export function agentCardHandler(deps: RuntimeDeps) {
  return async (c: Context) => {
    const { instance } = await resolveInstance(deps, c);
    return c.json(agentCardFor(instance, deps.config.publicUrl));
  };
}

export function a2aHandler(deps: RuntimeDeps) {
  return async (c: Context) => {
    const { instance, auth, user, conversationRid } = await resolveInstance(deps, c);
    const card = agentCardFor(instance, deps.config.publicUrl);
    const handler = new JsonRpcTransportHandler(
      new DefaultRequestHandler(card, new InMemoryTaskStore(), executorFor(deps, instance, conversationRid, auth)),
    );
    const context = new ServerCallContext({
      user: { isAuthenticated: true, userName: user.subject },
      requestedVersion: c.req.header("a2a-version") ?? "1.0",
    });
    const result = await handler.handle(await c.req.json(), context);
    if (Symbol.asyncIterator in (result as object)) {
      const iterator = result as AsyncGenerator<unknown>;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await iterator.next();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
        },
        async cancel() {
          await iterator.return(undefined);
        },
      });
      return c.body(stream, 200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    }
    return c.json(result as object);
  };
}
