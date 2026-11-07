/**
 * One turn of a conversation, run statelessly: take the conversation's turn lock, append the
 * person's message, ask the catalog what the chat runs with (its agent, model, servers and
 * unit), build that agent, run the loop with the history as context, stream AG-UI events to
 * the person who asked, keep the assistant message in the catalog close behind the stream (the
 * others in the chat watch it there), and release the lock. A handoff sets the conversation's
 * template and the target finishes the same turn on the same stream. The catalog is the only
 * state.
 *
 * A chat several people write in is a group chat: the model reads each person's message under
 * their name and is told whom it is answering.
 *
 * The host's native commands are handled here without a model: `/mode <name or uri>` switches
 * the conversation's template.
 */
import type { Message as AGUIMessage, RunAgentInput, RunFinishedOutcome } from "@ag-ui/core";
import type { ToolSet } from "ai";
import type { BuildInput, BuiltAgent } from "../agent/build.ts";
import type { ChatPeople } from "../agent/chat-context.ts";
import { HANDOFF_TOOL, handoffTarget } from "../agent/handoff.ts";
import { TurnContext } from "../agent/turn-context.ts";
import { Work, type WorkMode } from "../agent/work.ts";
import { type CatalogClient, CatalogError } from "../catalog/client.ts";
import { baseUri, type CatalogAuth, type Message, type MessagePart, type Turn } from "../catalog/types.ts";
import type { Logger } from "../log.ts";
import { type AGUIEvent, events, StreamMapper } from "./ag-ui-events.ts";
import { keeper } from "./keeper.ts";
import { assistantParts, toModelMessages } from "./messages.ts";

export interface TurnDeps {
  catalog: CatalogClient;
  log: Logger;
  build: (input: BuildInput) => Promise<BuiltAgent>;
  maxHandoffs: number;
  /** How closely the catalog's copy of an answer follows it while it streams. */
  answerKeptEveryMs: number;
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

/** A resource a person attached to a message: by URI, with the name they know it by. */
export interface Attachment {
  uri: string;
  name?: string;
}

/**
 * What the newest user message attaches: AG-UI binary content whose URL is a catalog URI. The file
 * itself is already a dataset version; only the reference travels.
 */
export function newestUserAttachments(messages: AGUIMessage[]): Attachment[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((p): Attachment[] => {
      const part = (p ?? {}) as { type?: unknown; url?: unknown; filename?: unknown };
      if (part.type !== "binary" || typeof part.url !== "string" || !part.url.startsWith("texera://")) return [];
      return [
        { uri: part.url, ...(typeof part.filename === "string" && part.filename ? { name: part.filename } : {}) },
      ];
    });
  }
  return [];
}

const MODE = /^\/mode\s+(.+)$/s;

/**
 * The people who wrote in a chat, by pid, when more than one did: the chat is then a group
 * chat. Someone whose name the catalog does not give is still someone.
 */
async function writersOf(
  history: Message[],
  name: (pid: string) => Promise<string>,
): Promise<Map<string, string> | undefined> {
  const pids = [...new Set(history.filter((m) => m.role === "user").map((m) => m.author))];
  if (pids.length < 2) return undefined;
  const names = await Promise.all(pids.map((pid) => name(pid).catch(() => "someone")));
  return new Map(pids.map((pid, i) => [pid, names[i] as string]));
}

/** A person's answer to a change that waited for their approval. */
export interface Decision {
  toolCallId: string;
  approved: boolean;
}

/**
 * The answer a run carries to the change its chat waits on, as AG-UI resume entries: the
 * interrupt is the change's tool call; `resolved` with `{approved: false}`, or `cancelled`, is a no.
 */
export function decisionOf(input: RunAgentInput): Decision | undefined {
  const entry = input.resume?.[0];
  if (!entry?.interruptId) return undefined;
  const payload = (entry.payload ?? {}) as { approved?: unknown };
  return { toolCallId: entry.interruptId, approved: entry.status === "resolved" && payload.approved !== false };
}

/** The change a chat waits on: the newest assistant message's approval part still pending. */
export function waitingApproval(history: Message[]): { message: Message; part: MessagePart } | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i] as Message;
    if (message.role !== "assistant") continue;
    const part = message.parts.find((p) => p.type === "approval" && p.state === "pending");
    return part ? { message, part } : undefined;
  }
  return undefined;
}

/** What a change that did not go ahead tells the model, by why. */
export const DECLINED = "Not done: the person declined this change.";
export const PASSED_OVER = "Not done: the person wrote instead of approving this change.";

