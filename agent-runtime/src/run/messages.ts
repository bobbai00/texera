/**
 * Conversions between the catalog's message model (the source of truth for history) and the
 * AI SDK's model messages, plus the parts of a finished assistant turn. An assistant message
 * another template wrote is rendered with that agent's name in front, so the model knows
 * which words were its own; in a chat several people write in, so is a person's message with
 * theirs. What a person attached reaches the model as a line that names it.
 */
import type { ModelMessage } from "ai";
import { type AttachedFile, type Message, type MessagePart, uriParts } from "../catalog/types.ts";
import type { CollectedTurn } from "./ag-ui-events.ts";

export interface HistoryOptions {
  /** The template version running now; its own messages are rendered as they were. */
  current?: string;
  /** Names of other templates, by version URI; an unknown one is "another agent". */
  names?: Map<string, string>;
  /**
   * The people of a chat several write in, by pid: each of their messages is rendered with its
   * writer's name in front. Absent in one person's chat, which reads as it was written.
   */
  people?: Map<string, string>;
}

/** Turns catalog history into model messages, keeping tool calls paired with results. */
export function toModelMessages(history: Message[], options: HistoryOptions = {}): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of history) {
    if (m.role === "system") {
      // System notes (a switch, a handoff) are the person's record; the model sees the change
      // through the labelled messages, and providers refuse system messages mid-conversation.
      continue;
    }
    if (m.role === "user") {
      const lines = m.parts.flatMap((p) => {
        if (p.type === "text" && p.text) return [p.text];
        if (p.type === "resource" && p.resource) return [attachedLine(p.resource, p.text)];
        return [];
      });
      const writer = options.people?.get(m.author);
      if (lines.length > 0) out.push({ role: m.role, content: (writer ? `[${writer}] ` : "") + lines.join("\n") });
      continue;
    }
    if (m.role === "assistant") {
      const other = m.template && options.current && m.template !== options.current;
      const label = other ? `[${options.names?.get(m.template as string) ?? "another agent"}] ` : "";
      out.push(...assistantSteps(m.parts, label));
      continue;
    }
    if (m.role === "tool") {
      const results = m.parts.filter((p) => p.type === "tool_result" && p.toolCallId && p.toolName);
      if (results.length > 0) {
        out.push({
          role: "tool",
          content: results.map((p) => ({
            type: "tool-result",
            toolCallId: p.toolCallId as string,
            toolName: p.toolName as string,
            output: { type: "json", value: toJsonValue(p.result) },
          })),
        });
      }
    }
  }
  return out;
}

/** The files people attached to a chat, oldest first, each under its own name: an upload of several names them all. */
export function attachedFiles(history: Message[]): AttachedFile[] {
  return history.flatMap((m) =>
    m.role !== "user"
      ? []
      : m.parts.flatMap((p) =>
          p.type === "resource" && p.resource && isAttachedFile(p.resource, p.text)
            ? (p.text as string).split(", ").map((name) => ({ name, uri: p.resource as string }))
            : [],
        ),
  );
}

/** A person's attachment as the model reads it: its kind, the name they gave it, its URI. A dataset attached is a file of the chat. */
function attachedLine(uri: string, name?: string): string {
  const parts = uriParts(uri);
  // An execution is named under its workflow.
  const kind = parts?.subresource?.startsWith("executions/")
    ? "execution"
    : (parts?.plural.replace(/s$/, "") ?? "resource");
  return `Attached ${isAttachedFile(uri, name) ? "file" : kind}${name ? ` ${JSON.stringify(name)}` : ""} (${uri})`;
}

/** Whether an attachment is a file of the chat: one version of a dataset, under the name it came with. */
function isAttachedFile(uri: string, name: string | undefined): boolean {
  const parts = uriParts(uri);
  return !!name && parts?.plural === "datasets" && parts.vno !== undefined && parts.subresource === undefined;
}

type AssistantContent =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };
type ToolResultContent = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "json"; value: never } | { type: "error-text"; value: string };
};

/**
 * Replays one recorded assistant turn as the steps it was: what the model said and called, then
 * the results of those calls, then what it said next. Flattening a turn into one assistant message
 * would show the model its final answer sitting before the tool results it was based on.
 */
function assistantSteps(parts: MessagePart[], label: string): ModelMessage[] {
  const out: ModelMessage[] = [];
  let said: AssistantContent[] = [];
  let results: ToolResultContent[] = [];
  let labeled = false;
  const flush = () => {
    if (said.length > 0) {
      const answered = new Set(results.map((r) => r.toolCallId));
      for (const c of said) {
        if (c.type === "tool-call" && !answered.has(c.toolCallId)) {
          results.push({
            type: "tool-result",
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            output: { type: "error-text", value: "the call did not complete" },
          });
        }
      }
      out.push({ role: "assistant", content: said });
    }
    if (results.length > 0) out.push({ role: "tool", content: results });
    said = [];
    results = [];
  };
  for (const p of parts) {
    const speaks = (p.type === "text" && !!p.text) || (p.type === "tool_call" && !!p.toolCallId && !!p.toolName);
    if (speaks && results.length > 0) flush();
    if (p.type === "text" && p.text) {
      said.push({ type: "text", text: label && !labeled ? label + p.text : p.text });
      labeled = true;
    }
    if (p.type === "tool_call" && p.toolCallId && p.toolName) {
      said.push({ type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, input: p.args ?? {} });
    }
    if (p.type === "tool_result" && p.toolCallId && p.toolName) {
      results.push({
        type: "tool-result",
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        output: { type: "json", value: toJsonValue(p.result) },
      });
    }
  }
  flush();
  return out;
}

function toJsonValue(v: unknown): never {
  // JSON round trip removes undefined and class instances the model API cannot carry.
  return JSON.parse(JSON.stringify(v ?? null)) as never;
}

/** Builds the parts of the assistant message that records a turn so far. */
export function assistantParts(turn: CollectedTurn): MessagePart[] {
  const parts = turn.parts.filter((p) => p.type !== "text" || (p.text ?? "").trim().length > 0);
  if (turn.error && !parts.some((p) => p.type === "error")) parts.push({ type: "error", text: turn.error });
  return parts;
}
