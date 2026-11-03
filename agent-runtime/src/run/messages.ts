/**
 * Conversions between the catalog's message model (the source of truth for history)
 * and the AI SDK's model messages, plus the parts of a finished assistant turn.
 */
import type { ModelMessage } from "ai";
import type { Message, MessagePart } from "../catalog/types.ts";
import type { CollectedTurn } from "./ag-ui-events.ts";

/** Turns catalog history into model messages, keeping tool calls paired with results. */
export function toModelMessages(history: Message[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of history) {
    if (m.role === "user" || m.role === "system") {
      const text = m.parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text as string)
        .join("\n");
      if (text) out.push({ role: m.role, content: text });
      continue;
    }
    if (m.role === "assistant") {
      out.push(...assistantSteps(m.parts));
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
function assistantSteps(parts: MessagePart[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let said: AssistantContent[] = [];
  let results: ToolResultContent[] = [];
  const flush = () => {
    if (said.length > 0) {
      // A call whose result was never recorded (an interrupted turn) still needs one.
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
    if (speaks && results.length > 0) flush(); // the model went on after reading results: a new step
    if (p.type === "text" && p.text) said.push({ type: "text", text: p.text });
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

/** Builds the parts of the assistant message that records a finished turn. */
export function assistantParts(turn: CollectedTurn): MessagePart[] {
  // Stream order keeps the narrative: text, then the tool call it announced, its result, more text.
  const parts = turn.parts.filter((p) => p.type !== "text" || (p.text ?? "").trim().length > 0);
  if (turn.error && !parts.some((p) => p.type === "error")) parts.push({ type: "error", text: turn.error });
  return parts;
}
