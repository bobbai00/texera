import type { Message } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import type { AgUiEvent } from "./agui/types";
import { applyEvent, applyPatch, type ChatState, EMPTY_STATE, extractResourceRefs, fromHistory, resourcesOf, templatesOf } from "./model";

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
    expect(templatesOf(state.messages)).toEqual([T, next]);
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
