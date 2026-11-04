/**
 * One turn of a conversation, run statelessly: take the conversation's turn lock, append the
 * person's message, build the agent of the conversation's template version, run the loop
 * with the history as context, stream AG-UI events, persist the assistant message after every
 * step, and release the lock. A handoff sets the conversation's template and the target
 * finishes the same turn on the same stream. The catalog is the only state.
 *
 * The host's native commands are handled here without a model: `/mode <name or uri>` switches
 * the conversation's template.
 */
import type { Message as AGUIMessage, RunAgentInput } from "@ag-ui/core";
import type { BuildInput, BuiltAgent } from "../agent/build.ts";
import { HANDOFF_TOOL, handoffTarget } from "../agent/handoff.ts";
import { TurnContext } from "../agent/turn-context.ts";
import { type CatalogClient, CatalogError } from "../catalog/client.ts";
import { baseUri, type CatalogAuth, type Conversation, type Turn } from "../catalog/types.ts";
import type { Logger } from "../log.ts";
import { type AGUIEvent, events, StreamMapper } from "./ag-ui-events.ts";
import { assistantParts, toModelMessages } from "./messages.ts";

export interface TurnDeps {
  catalog: CatalogClient;
  log: Logger;
  build: (input: BuildInput) => Promise<BuiltAgent>;
  maxHandoffs: number;
  newId?: () => string;
}

