import { describe, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import type { TextStreamPart, ToolSet } from "ai";
import { RESOURCE_EVENT, StreamMapper } from "../src/run/ag-ui-events.ts";

const RID = "22222222-2222-4222-8222-222222222222";

function mapAll(parts: TextStreamPart<ToolSet>[]) {
  const mapper = new StreamMapper({ newId: () => "id" });
  const events = parts.flatMap((p) => mapper.map(p));
  return { events, types: events.map((e) => e.type), mapper };
}

describe("StreamMapper", () => {
  test("maps a streamed text message", () => {
    const { types, events, mapper } = mapAll([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "Hello " },
      { type: "text-delta", id: "t1", text: "world" },
      { type: "text-end", id: "t1" },
      {
        type: "finish-step",
        response: { id: "r", modelId: "m", timestamp: new Date() },
        usage: {} as never,
        performance: {} as never,
        finishReason: "stop",
        rawFinishReason: undefined,
        providerMetadata: undefined,
      },
      { type: "finish", finishReason: "stop", rawFinishReason: undefined, totalUsage: {} as never },
    ]);
    expect(types).toEqual([
      EventType.STEP_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.STEP_FINISHED,
    ]);
    expect(events[1]).toMatchObject({ messageId: "t1", role: "assistant" });
    expect(events[2]).toMatchObject({ messageId: "t1", delta: "Hello " });
    expect(mapper.collected.text).toBe("Hello world");
  });

  test("maps a streamed tool call, its result and the resource it names", () => {
    const envelope = {
      apiVersion: "catalog.texera.apache.org/v1",
      kind: "workflow",
      metadata: { rid: RID, uri: `texera://workflows/${RID}`, head: 3, name: "w" },
      spec: {},
    };
    const { events, types, mapper } = mapAll([
      { type: "tool-input-start", id: "c1", toolName: "get_resource" },
      { type: "tool-input-delta", id: "c1", delta: '{"rid":"' },
      { type: "tool-input-delta", id: "c1", delta: `${RID}"}` },
      { type: "tool-input-end", id: "c1" },
      { type: "tool-call", toolCallId: "c1", toolName: "get_resource", input: { rid: RID } } as never,
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "get_resource",
        input: { rid: RID },
        output: envelope,
      } as never,
    ]);
    expect(types).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.CUSTOM,
    ]);
    expect(events[0]).toMatchObject({ toolCallId: "c1", toolCallName: "get_resource" });
    expect(events[4]).toMatchObject({ toolCallId: "c1", role: "tool", content: JSON.stringify(envelope) });
    expect(events[5]).toMatchObject({
      name: RESOURCE_EVENT,
      value: { kind: "workflow", rid: RID, vno: 3, uri: `texera://workflows/${RID}` },
    });
    expect(mapper.collected.toolCalls).toEqual([{ toolCallId: "c1", toolName: "get_resource", input: { rid: RID } }]);
    expect(mapper.collected.resources).toEqual([
      { kind: "workflow", rid: RID, uri: `texera://workflows/${RID}`, vno: 3 },
    ]);
  });

  test("emits a whole tool call when the provider did not stream its input", () => {
    const { types, events } = mapAll([
      { type: "tool-call", toolCallId: "c2", toolName: "run_workflow", input: { rid: RID } } as never,
    ]);
    expect(types).toEqual([EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END]);
    expect(events[1]).toMatchObject({ delta: JSON.stringify({ rid: RID }) });
  });

  test("maps tool errors, model errors and aborts", () => {
    const { types, events, mapper } = mapAll([
      { type: "tool-error", toolCallId: "c3", toolName: "x", input: {}, error: new Error("boom") } as never,
      { type: "error", error: new Error("model down") },
      { type: "abort", reason: "client left" },
    ]);
    expect(types).toEqual([EventType.TOOL_CALL_RESULT, EventType.RUN_ERROR, EventType.RUN_ERROR]);
    expect(events[0]).toMatchObject({ content: JSON.stringify({ error: "boom" }) });
    expect(events[1]).toMatchObject({ message: "model down", code: "model_error" });
    expect(events[2]).toMatchObject({ code: "aborted" });
    expect(mapper.collected.toolResults[0]).toMatchObject({ isError: true });
  });

  test("finds executions and versions inside MCP text content", () => {
    const eid = "77777777-7777-4777-8777-777777777777";
    const execution = {
      kind: "execution",
      metadata: { rid: eid, uri: `texera://workflows/${RID}/executions/${eid}`, head: 0 },
      spec: {},
      status: { phase: "completed" },
    };
    const output = { content: [{ type: "text", text: JSON.stringify(execution) }] };
    const { events } = mapAll([
      { type: "tool-result", toolCallId: "c4", toolName: "run_workflow", input: {}, output } as never,
    ]);
    const custom = events.filter((e) => e.type === EventType.CUSTOM);
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ value: { kind: "execution", rid: eid } });
  });
});

describe("StreamMapper collected parts", () => {
  test("text segments around a tool call stay separate and in order", () => {
    const mapper = new StreamMapper({ newId: () => "id" });
    const parts = [
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", text: "Checking." },
      { type: "text-end", id: "a" },
      { type: "tool-call", toolCallId: "c1", toolName: "get_resource", input: {} },
      { type: "tool-result", toolCallId: "c1", toolName: "get_resource", input: {}, output: { ok: true } },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "b", text: "Found it." },
      { type: "text-end", id: "b" },
    ];
    for (const p of parts) mapper.map(p as never);
    expect(mapper.collected.parts.map((p) => p.type)).toEqual(["text", "tool_call", "tool_result", "text"]);
    expect(mapper.collected.parts[0]).toEqual({ type: "text", text: "Checking." });
    expect(mapper.collected.parts[3]).toEqual({ type: "text", text: "Found it." });
    expect(mapper.collected.text).toBe("Checking.\n\nFound it.");
  });
});
