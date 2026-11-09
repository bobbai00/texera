import { describe, expect, test } from "bun:test";
import type { Message, MessagePart } from "../src/catalog/types.ts";
import { assistantParts, attachedFiles, toModelMessages } from "../src/run/messages.ts";

const base = { conversation: "c", author: "a", createdAt: "" };

describe("attachedFiles", () => {
  const file = "texera://datasets/88888888-8888-4888-8888-888888888888@1";
  test("gives each file of an upload its own name, and leaves out what is not a file at a version", () => {
    const history: Message[] = [
      {
        ...base,
        seq: 1,
        role: "user",
        parts: [
          { type: "text", text: "look" },
          { type: "resource", resource: file, text: "a.csv, b.csv" },
          { type: "resource", resource: "texera://models/88888888-8888-4888-8888-888888888888@1", text: "m" },
          { type: "resource", resource: "texera://datasets/88888888-8888-4888-8888-888888888888", text: "d" },
        ],
      },
    ];
    expect(attachedFiles(history)).toEqual([
      { name: "a.csv", uri: file },
      { name: "b.csv", uri: file },
    ]);
  });
});

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
          { type: "resource", resource: "texera://workflows/w/executions/e" },
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
      { type: "resource", resource: "texera://workflows/w/executions/e" },
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

  test("names who wrote a message in a chat several people write in", () => {
    const history: Message[] = [
      { ...base, author: "p-alice", seq: 1, role: "user", parts: [{ type: "text", text: "Use the 2020 data." }] },
      {
        ...base,
        author: "p-bob",
        seq: 2,
        role: "user",
        parts: [
          { type: "text", text: "Run it." },
          { type: "resource", resource: "texera://datasets/d@1", text: "sales.csv" },
        ],
      },
      { ...base, author: "p-bob", seq: 3, role: "assistant", parts: [{ type: "text", text: "Done." }] },
    ];
    const people = new Map([
      ["p-alice", "Alice Liddell"],
      ["p-bob", "Bob Builder"],
    ]);
    expect(toModelMessages(history, { people })).toEqual([
      { role: "user", content: "[Alice Liddell] Use the 2020 data." },
      { role: "user", content: '[Bob Builder] Run it.\nAttached file "sales.csv" (texera://datasets/d@1)' },
      // What the agent said is its own, whoever it was answering.
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
    // One person's chat reads as it always did.
    expect(toModelMessages(history)[0]).toEqual({ role: "user", content: "Use the 2020 data." });
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
        { type: "resource", resource: "texera://workflows/w@3" },
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
    expect(parts[3]).toEqual({ type: "resource", resource: "texera://workflows/w@3" });
    expect(parts[4]).toEqual({ type: "text", text: "Done." });
  });
});

describe("what the model is not shown", () => {
  test("an error part is the person's record, not something the model said", () => {
    const failed = {
      ...base,
      seq: 2,
      role: "assistant" as const,
      parts: [{ type: "error", text: "Unable to connect." }] as MessagePart[],
    };
    expect(toModelMessages([failed])).toEqual([]);
  });
});

describe("what a person attached", () => {
  const user = (parts: MessagePart[]) => ({ ...base, seq: 1, role: "user" as const, parts });

  test("reaches the model as a line that names it and its URI", () => {
    const messages = toModelMessages([
      user([
        { type: "text", text: "What is in this file?" },
        { type: "resource", resource: "texera://datasets/d1@1", text: "iris.csv" },
      ]),
    ]);
    expect(messages).toEqual([
      { role: "user", content: 'What is in this file?\nAttached file "iris.csv" (texera://datasets/d1@1)' },
    ]);
  });

  test("is a message of its own when there is no text", () => {
    expect(toModelMessages([user([{ type: "resource", resource: "texera://datasets/d1@1" }])])).toEqual([
      { role: "user", content: "Attached dataset (texera://datasets/d1@1)" },
    ]);
  });

  test("names the kind from the URI, for any kind", () => {
    expect(toModelMessages([user([{ type: "resource", resource: "texera://computing-units/u1" }])])).toEqual([
      { role: "user", content: "Attached computing-unit (texera://computing-units/u1)" },
    ]);
    expect(toModelMessages([user([{ type: "resource", resource: "texera://workflows/w1/executions/e1" }])])).toEqual([
      { role: "user", content: "Attached execution (texera://workflows/w1/executions/e1)" },
    ]);
  });
});
