import { describe, expect, it } from "vitest";
import type { AgUiEvent } from "./agui/types";
import { applyEvent, applyPatch, EMPTY_STATE, extractResourceRefs, fromHistory, resourcesOf } from "./model";

const run = (events: AgUiEvent[]) => events.reduce(applyEvent, EMPTY_STATE);

describe("AG-UI reducer", () => {
  it("streams text into one assistant message", () => {
    const state = run([
      { type: "RUN_STARTED", threadId: "t", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hel" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "lo" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_FINISHED", threadId: "t", runId: "r1" },
    ]);
    expect(state.running).toBe(false);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("builds tool calls from start/args/end/result and lifts resources out of results", () => {
    const state = run([
      { type: "RUN_STARTED", threadId: "t", runId: "r1" },
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "run_workflow", parentMessageId: "m1" },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"rid":' },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '"w1"}' },
      { type: "TOOL_CALL_END", toolCallId: "c1" },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "m2",
        toolCallId: "c1",
        content: JSON.stringify({ eid: "e1", workflow: { rid: "w1", vno: 3 }, status: "completed" }),
      },
    ]);
    const tool = state.messages[0]?.parts[0];
    expect(tool?.type).toBe("tool");
    if (tool?.type !== "tool") throw new Error("expected a tool part");
    expect(tool.input).toEqual({ rid: "w1" });
    expect(tool.status).toBe("done");
    expect(tool.resources).toEqual([{ kind: "execution", rid: "e1" }]);
    expect(state.resources).toEqual([{ kind: "execution", rid: "e1" }]);
  });

  it("marks failed tools, custom resource events and subagents", () => {
    const state = run([
      { type: "RUN_STARTED", threadId: "t", runId: "r1" },
      { type: "TOOL_CALL_CHUNK", toolCallId: "c1", toolCallName: "edit_workflow", delta: "{}" },
      { type: "TOOL_CALL_RESULT", messageId: "m", toolCallId: "c1", content: JSON.stringify({ error: "head moved" }) },
      { type: "CUSTOM", name: "texera.resource", value: { kind: "dataset", rid: "d1", vno: 1 } },
      { type: "SUBAGENT_STARTED", subagentRunId: "s1", name: "searcher" },
      { type: "SUBAGENT_FINISHED", subagentRunId: "s1" },
      { type: "RUN_ERROR", message: "boom" },
    ]);
    const parts = state.messages[0]?.parts ?? [];
    expect(parts[0]).toMatchObject({ type: "tool", status: "error", error: "head moved" });
    expect(parts[1]).toEqual({ type: "resource", ref: { kind: "dataset", rid: "d1", vno: 1 } });
    expect(parts[2]).toMatchObject({ type: "subagent", status: "done" });
    expect(parts[3]).toEqual({ type: "error", message: "boom" });
    expect(state.error).toBe("boom");
    expect(state.resources).toEqual([{ kind: "dataset", rid: "d1", vno: 1 }]);
  });

  it("keeps shared state through snapshots and JSON Patch deltas", () => {
    const state = run([
      { type: "STATE_SNAPSHOT", snapshot: { draft: { operators: [] } } },
      { type: "STATE_DELTA", delta: [{ op: "add", path: "/draft/operators/-", value: { operatorID: "a" } }] },
      { type: "STATE_DELTA", delta: [{ op: "replace", path: "/draft/name", value: "Sales" }] },
    ]);
    expect(state.state).toEqual({ draft: { operators: [{ operatorID: "a" }], name: "Sales" } });
    expect(applyPatch({ a: { b: 1 } }, [{ op: "remove", path: "/a/b" }])).toEqual({ a: {} });
  });

  it("records an interrupt as an approval part", () => {
    const state = run([
      { type: "RUN_STARTED", threadId: "t", runId: "r1" },
      { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", delta: "May I run it?" },
      { type: "RUN_FINISHED", threadId: "t", runId: "r1", outcome: { type: "interrupt", interrupts: [{ id: "i1", reason: "run_workflow" }] } },
    ]);
    expect(state.messages[0]?.parts.at(-1)).toEqual({ type: "approval", interrupts: [{ id: "i1", reason: "run_workflow" }] });
  });
});

describe("resource refs", () => {
  it("finds envelopes, refs, executions and versions in nested results", () => {
    expect(
      extractResourceRefs({
        workflow: { kind: "workflow", metadata: { rid: "w1", name: "x" } },
        version: { rid: "w1", vno: 2, contentKind: "json" },
        items: [{ kind: "dataset", rid: "d1" }, { kind: "dataset", rid: "d1" }],
      })
    ).toEqual([
      { kind: "workflow", rid: "w1" },
      { kind: "dataset", rid: "d1" },
    ]);
  });
});

describe("history", () => {
  it("maps persisted messages and attaches tool results to their calls", () => {
    const messages = fromHistory([
      { conversation: "c", seq: 1, role: "user", author: "p", parts: [{ type: "text", text: "hi" }], createdAt: "2026-11-03T00:00:00Z" },
      {
        conversation: "c",
        seq: 2,
        role: "assistant",
        author: "a",
        parts: [
          { type: "text", text: "Building it." },
          { type: "tool_call", toolCallId: "c1", toolName: "create_workflow", args: { name: "Sales" } },
        ],
        createdAt: "2026-11-03T00:00:01Z",
      },
      {
        conversation: "c",
        seq: 3,
        role: "tool",
        author: "a",
        parts: [{ type: "tool_result", toolCallId: "c1", result: { workflow: { kind: "workflow", metadata: { rid: "w1" } } } }],
        createdAt: "2026-11-03T00:00:02Z",
      },
    ]);
    expect(messages).toHaveLength(2);
    const tool = messages[1]?.parts[1];
    expect(tool).toMatchObject({ type: "tool", name: "create_workflow", resources: [{ kind: "workflow", rid: "w1" }] });
    expect(resourcesOf(messages)).toEqual([{ kind: "workflow", rid: "w1" }]);
  });
});
