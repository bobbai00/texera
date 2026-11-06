import type { Message } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import type { AgUiEvent } from "./agui/types";
import { applyEvent, applyPatch, type ChatState, EMPTY_STATE, extractResourceRefs, fromHistory, messageContent, messageParts, resourcesOf, settled, toolFailure, visibleParts, writersOf } from "./model";

const W = "0b7a1c2d-0000-4000-8000-000000000001";
const E = "0b7a1c2d-0000-4000-8000-000000000002";
const T = `texera://agent-templates/0b7a1c2d-0000-4000-8000-000000000003@2`;

const run = (events: AgUiEvent[], start: ChatState = { ...EMPTY_STATE, template: T }) => events.reduce(applyEvent, start);

describe("extractResourceRefs", () => {
  it("finds envelopes, refs and URIs in the shapes tools and events use", () => {
    expect(extractResourceRefs({ kind: "workflow", metadata: { rid: W, uri: `texera://workflows/${W}`, parent: "p" } })).toEqual([{ kind: "workflow", rid: W, parent: "p" }]);
    expect(extractResourceRefs({ kind: "dataset", rid: W, uri: `texera://datasets/${W}@2` })).toEqual([{ kind: "dataset", rid: W, vno: 2 }]);
    expect(extractResourceRefs(`texera://workflows/${W}/executions/${E}`)).toEqual([{ kind: "execution", rid: E, parent: W }]);
    expect(extractResourceRefs({ content: [{ type: "text", text: "no refs" }], items: [{ kind: "skill", rid: W }] })).toEqual([{ kind: "skill", rid: W }]);
    expect(extractResourceRefs({ kind: "nope", rid: W })).toEqual([]);
    expect(extractResourceRefs("just text")).toEqual([]);
  });
});

describe("applyEvent", () => {
  it("streams text and tool calls into the assistant message of the turn, labelled with the template", () => {
    const state = run([
      { type: "RUN_STARTED", threadId: "c", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: " there" },
      { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "search_resources", parentMessageId: "m1" },
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"q":' },
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '"iris"}' },
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      { type: "TOOL_CALL_RESULT", messageId: "x", toolCallId: "t1", content: JSON.stringify({ items: [{ kind: "dataset", metadata: { rid: W } }] }) },
      { type: "RUN_FINISHED", threadId: "c", runId: "r1" },
    ]);
    expect(state.running).toBe(false);
    expect(state.messages).toHaveLength(1);
    const m = state.messages[0];
    expect(m?.template).toBe(T);
    expect(m?.parts[0]).toEqual({ type: "text", text: "Hello there" });
    expect(m?.parts[1]).toMatchObject({ type: "tool", name: "search_resources", input: { q: "iris" }, status: "done", resources: [{ kind: "dataset", rid: W }] });
    expect(state.resources).toEqual([{ kind: "dataset", rid: W }]);
  });

  it("records a handoff as a divider and labels later messages with the new template", () => {
    const next = `texera://agent-templates/0b7a1c2d-0000-4000-8000-000000000004@1`;
    const state = run([
      { type: "RUN_STARTED", threadId: "c", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Handing over." },
      { type: "CUSTOM", name: "texera.handoff", value: { from: T, to: next, name: "Data Analyst", by: "agent" } },
      { type: "TEXT_MESSAGE_START", messageId: "m2", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "On it." },
    ]);
    expect(state.messages.map(m => m.role)).toEqual(["assistant", "system", "assistant"]);
    expect(state.messages[1]?.parts[0]).toEqual({ type: "handoff", from: T, to: next, name: "Data Analyst", by: "agent" });
    expect(state.messages[0]?.template).toBe(T);
    expect(state.messages[2]?.template).toBe(next);
    expect(writersOf(state.messages)).toEqual([T, next]);
  });

  it("marks a failed tool and a run error", () => {
    const state = run([
      { type: "RUN_STARTED", threadId: "c", runId: "r1" },
      { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "run_workflow" },
      { type: "TOOL_CALL_RESULT", messageId: "x", toolCallId: "t1", content: JSON.stringify({ error: "no unit" }) },
      { type: "RUN_ERROR", message: "boom" },
    ]);
    expect(state.messages[0]?.parts[0]).toMatchObject({ type: "tool", status: "error", error: "no unit" });
    expect(state.messages[0]?.parts[1]).toEqual({ type: "error", message: "boom" });
    expect(state.error).toBe("boom");
  });

  it("surfaces resources the runtime announces and applies state patches", () => {
    const state = run([
      { type: "RUN_STARTED", threadId: "c", runId: "r1" },
      { type: "CUSTOM", name: "texera.resource", value: { kind: "workflow", rid: W, uri: `texera://workflows/${W}@3` } },
      { type: "STATE_SNAPSHOT", snapshot: { draft: { n: 1 } } },
      { type: "STATE_DELTA", delta: [{ op: "replace", path: "/draft/n", value: 2 }] },
    ]);
    expect(state.messages[0]?.parts).toEqual([{ type: "resource", ref: { kind: "workflow", rid: W, vno: 3 } }]);
    expect(state.state).toEqual({ draft: { n: 2 } });
    expect(applyPatch([1, 2], [{ op: "add", path: "/-", value: 3 }])).toEqual([1, 2, 3]);
  });
});

