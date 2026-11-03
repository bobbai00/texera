import { describe, expect, test } from "bun:test";
import type { Message, MessagePart } from "../src/catalog/types.ts";
import { assistantParts, toModelMessages } from "../src/run/messages.ts";

const base = { conversation: "c", author: "a", createdAt: "" };

describe("toModelMessages", () => {
  test("keeps text turns and pairs tool calls with their results", () => {
    const history: Message[] = [
      { ...base, seq: 1, role: "user", parts: [{ type: "text", text: "run it" }] },
      {
        ...base,
        seq: 2,
        role: "assistant",
        parts: [
          { type: "text", text: "Running." },
          { type: "tool_call", toolCallId: "c1", toolName: "run_workflow", args: { rid: "w" } },
          {
            type: "tool_result",
            toolCallId: "c1",
            toolName: "run_workflow",
            result: { eid: "e", status: "completed" },
          },
          { type: "resource", resource: { kind: "execution", rid: "e" } },
        ],
      },
    ];
    const messages = toModelMessages(history);
    expect(messages).toEqual([
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running." },
          { type: "tool-call", toolCallId: "c1", toolName: "run_workflow", input: { rid: "w" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "run_workflow",
            output: { type: "json", value: { eid: "e", status: "completed" } },
          },
        ],
      },
    ]);
  });

  test("replays a multi-step turn as its steps, so the answer follows the results it read", () => {
    const parts: MessagePart[] = [
      { type: "text", text: "Building it." },
      { type: "tool_call", toolCallId: "c1", toolName: "create_workflow", args: {} },
      { type: "tool_result", toolCallId: "c1", toolName: "create_workflow", result: { rid: "w" } },
      { type: "tool_call", toolCallId: "c2", toolName: "run_workflow", args: { rid: "w" } },
      { type: "tool_call", toolCallId: "c3", toolName: "list_operators", args: {} },
      { type: "tool_result", toolCallId: "c3", toolName: "list_operators", result: [] },
      { type: "tool_result", toolCallId: "c2", toolName: "run_workflow", result: { status: "completed" } },
      { type: "resource", resource: { kind: "execution", rid: "e" } },
      { type: "text", text: "The mean is 4.26." },
    ];
    const messages = toModelMessages([{ ...base, seq: 2, role: "assistant", parts }]);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "tool", "assistant"]);
    const calls = (i: number) =>
      ((messages[i]?.content ?? []) as Array<{ type: string; toolCallId?: string }>).map((c) => c.toolCallId ?? c.type);
    expect(calls(0)).toEqual(["text", "c1"]);
    expect(calls(1)).toEqual(["c1"]);
    expect(calls(2)).toEqual(["c2", "c3"]); // parallel calls stay one step
    expect(calls(3)).toEqual(["c3", "c2"]);
    expect(messages[4]).toEqual({ role: "assistant", content: [{ type: "text", text: "The mean is 4.26." }] });
  });

  test("gives a call that never got its result one, so the history stays valid", () => {
    const messages = toModelMessages([
      {
        ...base,
        seq: 2,
        role: "assistant",
        parts: [
          { type: "tool_call", toolCallId: "c1", toolName: "run_workflow", args: {} },
          { type: "error", text: "the turn was cancelled" },
        ],
      },
    ]);
    expect(messages).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "run_workflow", input: {} }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "run_workflow",
            output: { type: "error-text", value: "the call did not complete" },
          },
        ],
      },
    ]);
  });

  test("skips empty messages", () => {
    expect(toModelMessages([{ ...base, seq: 1, role: "assistant", parts: [{ type: "error", text: "x" }] }])).toEqual(
      [],
    );
  });
});

describe("assistantParts", () => {
  test("keeps stream order and typed resource refs, and records a late error", () => {
    const parts = assistantParts({
      parts: [
        { type: "text", text: "Looking it up." },
        { type: "tool_call", toolCallId: "c", toolName: "t", args: { a: 1 } },
        { type: "tool_result", toolCallId: "c", toolName: "t", result: { ok: true } },
        { type: "resource", resource: { kind: "workflow", rid: "w", vno: 3 } },
        { type: "text", text: "  " },
        { type: "text", text: "Done." },
      ],
      text: "Looking it up.\n\nDone.",
      toolCalls: [],
      toolResults: [],
      resources: [],
      error: "late failure",
    });
    expect(parts.map((p) => p.type)).toEqual(["text", "tool_call", "tool_result", "resource", "text", "error"]);
    expect(parts[3]).toEqual({ type: "resource", resource: { kind: "workflow", rid: "w", vno: 3 } });
    expect(parts[4]).toEqual({ type: "text", text: "Done." });
  });
});
