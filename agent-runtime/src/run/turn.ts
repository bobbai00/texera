/**
 * One turn: the newest user message goes to the catalog, the history comes back as
 * the model's context, the agent streams, AG-UI events go out, and the assistant
 * message with every part is persisted. The catalog is the source of truth; the
 * request's messages only supply the newest user message.
 */
import type { Message as AGUIMessage, RunAgentInput } from "@ag-ui/core";
import type { CatalogClient } from "../catalog/client.ts";
import type { CatalogAuth } from "../catalog/types.ts";
import type { AgentInstance } from "../host/spawner.ts";
import type { Logger } from "../log.ts";
import { type AGUIEvent, events, StreamMapper } from "./ag-ui-events.ts";
import { assistantParts, toModelMessages } from "./messages.ts";

export interface TurnDeps {
  catalog: CatalogClient;
  log: Logger;
  newId?: () => string;
}

export interface TurnRequest {
  instance: AgentInstance;
  conversationRid: string;
  input: RunAgentInput;
  auth: CatalogAuth;
  signal?: AbortSignal;
}

/** Text of the newest user message in a run input, or undefined when there is none. */
export function newestUserText(messages: AGUIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((p) =>
          p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
            ? (p as { text: string }).text
            : "",
        )
        .filter(Boolean)
        .join("\n");
      return text || undefined;
    }
    return undefined;
  }
  return undefined;
}

/** Runs a turn, yielding AG-UI events in order. Never throws; errors become RUN_ERROR. */
export async function* runTurn(deps: TurnDeps, req: TurnRequest): AsyncGenerator<AGUIEvent> {
  const { input, instance, auth, conversationRid } = req;
  const log = deps.log.child({ pid: instance.pid, conversation: conversationRid, runId: input.runId });
  yield events.runStarted(input.threadId, input.runId);

  const text = newestUserText(input.messages);
  if (!text) {
    yield events.runError("the run has no user message", "bad_request");
    return;
  }

  const mapper = new StreamMapper({ newId: deps.newId });
  let errored = false;
  try {
    const posted = await deps.catalog.postMessage(
      conversationRid,
      { role: "user", parts: [{ type: "text", text }] },
      auth,
    );
    // Everything the agent creates in this turn is attributed to it and originates here.
    instance.turn?.begin(auth.serviceToken, { conversation: conversationRid, seq: posted.seq });
    const history = await deps.catalog.listMessages(conversationRid, auth);
    const messages = toModelMessages(history);
    const result = await instance.built.agent.stream({ messages, abortSignal: req.signal });
    for await (const part of result.fullStream) {
      for (const event of mapper.map(part)) {
        if (event.type === "RUN_ERROR") errored = true;
        yield event;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("turn failed", { error: message });
    mapper.collected.error = mapper.collected.error ?? message;
    if (!errored) {
      errored = true;
      yield events.runError(message, "turn_failed");
    }
  }

  const parts = assistantParts(mapper.collected);
  if (parts.length > 0) {
    try {
      await deps.catalog.postMessage(conversationRid, { role: "assistant", parts }, auth);
    } catch (err) {
      log.error("could not persist assistant message", { error: (err as Error).message });
    }
  }
  if (!errored) yield events.runFinished(input.threadId, input.runId, { type: "success" });
}
