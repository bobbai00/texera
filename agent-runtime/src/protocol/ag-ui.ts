/**
 * POST /agents/:pid/ag-ui — the AG-UI 1.0 run endpoint: RunAgentInput in, SSE events out.
 */
import type { RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import type { Context } from "hono";
import { AuthError, bearerToken } from "../auth/jwt.ts";
import { runTurn } from "../run/turn.ts";
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

export function agUiHandler(deps: RuntimeDeps) {
  return async (c: Context) => {
    const pid = c.req.param("pid");
    if (!pid) throw new BadRequest("pid is required");
    const token = bearerToken(c.req.header("authorization"));
    if (!token) throw new AuthError("missing bearer token");
    const user = await deps.verifyUser(token);
    const input = parseRunInput(await c.req.json());

    let serviceToken: string | undefined;
    try {
      serviceToken = await deps.serviceTokens.get();
    } catch (err) {
      deps.log.warn("no service token; the catalog will not record the acting agent", {
        error: (err as Error).message,
      });
    }
    const auth = { userToken: user.token, agentPid: pid, serviceToken };
    const record = await deps.catalog.getAgent(pid, auth);
    const conversationRid = record.conversation ?? input.threadId;
    const instance = await deps.host.acquire(pid, record, auth);

    const encoder = new EventEncoder({ accept: c.req.header("accept") ?? undefined });
    const signal = c.req.raw.signal;
    const generator = runTurn(
      { catalog: deps.catalog, log: deps.log, newId: deps.newId },
      {
        instance,
        conversationRid,
        input,
        auth,
        signal,
      },
    );
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await generator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(encoder.encodeSSE(value)));
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
  };
}
