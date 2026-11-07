/**
 * How the agent goes from reading to changing things: a change waits for start_work, and in
 * manual work mode for a person's approval; a question with choices ends the turn. Tested on the
 * gate itself, on the loop with a scripted model, and end to end over HTTP with the platform's
 * own server in process (one read-only tool, one change).
 */
import { describe, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import { buildAgent } from "../src/agent/build.ts";
import {
  ASK_TOOL,
  approvalOf,
  describeChange,
  START_WORK_FIRST,
  START_WORK_TOOL,
  Work,
  workTools,
} from "../src/agent/work.ts";
import { CatalogClient } from "../src/catalog/client.ts";
import type { RuntimeConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { APPROVAL_EVENT } from "../src/run/ag-ui-events.ts";
import { type LoopEvent, type LoopOutcome, runReactLoop } from "../src/run/react-loop.ts";
import { DECLINED, PASSED_OVER } from "../src/run/turn.ts";
import { createApp } from "../src/server.ts";
import { CONVERSATION_RID, fakeCatalog, MCP_RID, USER_PID } from "./helpers/fake-catalog.ts";
import { type ScriptedResponse, scriptedModel } from "./helpers/mock-model.ts";

const PLAN = {
  goal: "Mean petal length by species",
  reads: ["texera://datasets/d1@1"],
  makes: [{ kind: "workflow", name: "means" }],
};

async function collect(gen: AsyncGenerator<LoopEvent, LoopOutcome>) {
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

describe("the gate", () => {
  const changes = new Set(["create_workflow"]);
  const call = (toolName: string) => ({ toolCall: { toolName, toolCallId: "c", input: { name: "means" } } }) as never;

  test("reads always go ahead; a change waits for start_work", () => {
    const work = new Work("auto");
    const gate = approvalOf(work, changes) as (o: never) => unknown;
    expect(gate(call("get_resource"))).toBe("not-applicable");
    expect(gate(call("create_workflow"))).toEqual({ type: "denied", reason: START_WORK_FIRST });
    work.plan = PLAN;
    expect(gate(call("create_workflow"))).toBe("not-applicable");
  });

  test("in manual mode a change after start_work waits for a person, described in plain words", () => {
    const work = new Work("manual");
    work.plan = PLAN;
    const gate = approvalOf(work, changes) as (o: never) => unknown;
    expect(gate(call("create_workflow"))).toEqual({ type: "user-approval", reason: 'Create the workflow "means"' });
    expect(gate(call("get_resource"))).toBe("not-applicable");
  });

  test("work an approval answers was started in the turn that asked", () => {
    expect(new Work("manual", { continued: true }).started).toBe(true);
    expect(new Work("manual").started).toBe(false);
  });

  test("a change reads as one plain line", () => {
    expect(describeChange("create_computing_unit", { name: "GPU unit", profile: "texera://profiles/p@2" })).toBe(
      'Start a computing unit "GPU unit" from the profile texera://profiles/p@2',
    );
    expect(describeChange("run_workflow", {})).toBe("Run the workflow");
    expect(describeChange("something_new", {})).toBe("Call something_new");
  });
});

describe("the loop with the gate", () => {
  const created: string[] = [];
  const changeTools = (): ToolSet => ({
    create_workflow: tool({
      description: "create",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        created.push(name);
        return { created: name };
      },
    }),
  });
  const user = (text: string): ModelMessage[] => [{ role: "user", content: text }];

  test("a change before start_work is refused with the reason, and goes through once the plan is said", async () => {
    created.length = 0;
    const work = new Work("auto");
    const model = scriptedModel([
      { toolCalls: [{ id: "c1", toolName: "create_workflow", input: { name: "means" } }] },
      { toolCalls: [{ id: "c2", toolName: START_WORK_TOOL, input: PLAN }] },
      { toolCalls: [{ id: "c3", toolName: "create_workflow", input: { name: "means" } }] },
      { text: "Made it." },
    ]);
    const outcome = await collect(
      runReactLoop({
        model,
        system: "s",
        tools: { ...changeTools(), ...workTools(work) },
        messages: user("make it"),
        maxSteps: 6,
        toolApproval: approvalOf(work, new Set(["create_workflow"])),
      }),
    );
    expect(outcome.reason).toBe("answered");
    expect(created).toEqual(["means"]);
    const refused = outcome.state.steps[0]?.toolResults[0];
    expect(refused).toMatchObject({ toolName: "create_workflow", isError: true, output: { error: START_WORK_FIRST } });
    expect(work.plan?.goal).toBe(PLAN.goal);
  });

  test("in manual mode the loop stops at the change, which has not run", async () => {
    created.length = 0;
    const work = new Work("manual");
    const model = scriptedModel([
      { toolCalls: [{ id: "c1", toolName: START_WORK_TOOL, input: PLAN }] },
      { toolCalls: [{ id: "c2", toolName: "create_workflow", input: { name: "means" } }] },
      { text: "never reached" },
    ]);
    const outcome = await collect(
      runReactLoop({
        model,
        system: "s",
        tools: { ...changeTools(), ...workTools(work) },
        messages: user("make it"),
        maxSteps: 6,
        toolApproval: approvalOf(work, new Set(["create_workflow"])),
      }),
    );
    expect(outcome.reason).toBe("awaiting_approval");
    expect(outcome.approval).toMatchObject({
      toolCallId: "c2",
      toolName: "create_workflow",
      input: { name: "means" },
      reason: 'Create the workflow "means"',
    });
    expect(created).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  test("a question with choices ends the turn", async () => {
    const work = new Work("auto");
    const question = {
      question: "The forecaster runs best on a GPU. Where should it run?",
      options: [{ label: "A new GPU unit" }, { label: "ML on CPU", detail: "slower" }],
    };
    const outcome = await collect(
      runReactLoop({
        model: scriptedModel([{ toolCalls: [{ id: "q1", toolName: ASK_TOOL, input: question }] }, { text: "x" }]),
        system: "s",
        tools: workTools(work),
        messages: user("forecast"),
        maxSteps: 4,
        interruptTools: [ASK_TOOL],
      }),
    );
    expect(outcome.reason).toBe("interrupted");
    expect(outcome.interrupt).toMatchObject({ toolName: ASK_TOOL, input: question });
  });
});

// ---------------------------------------------------------------------------
// End to end: the platform's own server in process, one read and one change.
// ---------------------------------------------------------------------------

const config: RuntimeConfig = {
  port: 0,
  publicUrl: "http://gateway",
  catalogUrl: "http://catalog",
  oidcIssuer: "http://idp",
  oidcAudience: "texera",
  jwksUrl: "http://idp/certs",
  tokenUrl: "http://idp/token",
  serviceClientId: "svc",
  serviceClientSecret: "s",
  maxSteps: 6,
  answerPolicy: "free",
  maxHandoffs: 2,
  answerKeptEveryMs: 5,
};

/** The platform's tools as its server lists them: a read marked read-only, and a change. */
async function platformServer(created: string[]) {
  const server = new McpServer({ name: "catalog", version: "0.0.1" });
  server.registerTool(
    "get_resource",
    { description: "Read a resource", inputSchema: { rid: z.string() }, annotations: { readOnlyHint: true } },
    async ({ rid }) => ({ content: [{ type: "text", text: JSON.stringify({ rid, name: "iris" }) }] }),
  );
  server.registerTool(
    "create_workflow",
    { description: "Create a workflow", inputSchema: { name: z.string() }, annotations: { readOnlyHint: false } },
    async ({ name }) => {
      created.push(name);
      return { content: [{ type: "text", text: JSON.stringify({ created: name }) }] };
    },
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return clientSide;
}

async function workApp(responses: ScriptedResponse[], workMode: "auto" | "manual") {
  const fake = fakeCatalog({
    mcpServer: { url: "http://gateway/mcp/catalog" },
    platformServer: true,
    template: { mcpServers: [{ server: `texera://mcp-servers/${MCP_RID}` }] },
    workMode,
  });
  const catalog = new CatalogClient({ baseUrl: "http://catalog", fetch: fake.fetch });
  const model = scriptedModel(responses);
  const created: string[] = [];
  // Each turn mounts the server anew, over a transport of its own.
  const transports = [await platformServer(created), await platformServer(created), await platformServer(created)];
  const app = createApp({
    config,
    log: silentLogger,
    catalog,
    build: (input) =>
      buildAgent(
        {
          catalog,
          publicUrl: config.publicUrl,
          maxSteps: config.maxSteps,
          log: silentLogger,
          modelFactory: () => model,
          transportFactory: () => transports.shift(),
          now: () => new Date("2026-11-06T12:00:00Z"),
        },
        input,
      ),
    verifyUser: async (token) => ({ subject: "alice", token, claims: {} }),
    serviceTokens: { get: async () => "service-token", invalidate() {} },
    newId: () => "fixed-id",
  });
  return { app, fake, model, created };
}

const said = (text: string) => ({
  threadId: CONVERSATION_RID,
  runId: "run-1",
  messages: [{ id: "m1", role: "user", content: text }],
  tools: [],
  context: [],
  state: {},
});
const decided = (toolCallId: string, approved: boolean) => ({
  threadId: CONVERSATION_RID,
  runId: "run-2",
  messages: [],
  tools: [],
  context: [],
  state: {},
  resume: [{ interruptId: toolCallId, status: approved ? "resolved" : "cancelled", payload: { approved } }],
});

async function turnOf(app: Awaited<ReturnType<typeof workApp>>["app"], body: unknown) {
  const res = await app.request(`/agents/conversations/${CONVERSATION_RID}/ag-ui`, {
    method: "POST",
    headers: { authorization: "Bearer user-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)) as { type: string } & Record<string, unknown>);
}

const planned = [
  { toolCalls: [{ id: "c1", toolName: "get_resource", input: { rid: "d1" } }] },
  { toolCalls: [{ id: "c2", toolName: START_WORK_TOOL, input: PLAN }] },
  { toolCalls: [{ id: "c3", toolName: "create_workflow", input: { name: "means" } }] },
];

describe("a turn in manual work mode", () => {
  test("stops at the change for approval, and an approval runs it and goes on", async () => {
    const { app, fake, created } = await workApp([...planned, { text: "The workflow means is made." }], "manual");

    const first = await turnOf(app, said("Make a workflow of the mean petal length"));
    const finished = first.at(-1);
    expect(finished).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "c3", reason: "approval", toolCallId: "c3", message: 'Create the workflow "means"' }],
      },
    });
    expect(first.find((e) => e.type === EventType.CUSTOM && e.name === APPROVAL_EVENT)).toMatchObject({
      value: { toolCallId: "c3", toolName: "create_workflow", state: "pending" },
    });
    expect(created).toEqual([]);
    const asked = fake.messages.at(-1);
    expect(asked?.parts.map((p) => p.type)).toEqual([
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "tool_call",
      "approval",
    ]);
    expect(asked?.parts.at(-1)).toMatchObject({ type: "approval", toolName: "create_workflow", state: "pending" });

    const second = await turnOf(app, decided("c3", true));
    expect(created).toEqual(["means"]);
    expect(second.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: "success" } });
    expect(second.find((e) => e.type === EventType.CUSTOM && e.name === APPROVAL_EVENT)).toMatchObject({
      value: { toolCallId: "c3", state: "approved", decidedBy: USER_PID },
    });
    // The asking message records the decision and the change's result; the answer follows.
    expect(asked?.parts.at(-2)).toMatchObject({ type: "approval", state: "approved", decidedBy: USER_PID });
    expect(asked?.parts.at(-1)).toMatchObject({ type: "tool_result", toolCallId: "c3" });
    expect(fake.messages.at(-1)?.parts.map((p) => p.text)).toEqual(["The workflow means is made."]);
    expect(fake.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
  });

  test("a declined change is not made, and the model reads that it was declined", async () => {
    const { app, fake, created, model } = await workApp([...planned, { text: "I will not make it." }], "manual");
    await turnOf(app, said("Make a workflow"));
    const second = await turnOf(app, decided("c3", false));
    expect(created).toEqual([]);
    expect(second.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: "success" } });
    expect(fake.messages[1]?.parts.at(-1)).toMatchObject({
      type: "tool_result",
      toolCallId: "c3",
      result: { error: DECLINED },
    });
    expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain(DECLINED);
  });

  test("a message instead of a decision passes the change over", async () => {
    const { app, fake, created, model } = await workApp([...planned, { text: "Understood, nothing made." }], "manual");
    await turnOf(app, said("Make a workflow"));
    await turnOf(app, said("Actually, never mind."));
    expect(created).toEqual([]);
    expect(fake.messages[1]?.parts.find((p) => p.type === "approval")).toMatchObject({ state: "declined" });
    expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain(PASSED_OVER);
  });

  test("a decision with nothing waiting is refused", async () => {
    const { app } = await workApp([{ text: "hi" }], "manual");
    const events = await turnOf(app, decided("nope", true));
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "bad_request" });
  });
});

describe("a turn in auto work mode", () => {
  test("makes the change once the plan is said, and reads go ahead without one", async () => {
    const { app, created } = await workApp([...planned, { text: "Done." }], "auto");
    const events = await turnOf(app, said("Make a workflow"));
    expect(created).toEqual(["means"]);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: "success" } });
    expect(events.some((e) => e.type === EventType.CUSTOM && e.name === APPROVAL_EVENT)).toBe(false);
  });
});