describe("fromHistory", () => {
  it("keeps each message's author, so a shared chat can name who said what", () => {
    const [mine, theirs] = fromHistory([
      { conversation: "c", seq: 1, role: "user", author: "p-alice", parts: [{ type: "text", text: "hi" }], createdAt: "2026-11-04T00:00:00Z" },
      { conversation: "c", seq: 2, role: "user", author: "p-bob", parts: [{ type: "text", text: "hello" }], createdAt: "2026-11-04T00:00:01Z" },
    ]);
    expect([mine?.author, theirs?.author]).toEqual(["p-alice", "p-bob"]);
  });

  it("tells what a person said to the people in the chat from what they asked the agent", () => {
    const base = { conversation: "c", author: "p-alice", createdAt: "2026-11-04T00:00:00Z" };
    const [note, asked, answer] = fromHistory([
      { ...base, seq: 1, role: "user", parts: [{ type: "text", text: "Use the 2020 data." }] },
      { ...base, seq: 2, role: "user", turn: "t1", parts: [{ type: "text", text: "Run it." }] },
      { ...base, seq: 3, role: "assistant", turn: "t1", parts: [{ type: "text", text: "Done." }] },
    ]);
    // A message of no turn asked the agent nothing: a note.
    expect([note?.note, asked?.note, answer?.note]).toEqual([true, undefined, undefined]);
  });

  it("rebuilds messages from the catalog, attaching results to calls and keeping the template", () => {
    const base: Omit<Message, "seq" | "role" | "parts"> = { conversation: "c", author: "p", createdAt: "2026-11-04T00:00:00Z" };
    const history: Message[] = [
      { ...base, seq: 1, role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        ...base,
        seq: 2,
        role: "assistant",
        template: T,
        parts: [
          { type: "tool_call", toolCallId: "t1", toolName: "get_workflow", args: { rid: W } },
          { type: "tool_result", toolCallId: "t1", toolName: "get_workflow", result: { kind: "workflow", metadata: { rid: W } } },
          { type: "resource", resource: `texera://workflows/${W}@2` },
          { type: "text", text: "done" },
        ],
      },
      { ...base, seq: 3, role: "system", parts: [{ type: "resource", resource: `texera://agent-templates/${W}@1` }, { type: "text", text: "Switched to Data Analyst." }] },
      { ...base, seq: 4, role: "system", template: T, parts: [{ type: "resource", resource: `texera://agent-templates/${W}@1` }, { type: "text", text: "handed over" }] },
      { ...base, seq: 5, role: "system", parts: [{ type: "text", text: "A plain note." }] },
    ];
    const messages = fromHistory(history);
    expect(messages.map(m => m.role)).toEqual(["user", "assistant", "system", "system", "system"]);
    expect(messages[2]?.parts[0]).toEqual({ type: "handoff", from: undefined, to: `texera://agent-templates/${W}@1`, name: "", by: "person" });
    expect(messages[3]?.parts[0]).toMatchObject({ type: "handoff", from: T, by: "agent" });
    expect(messages[4]?.parts[0]).toEqual({ type: "text", text: "A plain note." });
    const assistant = messages[1];
    expect(assistant?.template).toBe(T);
    expect(assistant?.parts).toHaveLength(3);
    expect(assistant?.parts[0]).toMatchObject({ type: "tool", name: "get_workflow", input: { rid: W }, result: { kind: "workflow", metadata: { rid: W } }, resources: [{ kind: "workflow", rid: W }] });
    expect(assistant?.parts[1]).toEqual({ type: "resource", ref: { kind: "workflow", rid: W, vno: 2 } });
    expect(resourcesOf(messages)).toEqual([{ kind: "workflow", rid: W }]);
  });
});

describe("visibleParts", () => {
  const ref = { kind: "workflow" as const, rid: W };
  it("keeps a resource once per message, in the place it first appears", () => {
    const parts = visibleParts([
      { type: "resource", ref },
      { type: "text", text: "Built it." },
      { type: "resource", ref },
      { type: "resource", ref: { kind: "execution", rid: E } },
    ]);
    expect(parts.map(p => p.type)).toEqual(["resource", "text", "resource"]);
  });
  it("treats versions of one resource as that one resource", () => {
    expect(visibleParts([{ type: "resource", ref: { ...ref, vno: 1 } }, { type: "resource", ref: { ...ref, vno: 2 } }])).toHaveLength(1);
  });
  it("leaves everything else alone, and an empty message empty", () => {
    expect(visibleParts([])).toEqual([]);
    const text = { type: "text" as const, text: "same" };
    expect(visibleParts([text, text])).toEqual([text, text]);
  });
});

