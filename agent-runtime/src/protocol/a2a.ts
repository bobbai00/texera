/**
 * A thin A2A 1.0 surface per template: the agent card and a JSON-RPC endpoint whose
 * message/send and message/stream run the same turn as AG-UI. The A2A context is a
 * conversation; a message without one opens a new conversation for the caller.
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
import type { CatalogAuth, TemplateRecord } from "../catalog/types.ts";
import { runTurn } from "../run/turn.ts";
import { BadRequest, turnDeps } from "./ag-ui.ts";
import type { RuntimeDeps } from "./deps.ts";

/** Builds the agent card of a template. */
export function agentCardFor(template: TemplateRecord, publicUrl: string): AgentCard {
  const card = template.spec.card;
  return {
    name: card.name,
    description: card.description,
    supportedInterfaces: [
      {
        url: `${publicUrl.replace(/\/$/, "")}/agents/templates/${template.rid}/a2a`,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: "1.0",
      },
    ],
    provider: { organization: "Texera", url: publicUrl },
    version: String(template.vno),
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: (template.spec.skills ?? []).map((uri) => ({
      id: uri,
      name: uri,
      description: "",
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
export function executorFor(deps: RuntimeDeps, template: TemplateRecord, auth: CatalogAuth): AgentExecutor {
  return {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus) {
      const text = textOf(requestContext.userMessage);
      let conversationRid = requestContext.contextId;
      const templateUri = `texera://agent-templates/${template.rid}`;
      if (!conversationRid || !/^[0-9a-f-]{36}$/i.test(conversationRid)) {
        const created = await deps.catalog.createConversation(`A2A ${new Date().toISOString()}`, templateUri, auth);
        conversationRid = String(created.metadata.rid);
      }
      let reply = "";
      let error: string | undefined;
      const turn = runTurn(turnDeps(deps), {
        conversationRid,
        input: {
          threadId: conversationRid,
          runId: requestContext.taskId,
          messages: [{ id: requestContext.userMessage.messageId, role: "user", content: text }],
          tools: [],
          context: [],
          state: {},
        },
        userToken: auth.userToken,
        serviceToken: auth.serviceToken,
        template: templateUri,
      });
      for await (const event of turn) {
        if (event.type === "TEXT_MESSAGE_CONTENT") reply += (event as unknown as { delta: string }).delta;
        if (event.type === "RUN_ERROR") error = (event as unknown as { message: string }).message;
      }
      eventBus.publish({
        kind: "message",
        data: {
          messageId: crypto.randomUUID(),
          contextId: conversationRid,
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

async function resolveTemplate(deps: RuntimeDeps, c: Context) {
  const rid = c.req.param("rid");
  if (!rid) throw new BadRequest("rid is required");
  const token = bearerToken(c.req.header("authorization"));
  if (!token) throw new AuthError("missing bearer token");
  const user = await deps.verifyUser(token);
  const serviceToken = await deps.serviceTokens.get().catch(() => undefined);
  const auth: CatalogAuth = { userToken: user.token, serviceToken };
  const template = await deps.catalog.getTemplate(`texera://agent-templates/${rid}`, auth);
  return { template, auth, user };
}

export function agentCardHandler(deps: RuntimeDeps) {
  return async (c: Context) => {
    const { template } = await resolveTemplate(deps, c);
    return c.json(agentCardFor(template, deps.config.publicUrl));
  };
}

export function a2aHandler(deps: RuntimeDeps) {
  return async (c: Context) => {
    const { template, auth, user } = await resolveTemplate(deps, c);
    const card = agentCardFor(template, deps.config.publicUrl);
    const handler = new JsonRpcTransportHandler(
      new DefaultRequestHandler(card, new InMemoryTaskStore(), executorFor(deps, template, auth)),
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
