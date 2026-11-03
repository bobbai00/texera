/**
 * The ReAct loop on a scripted model: steps are recorded, the turn's state is re-rendered into
 * the system prompt, and the answer policy sends a premature reply back, bounded.
 */
import { describe, expect, test } from "bun:test";
import { type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import {
  CUT_OFF_CORRECTION,
  type LoopEvent,
  type LoopOutcome,
  PREMATURE_ANSWER_CORRECTION,
  renderTurnState,
  runReactLoop,
  showsResult,
} from "../src/run/react-loop.ts";
import { type ScriptedResponse, scriptedModel } from "./helpers/mock-model.ts";

const WORKFLOW_RID = "88888888-8888-4888-8888-888888888888";
const EXECUTION_EID = "99999999-9999-4999-8999-999999999999";

/** MCP-shaped tool outputs, as the built-in server returns them. */
const mcpText = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function dataflowTools(runStatus: "completed" | "failed" = "completed"): ToolSet {
  return {
    create_workflow: tool({
      description: "create",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) =>
        mcpText({ workflow: { kind: "workflow", metadata: { rid: WORKFLOW_RID, name, headVersion: 1 } } }),
    }),
    run_workflow: tool({
      description: "run",
      inputSchema: z.object({ rid: z.string() }),
      execute: async () => mcpText({ eid: EXECUTION_EID, status: runStatus, workflow: { rid: WORKFLOW_RID, vno: 1 } }),
    }),
    search_resources: tool({
      description: "search",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => mcpText({ items: [] }),
    }),
  };
}

async function collect(gen: AsyncGenerator<LoopEvent, LoopOutcome>) {
  const events: LoopEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, outcome: next.value };
}

const user = (text: string): ModelMessage[] => [{ role: "user", content: text }];

function systemOfCall(model: ReturnType<typeof scriptedModel>, call: number): string {
  const prompt = model.doStreamCalls[call]?.prompt ?? [];
  return prompt
    .filter((m) => m.role === "system")
    .map((m) => (m as { content: string }).content)
    .join("\n");
}