export interface TurnRequest {
  conversationRid: string;
  input: RunAgentInput;
  userToken: string;
  serviceToken?: string;
  /** Overrides the conversation's template for this turn and the ones after. */
  template?: string;
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

const MODE = /^\/mode\s+(.+)$/s;

/** Runs a turn, yielding AG-UI events in order. Never throws; errors become RUN_ERROR. */
export async function* runTurn(deps: TurnDeps, req: TurnRequest): AsyncGenerator<AGUIEvent> {
  const { input, conversationRid: rid } = req;
  const log = deps.log.child({ conversation: rid, runId: input.runId });
  const newId = deps.newId ?? (() => crypto.randomUUID());
  yield events.runStarted(input.threadId, input.runId);

  const text = newestUserText(input.messages);
  if (!text) {
    yield events.runError("the run has no user message", "bad_request");
    return;
  }
  const plain: CatalogAuth = { userToken: req.userToken, serviceToken: req.serviceToken };

  const mode = MODE.exec(text.trim());
  if (mode?.[1]) {
    yield* switchMode(deps, rid, mode[1].trim(), plain, newId, input);
    return;
  }

  let turn: Turn;
  try {
    turn = await deps.catalog.startTurn(rid, req.template, plain);
  } catch (err) {
    if (err instanceof CatalogError && err.status === 409) {
      yield events.runError("a turn is already running in this conversation", "turn_active");
      return;
    }
    yield events.runError(err instanceof Error ? err.message : String(err), "turn_failed");
    return;
  }
  const context = new TurnContext(req.serviceToken, { conversation: rid, turn: turn.turn, template: turn.template });
  const auth = (): CatalogAuth => ({
    userToken: req.userToken,
    serviceToken: req.serviceToken,
    origin: context.current,
  });
  const names = new Map<string, string>();
  let errored = false;
  let conversation: Conversation | undefined;
  try {
    await deps.catalog.appendMessage(rid, { turn: turn.turn, role: "user", parts: [{ type: "text", text }] }, auth());
    let current = turn.template;
    for (let hop = 0; ; hop++) {
      const template = await deps.catalog.getTemplate(current, auth());
      names.set(template.uri, template.name);
      const built = await deps.build({
        template,
        auth: auth(),
        turn: context,
        purpose: `texera://conversations/${rid}`,
      });
      let outcome: Awaited<ReturnType<BuiltAgent["run"]>["return"]> extends never
        ? never
        : import("./react-loop.ts").LoopOutcome;
      try {
        const history = await deps.catalog.listMessages(rid, auth());
        for (const m of history) {
          if (m.template && !names.has(m.template)) {
            names.set(
              m.template,
              await deps.catalog.getTemplate(m.template, auth()).then(
                (t) => t.name,
                () => "another agent",
              ),
            );
          }
        }
        const assistant = await deps.catalog.appendMessage(
          rid,
          { turn: turn.turn, role: "assistant", template: template.uri, parts: [] },
          auth(),
        );
        const mapper = new StreamMapper({ newId });
        const persist = async () => {
          try {
            await deps.catalog.replaceMessage(rid, assistant.seq, { parts: assistantParts(mapper.collected) }, auth());
          } catch (err) {
            log.error("could not persist the assistant message", { error: (err as Error).message });
          }
        };
        const loop = built.run({
          messages: toModelMessages(history, { current: template.uri, names }),
          abortSignal: req.signal,
        });
        let next = await loop.next();
        while (!next.done) {
          const ev = next.value;
          if (ev.type === "part") {
            for (const event of mapper.map(ev.part)) {
              if (event.type === "RUN_ERROR") errored = true;
              yield event;
            }
          } else if (ev.type === "step") {
            log.info("step", {
              template: template.name,
              step: ev.step.index,
              tools: ev.step.toolCalls.map((c) => c.toolName),
              errors: ev.step.toolResults.filter((r) => r.isError).length,
              finish: ev.step.finishReason,
              usage: ev.step.usage,
            });
            await persist();
          } else {
            log.info("reply sent back", { reason: ev.reason });
            yield events.correction(ev.reason);
          }
          next = await loop.next();
        }
        outcome = next.value;
        log.info("loop finished", {
          template: template.name,
          reason: outcome.reason,
          steps: outcome.state.steps.length,
          usage: outcome.usage,
        });
        if (outcome.reason === "step_limit" || outcome.reason === "refused") {
          const message =
            outcome.reason === "step_limit"
              ? `the turn ended at its step limit (${outcome.state.maxSteps} model steps) without an answer`
              : "the model provider refused the request";
          mapper.collected.error = mapper.collected.error ?? message;
          if (!errored) {
            errored = true;
            yield events.runError(message, outcome.reason);
          }
        }
        await persist();
      } finally {
        await built.close();
      }
      if (outcome.reason !== "interrupted" || outcome.interrupt?.toolName !== HANDOFF_TOOL) break;
      const target = handoffTarget(outcome.interrupt.output);
      if (!target || hop >= deps.maxHandoffs) {
        log.warn("handoff not followed", { target, hop });
        break;
      }
      const next = await deps.catalog.getTemplate(target, auth());
      conversation = conversation ?? (await deps.catalog.getConversation(rid, auth()));
      await deps.catalog.updateConversationSpec(rid, { ...conversation.spec, template: baseUri(next.uri) }, auth());
      log.info("handoff", { from: template.name, to: next.name });
      yield events.handoff({ from: template.uri, to: next.uri, name: next.name, by: "agent" });
      context.setTemplate(next.uri);
      current = next.uri;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("turn failed", { error: message });
    if (!errored) {
      errored = true;
      yield events.runError(message, "turn_failed");
    }
  } finally {
    try {
      await deps.catalog.endTurn(rid, turn.turn, plain);
    } catch (err) {
      log.error("could not end the turn", { error: (err as Error).message });
    }
  }
  if (!errored) yield events.runFinished(input.threadId, input.runId, { type: "success" });
}

/** `/mode <name or uri>`: the host switches the conversation's template without a model call. */
async function* switchMode(
  deps: TurnDeps,
  rid: string,
  query: string,
  auth: CatalogAuth,
  newId: () => string,
  input: RunAgentInput,
): AsyncGenerator<AGUIEvent> {
  try {
    let uri: string | undefined;
    if (query.startsWith("texera://")) {
      uri = baseUri(query);
    } else {
      const found = await deps.catalog.searchTemplates(query, auth);
      const exact = found.find((t) => t.metadata.name.toLowerCase() === query.toLowerCase()) ?? found[0];
      uri = exact ? String(exact.metadata.uri) : undefined;
    }
    if (!uri) {
      yield events.runError(`no agent template named ${JSON.stringify(query)}`, "not_found");
      return;
    }
    const template = await deps.catalog.getTemplate(uri, auth);
    const conversation = await deps.catalog.getConversation(rid, auth);
    await deps.catalog.updateConversationSpec(rid, { ...conversation.spec, template: baseUri(template.uri) }, auth);
    const note = `Switched to ${template.name}.`;
    await deps.catalog.appendMessage(rid, { role: "system", parts: [{ type: "text", text: note }] }, auth);
    yield events.handoff({ to: template.uri, name: template.name, by: "person" });
    const id = newId();
    yield events.textStart(id);
    yield events.textContent(id, note);
    yield events.textEnd(id);
    yield events.runFinished(input.threadId, input.runId, { type: "success" });
  } catch (err) {
    yield events.runError(err instanceof Error ? err.message : String(err), "mode_failed");
  }
}
