/**
 * POST /agents/conversations/:rid/ag-ui: the AG-UI 1.0 run endpoint of a conversation.
 * RunAgentInput in, SSE events out. `forwardedProps.template` switches the template for this
 * turn and the ones after.
 */
import type { RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import type { Context } from "hono";
import { AuthError, bearerToken } from "../auth/jwt.ts";
import { runTurn, type TurnDeps } from "../run/turn.ts";
import type { RuntimeDeps } from "./deps.ts";

export class BadRequest extends Error {
  readonly status = 400;
}

/** Validates the shape the runtime relies on; the rest of RunAgentInput passes through. */
export function parseRunInput(body: unknown): RunAgentInput {
  if (!body || typeof body !== "object") throw new BadRequest("body must be a RunAgentInput object");
  const b = body as Record<string, unknown>;
  if (typeof b.threadId !== "string" || !b.threadId) throw new BadRequest("threadId is required");
  if (typeof b.runId !== "string" || !b.runId) throw new BadRequest("runId is required");
  if (!Array.isArray(b.messages)) throw new BadRequest("messages must be an array");
  return b as unknown as RunAgentInput;
}

export function turnDeps(deps: RuntimeDeps): TurnDeps {
  return {
    catalog: deps.catalog,
    log: deps.log,
    build: deps.build,
    maxHandoffs: deps.config.maxHandoffs,
    newId: deps.newId,
  };
}

/** Streams a turn's events as SSE. */
export function streamTurn(c: Context, generator: AsyncGenerator<unknown>) {
  const encoder = new EventEncoder({ accept: c.req.header("accept") ?? undefined });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await generator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(encoder.encodeSSE(value as never)));
    },
    async cancel() {
      await generator.return(undefined);
    },
  });
  return c.body(stream, 200, {
    "content-type": encoder.getContentType(),
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

export function agUiHandler(deps: RuntimeDeps) {
  return async (c: Context) => {
    const rid = c.req.param("rid");
    if (!rid) throw new BadRequest("rid is required");
    const token = bearerToken(c.req.header("authorization"));
    if (!token) throw new AuthError("missing bearer token");
    const user = await deps.verifyUser(token);
    const input = parseRunInput(await c.req.json());
    let serviceToken: string | undefined;
    try {
      serviceToken = await deps.serviceTokens.get();
    } catch (err) {
      deps.log.warn("no service token; the catalog will not record the turn as the origin", {
        error: (err as Error).message,
      });
    }
    const forwarded = (input.forwardedProps ?? {}) as { template?: unknown };
    const template = typeof forwarded.template === "string" && forwarded.template ? forwarded.template : undefined;
    const generator = runTurn(turnDeps(deps), {
      conversationRid: rid,
      input,
      userToken: user.token,
      serviceToken,
      template,
      signal: c.req.raw.signal,
    });
    return streamTurn(c, generator);
  };
}