describe("runReactLoop", () => {
  test("a tool step then a reply: two recorded steps, the answer, and the state re-rendered per call", async () => {
    const script: ScriptedResponse[] = [
      { toolCalls: [{ id: "c1", toolName: "create_workflow", input: { name: "means" } }] },
      { text: "Created the workflow." },
    ];
    const model = scriptedModel(script);
    const { events, outcome } = await collect(
      runReactLoop({ model, system: "You analyze.", tools: dataflowTools(), messages: user("build it"), maxSteps: 5 }),
    );
    expect(outcome.reason).toBe("answered");
    expect(outcome.state.steps.map((s) => s.toolCalls.map((c) => c.toolName))).toEqual([["create_workflow"], []]);
    expect(outcome.state.steps[0]?.toolResults[0]?.isError).toBe(false);
    expect(outcome.state.resources).toEqual([{ kind: "workflow", rid: WORKFLOW_RID, vno: 1 }]);
    expect(events.filter((e) => e.type === "step")).toHaveLength(2);
    expect(events.some((e) => e.type === "part" && e.part.type === "text-delta")).toBe(true);
    // The second model call saw the turn's state with the workflow's id in its system prompt.
    expect(systemOfCall(model, 0)).toContain("Step 1 of 5");
    expect(systemOfCall(model, 1)).toContain(WORKFLOW_RID);
    expect(systemOfCall(model, 1)).toContain("Step 2 of 5");
    expect(outcome.usage.totalTokens).toBeGreaterThan(0);
  });

  test("after_result: a reply before any result is sent back once, then the computed answer is accepted", async () => {
    const script: ScriptedResponse[] = [
      { text: "The average is probably 3." },
      { toolCalls: [{ id: "c1", toolName: "run_workflow", input: { rid: WORKFLOW_RID } }] },
      { text: "The average is 1.462." },
    ];
    const model = scriptedModel(script);
    const { events, outcome } = await collect(
      runReactLoop({
        model,
        system: "s",
        tools: dataflowTools(),
        messages: user("what is the average?"),
        maxSteps: 6,
        policy: { answer: "after_result" },
      }),
    );
    expect(outcome.reason).toBe("answered");
    expect(outcome.state.corrections).toBe(1);
    expect(outcome.state.resultShown).toBe(true);
    const corrections = events.filter((e) => e.type === "correction");
    expect(corrections).toEqual([
      { type: "correction", reason: "premature_answer", text: PREMATURE_ANSWER_CORRECTION },
    ]);
    // The correction travels as a user message after the model's own reply.
    const second = model.doStreamCalls[1]?.prompt ?? [];
    const last = second[second.length - 1] as { role: string; content: Array<{ text?: string }> };
    expect(last.role).toBe("user");
    expect(last.content[0]?.text).toBe(PREMATURE_ANSWER_CORRECTION);
    expect(outcome.state.steps).toHaveLength(3);
  });

  test("after_result: a second premature reply is accepted once the corrections are spent", async () => {
    const model = scriptedModel([{ text: "I cannot compute that." }, { text: "This needs no computation: no." }]);
    const { events, outcome } = await collect(
      runReactLoop({
        model,
        system: "s",
        tools: dataflowTools(),
        messages: user("hello?"),
        maxSteps: 6,
        policy: { answer: "after_result", maxCorrections: 1 },
      }),
    );
    expect(outcome.reason).toBe("answered");
    expect(outcome.state.corrections).toBe(1);
    expect(events.filter((e) => e.type === "correction")).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  test("after_result: a failed run shows no result, a completed one does", async () => {
    const failed = {
      toolCallId: "c",
      toolName: "run_workflow",
      output: mcpText({ eid: EXECUTION_EID, status: "failed" }),
      isError: false,
    };
    const done = { ...failed, output: mcpText({ eid: EXECUTION_EID, status: "completed" }) };
    const tools = ["run_workflow", "get_port_result"];
    expect(showsResult(failed, tools)).toBe(false);
    expect(showsResult(done, tools)).toBe(true);
    expect(
      showsResult({ toolCallId: "c", toolName: "get_port_result", output: { rows: [] }, isError: false }, tools),
    ).toBe(true);
    expect(
      showsResult({ toolCallId: "c", toolName: "get_port_result", output: { error: "x" }, isError: true }, tools),
    ).toBe(false);
    expect(showsResult({ toolCallId: "c", toolName: "search_resources", output: {}, isError: false }, tools)).toBe(
      false,
    );
  });

  test("free: the first reply is the answer even without a result", async () => {
    const model = scriptedModel([{ text: "Hello!" }]);
    const { events, outcome } = await collect(
      runReactLoop({ model, system: "s", tools: dataflowTools(), messages: user("hi"), maxSteps: 3 }),
    );
    expect(outcome.reason).toBe("answered");
    expect(events.filter((e) => e.type === "correction")).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  test("the step budget ends a turn that is still calling tools", async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: "c1", toolName: "search_resources", input: { q: "a" } }] },
      { toolCalls: [{ id: "c2", toolName: "search_resources", input: { q: "b" } }] },
      { text: "never reached" },
    ]);
    const { outcome } = await collect(
      runReactLoop({ model, system: "s", tools: dataflowTools(), messages: user("find"), maxSteps: 2 }),
    );
    expect(outcome.reason).toBe("step_limit");
    expect(outcome.state.steps).toHaveLength(2);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  test("a provider refusal is retried once; a reply cut off at the output limit is continued once", async () => {
    const refused = scriptedModel([{ text: "", finishReason: "content-filter" }, { text: "Fine." }]);
    const r = await collect(runReactLoop({ model: refused, system: "s", tools: {}, messages: user("x"), maxSteps: 4 }));
    expect(r.outcome.reason).toBe("answered");
    expect(r.events.filter((e) => e.type === "correction").map((e) => (e as { reason: string }).reason)).toEqual([
      "refused",
    ]);

    const cut = scriptedModel([{ text: "The first half", finishReason: "length" }, { text: " and the rest." }]);
    const c = await collect(runReactLoop({ model: cut, system: "s", tools: {}, messages: user("x"), maxSteps: 4 }));
    expect(c.outcome.reason).toBe("answered");
    expect(c.events.filter((e) => e.type === "correction").map((e) => (e as { reason: string }).reason)).toEqual([
      "cut_off",
    ]);
    const second = cut.doStreamCalls[1]?.prompt ?? [];
    const last = second[second.length - 1] as { role: string; content: Array<{ text?: string }> };
    expect(last.content[0]?.text).toBe(CUT_OFF_CORRECTION);

    const twiceRefused = scriptedModel([
      { text: "", finishReason: "content-filter" },
      { text: "", finishReason: "content-filter" },
    ]);
    const t = await collect(
      runReactLoop({ model: twiceRefused, system: "s", tools: {}, messages: user("x"), maxSteps: 4 }),
    );
    expect(t.outcome.reason).toBe("refused");
  });

  test("renderTurnState names the budget, the touched resources and whether a result was shown", () => {
    const text = renderTurnState(
      {
        steps: [],
        resources: [
          { kind: "workflow", rid: WORKFLOW_RID, vno: 2 },
          { kind: "execution", rid: EXECUTION_EID },
        ],
        resultShown: false,
        corrections: 0,
        maxSteps: 10,
      },
      3,
    );
    expect(text).toContain("Step 3 of 10");
    expect(text).toContain(`workflow ${WORKFLOW_RID} version 2`);
    expect(text).toContain(`execution ${EXECUTION_EID}`);
    expect(text).toContain("No computed result");
  });
});