/** Runs a change a person approved, with the tool the turn built for it. */
async function runApproved(tools: ToolSet, part: MessagePart, signal?: AbortSignal): Promise<unknown> {
  const run = part.toolName ? tools[part.toolName]?.execute : undefined;
  if (!run || !part.toolCallId)
    return { error: `Not done: ${part.toolName ?? "the tool"} is not available in this turn.` };
  try {
    return await run(part.args ?? {}, { toolCallId: part.toolCallId, messages: [], abortSignal: signal, context: {} });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Runs a turn, yielding AG-UI events in order. Never throws; errors become RUN_ERROR. */
export async function* runTurn(deps: TurnDeps, req: TurnRequest): AsyncGenerator<AGUIEvent> {
  const { input, conversationRid: rid } = req;
  const log = deps.log.child({ conversation: rid, runId: input.runId });
  const newId = deps.newId ?? (() => crypto.randomUUID());
  yield events.runStarted(input.threadId, input.runId);

  const decision = decisionOf(input);
  const text = decision ? undefined : newestUserText(input.messages);
  const attachments = decision ? [] : newestUserAttachments(input.messages);
  if (!decision && !text && attachments.length === 0) {
    yield events.runError("the run has no user message", "bad_request");
    return;
  }
  const plain: CatalogAuth = { userToken: req.userToken, serviceToken: req.serviceToken };

  const mode = MODE.exec((text ?? "").trim());
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
  // How the run ends for the person: done, or waiting for their approval of a change.
  let finished: RunFinishedOutcome = { type: "success" };
  // The agent version the turn is running, for the record of a failure.
  let current = turn.template;
  try {
    // A change the chat waits on is answered by a decision; a message instead passes it over,
    // and the model reads that it was not done.
    const waiting = waitingApproval(await deps.catalog.listMessages(rid, auth()));
    if (decision && waiting?.part.toolCallId !== decision.toolCallId) {
      errored = true;
      yield events.runError("no change waits for that approval in this chat", "bad_request");
      return;
    }
    let asker: string;
    if (decision) {
      asker = (await deps.catalog.getConversation(rid, auth())).status?.activeTurnBy ?? "";
    } else {
      const said: MessagePart[] = text ? [{ type: "text", text }] : [];
      const attached = attachments.map(
        (a): MessagePart => ({ type: "resource", resource: a.uri, ...(a.name ? { text: a.name } : {}) }),
      );
      if (waiting) {
        yield* settleApproval(deps, rid, waiting, { state: "declined", output: { error: PASSED_OVER } }, auth());
      }
      const asked = await deps.catalog.appendMessage(
        rid,
        { turn: turn.turn, role: "user", parts: [...said, ...attached] },
        auth(),
      );
      asker = asked.author;
    }
    for (let hop = 0; ; hop++) {
      // What this chat runs with, as the catalog resolves it for the person; after a handoff,
      // for the agent that took over.
      const settings = await deps.catalog.chatSettings(rid, auth());
      for (const passed of settings.skipped ?? []) {
        log.info("a setting was passed over", { setting: passed.setting, uri: passed.uri, reason: passed.reason });
      }
      const template = await deps.catalog.getTemplate(settings.agent.uri, auth());
      current = template.uri;
      context.setTemplate(template.uri);
      names.set(template.uri, template.name);
      const history = await deps.catalog.listMessages(rid, auth());
      const writers = await writersOf(history, (pid) => deps.catalog.principalName(pid, auth()));
      const people: ChatPeople | undefined = writers && {
        names: [...writers.values()].sort(),
        asking: writers.get(asker) ?? "someone",
      };
      // Work an approval answers was started in the turn that asked; it goes on from there.
      const mode: WorkMode = settings.workMode?.mode ?? "auto";
      const work = new Work(mode, { continued: hop === 0 && decision !== undefined });
      const built = await deps.build({
        settings,
        template,
        auth: auth(),
        turn: context,
        purpose: `texera://conversations/${rid}`,
        app: input.context,
        people,
        work,
      });
      let outcome: Awaited<ReturnType<BuiltAgent["run"]>["return"]> extends never
        ? never
        : import("./react-loop.ts").LoopOutcome;
      // The catalog's copy of the answer, kept close behind the stream.
      let kept: ReturnType<typeof keeper> | undefined;
      try {
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
        if (hop === 0 && decision && waiting) {
          const output = decision.approved
            ? await runApproved(built.tools, waiting.part, req.signal)
            : { error: DECLINED };
          yield* settleApproval(
            deps,
            rid,
            waiting,
            { state: decision.approved ? "approved" : "declined", decidedBy: asker || undefined, output },
            auth(),
          );
          history.splice(0, history.length, ...(await deps.catalog.listMessages(rid, auth())));
        }
        // The answer records what writes it: the agent's version, the model, the servers mounted.
        const assistant = await deps.catalog.appendMessage(
          rid,
          {
            turn: turn.turn,
            role: "assistant",
            template: template.uri,
            modelEndpoint: settings.modelEndpoint.uri,
            mcpServers: built.servers.map((server) => server.uri),
            parts: [],
          },
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
        const answer = keeper(persist, deps.answerKeptEveryMs);
        kept = answer;
        const loop = built.run({
          messages: toModelMessages(history, { current: template.uri, names, people: writers }),
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
            answer.soon();
          } else if (ev.type === "step") {
            log.info("step", {
              template: template.name,
              step: ev.step.index,
              tools: ev.step.toolCalls.map((c) => c.toolName),
              errors: ev.step.toolResults.filter((r) => r.isError).length,
              finish: ev.step.finishReason,
              usage: ev.step.usage,
            });
            await answer.now();
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
        if (outcome.reason === "awaiting_approval" && outcome.approval) {
          finished = {
            type: "interrupt",
            interrupts: [
              {
                id: outcome.approval.toolCallId,
                reason: "approval",
                toolCallId: outcome.approval.toolCallId,
                ...(outcome.approval.reason ? { message: outcome.approval.reason } : {}),
              },
            ],
          };
        }
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
        await answer.now();
      } finally {
        kept?.stop();
        await built.close();
      }
      if (outcome.reason !== "interrupted" || outcome.interrupt?.toolName !== HANDOFF_TOOL) break;
      const target = handoffTarget(outcome.interrupt.output);
      if (!target || hop >= deps.maxHandoffs) {
        log.warn("handoff not followed", { target, hop });
        break;
      }
      // The handoff is the chat's new choice of agent; the next hop runs what it resolves to.
      const next = await deps.catalog.getTemplate(target, auth());
      const conversation = await deps.catalog.getConversation(rid, auth());
      await deps.catalog.updateConversationSpec(rid, { ...conversation.spec, template: baseUri(next.uri) }, auth());
      log.info("handoff", { from: template.name, to: next.name });
      // The record of the handoff: a system note written by the template that handed off, naming the one that takes over.
      await deps.catalog.appendMessage(
        rid,
        {
          turn: turn.turn,
          role: "system",
          template: template.uri,
          parts: [
            { type: "resource", resource: next.uri },
            { type: "text", text: `${template.name} handed the chat to ${next.name}.` },
          ],
        },
        auth(),
      );
      yield events.handoff({ from: template.uri, to: next.uri, name: next.name, by: "agent" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("turn failed", { error: message });
    if (!errored) {
      errored = true;
      // The turn failed outside the loop (an agent that could not be built, say), where no
      // assistant message records it. Whoever opens the chat, now or later, reads why.
      try {
        await deps.catalog.appendMessage(
          rid,
          { turn: turn.turn, role: "assistant", template: current, parts: [{ type: "error", text: message }] },
          auth(),
        );
      } catch (recordErr) {
        log.error("could not record the failure", { error: (recordErr as Error).message });
      }
      yield events.runError(message, "turn_failed");
    }
  } finally {
    try {
      await deps.catalog.endTurn(rid, turn.turn, plain);
    } catch (err) {
      log.error("could not end the turn", { error: (err as Error).message });
    }
  }
  if (!errored) yield events.runFinished(input.threadId, input.runId, finished);
}

/**
 * Records what became of a change that waited for approval, in the message that asked for it:
 * the decision on its approval part, then the call's result, and announces both.
 */
async function* settleApproval(
  deps: TurnDeps,
  rid: string,
  waiting: { message: Message; part: MessagePart },
  settled: { state: "approved" | "declined"; decidedBy?: string; output: unknown },
  auth: CatalogAuth,
): AsyncGenerator<AGUIEvent> {
  const { part } = waiting;
  const toolCallId = part.toolCallId as string;
  const toolName = part.toolName as string;
  const mapper = new StreamMapper({ newId: deps.newId });
  const results =
    settled.state === "approved"
      ? mapper.map({ type: "tool-result", toolCallId, toolName, input: part.args, output: settled.output } as never)
      : mapper.map({
          type: "tool-error",
          toolCallId,
          toolName,
          input: part.args,
          error: (settled.output as { error: string }).error,
        } as never);
  const parts = waiting.message.parts.map((p) =>
    p === part ? { ...p, state: settled.state, ...(settled.decidedBy ? { decidedBy: settled.decidedBy } : {}) } : p,
  );
  await deps.catalog.replaceMessage(rid, waiting.message.seq, { parts: [...parts, ...mapper.collected.parts] }, auth);
  yield events.approval({
    toolCallId,
    toolName,
    state: settled.state,
    ...(settled.decidedBy ? { decidedBy: settled.decidedBy } : {}),
  });
  yield* results;
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
    // A system note with no template: the person switched; the resource part names the new one.
    await deps.catalog.appendMessage(
      rid,
      {
        role: "system",
        parts: [
          { type: "resource", resource: template.uri },
          { type: "text", text: note },
        ],
      },
      auth,
    );
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