describe("settled", () => {
  const failed: ChatState = { ...EMPTY_STATE, error: "Unable to connect.", messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "Hi" }] }] };
  it("leaves nothing when the turn went well: the catalog's copy takes over", () => {
    expect(settled({ ...EMPTY_STATE, messages: failed.messages }, false)).toEqual(EMPTY_STATE);
  });
  it("leaves nothing when the catalog has the error too, so it does not show twice", () => {
    expect(settled(failed, true)).toEqual(EMPTY_STATE);
  });
  it("keeps an error the catalog never got, and only the error", () => {
    const after = settled(failed, false);
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]?.parts).toEqual([{ type: "error", message: "Unable to connect." }]);
    expect(after.running).toBe(false);
  });
});

describe("toolFailure", () => {
  it("reads a plain error", () => {
    expect(toolFailure({ error: "boom" })).toBe("boom");
  });
  it("reads an MCP error result's text, not a generic line", () => {
    expect(toolFailure({ isError: true, content: [{ type: "text", text: "the unit is pending" }] })).toBe("the unit is pending");
  });
  it("reads the message of an error the catalog answered through a tool", () => {
    const text = '404: {"code":"not_found","message":"no result for nosuch/output-0"}';
    expect(toolFailure({ isError: true, content: [{ type: "text", text }] })).toBe("no result for nosuch/output-0");
  });
  it("keeps text that only looks like that", () => {
    expect(toolFailure({ isError: true, content: [{ type: "text", text: "404: {not json}" }] })).toBe("404: {not json}");
  });
  it("still says something when the error has no words", () => {
    expect(toolFailure({ isError: true })).toBe("The tool failed.");
    expect(toolFailure({ isError: true, content: [] })).toBe("The tool failed.");
  });
  it("is nothing for a result that did not fail", () => {
    for (const result of [{ isError: false, content: [] }, { rows: [] }, "text", 3, null, undefined]) expect(toolFailure(result)).toBeUndefined();
  });
  it("shows on the tool part, live and from history", () => {
    const result = { isError: true, content: [{ type: "text", text: "the engine said no" }] };
    const live = run([
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "run_workflow" },
      { type: "TOOL_CALL_RESULT", messageId: "m", toolCallId: "c1", content: JSON.stringify(result) },
    ] as AgUiEvent[]);
    expect(live.messages[0]?.parts[0]).toMatchObject({ status: "error", error: "the engine said no" });
    const history = fromHistory([
      { seq: 1, role: "assistant", parts: [{ type: "tool_call", toolCallId: "c1", toolName: "run_workflow" }, { type: "tool_result", toolCallId: "c1", toolName: "run_workflow", result }] },
    ] as Message[]);
    expect(history[0]?.parts[0]).toMatchObject({ status: "error", error: "the engine said no" });
  });
});

describe("messageContent", () => {
  const dataset = { ref: { kind: "dataset" as const, rid: W, vno: 1 }, name: "iris.csv" };
  it("is the text when nothing is attached", () => {
    expect(messageContent("Hello", [])).toBe("Hello");
  });
  it("attaches by URI as binary content, leaving the text as the person wrote it", () => {
    expect(messageContent("What is this?", [dataset])).toEqual([
      { type: "text", text: "What is this?" },
      { type: "binary", mimeType: "application/vnd.texera.resource", url: `texera://datasets/${W}@1`, filename: "iris.csv" },
    ]);
  });
  it("has no empty text part when only a file is sent", () => {
    expect(messageContent("", [dataset])).toEqual([expect.objectContaining({ type: "binary" })]);
  });
});

describe("an attachment in the history", () => {
  it("is a card of the person's message, with no URI among the words", () => {
    const [message] = fromHistory([
      { seq: 1, role: "user", parts: [{ type: "text", text: "What is this?" }, { type: "resource", resource: `texera://datasets/${W}@1`, text: "iris.csv" }] },
    ] as Message[]);
    expect(message?.parts).toEqual([
      { type: "text", text: "What is this?" },
      { type: "resource", ref: { kind: "dataset", rid: W, vno: 1 } },
    ]);
    expect(resourcesOf(message ? [message] : [])).toEqual([{ kind: "dataset", rid: W, vno: 1 }]);
  });
});

describe("messageParts", () => {
  it("is what a person said as the catalog keeps it: the words, and what they attached by its URI and name", () => {
    const D = "0b7a1c2d-0000-4000-8000-00000000000d";
    expect(messageParts("Look at this.", [{ ref: { kind: "dataset", rid: D, vno: 2 }, name: "sales.csv" }])).toEqual([
      { type: "text", text: "Look at this." },
      { type: "resource", resource: `texera://datasets/${D}@2`, text: "sales.csv" },
    ]);
    expect(messageParts("", [{ ref: { kind: "dataset", rid: D }, name: "sales.csv" }])).toEqual([{ type: "resource", resource: `texera://datasets/${D}`, text: "sales.csv" }]);
  });
});
