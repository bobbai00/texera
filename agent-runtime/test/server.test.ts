/**
 * End to end over HTTP with everything faked: the identity provider, the catalog and the
 * model. A turn streams AG-UI events and persists its messages; a handoff switches the
 * conversation's template mid-turn; `/mode` switches it without a model.
 */
import { describe, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { buildAgent } from "../src/agent/build.ts";
import { AuthError } from "../src/auth/jwt.ts";
import { CatalogClient } from "../src/catalog/client.ts";
import type { RuntimeConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { HANDOFF_EVENT, RESOURCE_EVENT } from "../src/run/ag-ui-events.ts";
import { createApp } from "../src/server.ts";
import {
  ANALYST_URI,
  BIO_TEMPLATE_RID,
  BIO_URI,
  CONVERSATION_RID,
  type FakeCatalogOptions,
  fakeCatalog,
  MCP_RID,
  TEMPLATE_RID,
  UNIT_URI,
} from "./helpers/fake-catalog.ts";
import { type ScriptedResponse, scriptedModel } from "./helpers/mock-model.ts";

const WORKFLOW_RID = "88888888-8888-4888-8888-888888888888";

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
  maxSteps: 5,
  answerPolicy: "free",
  maxHandoffs: 2,
};

/** An app whose agents run a scripted model with local tools; no MCP servers are mounted. */
function makeApp(responses: ScriptedResponse[], tools: ToolSet = {}, options: FakeCatalogOptions = {}) {
  const fake = fakeCatalog({ ...options, template: { catalogTools: false, ...options.template } });
  const catalog = new CatalogClient({ baseUrl: "http://catalog", fetch: fake.fetch });
  const model = scriptedModel(responses);
  const builds: string[] = [];
  const app = createApp({
    config,
    log: silentLogger,
    catalog,
    build: (input) => {
      builds.push(input.template.name);
      return buildAgent(
        {
          catalog,
          publicUrl: config.publicUrl,
          maxSteps: config.maxSteps,
          log: silentLogger,
          modelFactory: () => model,
          extraTools: tools,
          now: () => new Date("2026-11-05T12:00:00Z"),
        },
        input,
      );
    },
    verifyUser: async (token) => {
      if (token !== "user-token") throw new AuthError("bad token");
      return { subject: "alice", token, claims: {} };
    },
    serviceTokens: { get: async () => "service-token", invalidate() {} },
    newId: () => "fixed-id",
  });
  return { app, fake, builds, model };
}

async function readSse(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as { type: string } & Record<string, unknown>);
}

const runInput = (text: string, forwardedProps?: Record<string, unknown>) => ({
  threadId: CONVERSATION_RID,
  runId: "run-1",
  messages: [{ id: "m1", role: "user", content: text }],
  tools: [],
  context: [],
  state: {},
  ...(forwardedProps ? { forwardedProps } : {}),
});

const post = (app: ReturnType<typeof createApp>, body: unknown, token = "user-token") =>
  app.request(`/agents/conversations/${CONVERSATION_RID}/ag-ui`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /agents/conversations/:rid/ag-ui", () => {
  test("streams a full turn with a tool call and persists both messages with the turn and the template", async () => {
    const getResource = tool({
      description: "get",
      inputSchema: z.object({ rid: z.string() }),
      execute: async ({ rid }) => ({
        apiVersion: "catalog.texera.apache.org/v1",
        kind: "workflow",
        metadata: { rid, uri: `texera://workflows/${rid}`, head: 2, name: "penguins" },
        spec: {},
      }),
    });
    const { app, fake, builds } = makeApp(
      [
        { toolCalls: [{ id: "c1", toolName: "get_resource", input: { rid: WORKFLOW_RID } }] },
        { text: "The workflow has two operators." },
      ],
      { get_resource: getResource },
    );
    const res = await post(app, runInput("Describe the workflow"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    const resource = events.find((e) => e.type === EventType.CUSTOM);
    expect(resource).toMatchObject({
      name: RESOURCE_EVENT,
      value: { kind: "workflow", rid: WORKFLOW_RID, vno: 2, uri: `texera://workflows/${WORKFLOW_RID}` },
    });
    expect(events.filter((e) => e.type === EventType.STEP_STARTED)).toHaveLength(2);

    // The catalog holds the user message and the assistant message with every part, both in the turn.
    expect(fake.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const [user, assistant] = fake.messages;
    expect(user?.turn).toBeDefined();
    expect(assistant?.turn).toBe(user?.turn);
    expect(assistant?.template).toBe(`${ANALYST_URI}@1`);
    expect(assistant?.parts.map((p) => p.type)).toEqual(["tool_call", "tool_result", "resource", "text"]);
    expect(assistant?.parts[3]?.text).toBe("The workflow has two operators.");
    expect(assistant?.parts[2]?.resource).toBe(`texera://workflows/${WORKFLOW_RID}`);
    // The turn was taken and released; the model key was leased for the conversation.
    expect(fake.conversation.status.activeTurn).toBeUndefined();
    expect(fake.leases).toEqual([`texera://conversations/${CONVERSATION_RID}`]);
    // Every call inside the turn carried the service token and the origin; the first did not.
    const inside = fake.calls.filter((c) => c.headers["x-texera-origin"]);
    expect(inside.length).toBeGreaterThan(3);
    for (const call of inside) {
      expect(call.headers.authorization).toBe("Bearer user-token");
      expect(call.headers["x-texera-service-token"]).toBe("service-token");
      expect(call.headers["x-texera-origin"]).toMatch(
        new RegExp(`^conversation=${CONVERSATION_RID};turn=turn-\\d+;template=${ANALYST_URI}@1$`),
      );
    }
    expect(builds).toEqual(["Data Analyst"]);
  });

  test("a handoff switches the conversation's template and the target finishes the turn", async () => {
    const { app, fake, builds } = makeApp(
      [
        { toolCalls: [{ id: "h1", toolName: "handoff", input: { template: ANALYST_URI, reason: "data work" } }] },
        { text: "Here is the analysis." },
      ],
      {},
      { conversationTemplate: BIO_URI },
    );
    const events = await readSse(await post(app, runInput("Analyze iris.csv")));
    const handoff = events.find((e) => e.type === EventType.CUSTOM && e.name === HANDOFF_EVENT);
    expect(handoff).toMatchObject({
      value: { from: `${BIO_URI}@1`, to: `${ANALYST_URI}@1`, name: "Data Analyst", by: "agent" },
    });
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(builds).toEqual(["Bio Researcher", "Data Analyst"]);
    expect(fake.conversation.spec.template).toBe(ANALYST_URI);
    expect(fake.messages.map((m) => [m.role, m.template])).toEqual([
      ["user", undefined],
      ["assistant", `${BIO_URI}@1`],
      ["system", `${BIO_URI}@1`],
      ["assistant", `${ANALYST_URI}@1`],
    ]);
    expect(fake.messages[1]?.parts.map((p) => p.type)).toEqual(["tool_call", "tool_result"]);
    // The record of the handoff: written by the Bio Researcher, naming the Data Analyst.
    expect(fake.messages[2]?.parts.map((p) => [p.type, p.resource ?? p.text])).toEqual([
      ["resource", `${ANALYST_URI}@1`],
      ["text", "Bio Researcher handed the chat to Data Analyst."],
    ]);
    expect(fake.messages[3]?.parts[0]?.text).toBe("Here is the analysis.");
    expect(fake.conversation.status.activeTurn).toBeUndefined();
  });

  test("/mode switches the template without a model call", async () => {
    const { app, fake, builds } = makeApp([{ text: "never" }]);
    const events = await readSse(await post(app, runInput("/mode Bio Researcher")));
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.CUSTOM,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(events[1]).toMatchObject({
      name: HANDOFF_EVENT,
      value: { to: `${BIO_URI}@1`, name: "Bio Researcher", by: "person" },
    });
    expect(fake.conversation.spec.template).toBe(BIO_URI);
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]).toMatchObject({ role: "system" });
    expect(builds).toEqual([]);
  });

  test("forwardedProps.template runs the turn on another template", async () => {
    const { app, fake, builds } = makeApp([{ text: "hello from bio" }]);
    const events = await readSse(await post(app, runInput("hi", { template: BIO_URI })));
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(builds).toEqual(["Bio Researcher"]);
    expect(fake.conversation.spec.template).toBe(BIO_URI);
  });

  test("a second turn while one runs is refused with turn_active", async () => {
    const { app, fake } = makeApp([{ text: "x" }]);
    fake.conversation.status.activeTurn = "other";
    const events = await readSse(await post(app, runInput("hi")));
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR]);
    expect(events[1]).toMatchObject({ code: "turn_active" });
  });

  test("rejects missing and invalid tokens and bad input", async () => {
    const { app } = makeApp([{ text: "x" }]);
    const body = JSON.stringify(runInput("hi"));
    const headers = { "content-type": "application/json" };
    const path = `/agents/conversations/${CONVERSATION_RID}/ag-ui`;
    expect((await app.request(path, { method: "POST", headers, body })).status).toBe(401);
    expect(
      (await app.request(path, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body })).status,
    ).toBe(401);
    expect(
      (
        await app.request(path, {
          method: "POST",
          headers: { ...headers, authorization: "Bearer user-token" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });

  test("a run without a user message ends with RUN_ERROR", async () => {
    const { app, fake } = makeApp([{ text: "x" }]);
    const events = await readSse(await post(app, { ...runInput("hi"), messages: [] }));
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR]);
    expect(fake.messages).toHaveLength(0);
  });

  test("a turn whose agent cannot be built says why, and the chat keeps it", async () => {
    // The template names a model endpoint that is not there: no agent, and no model to call.
    const { app, fake } = makeApp(
      [],
      {},
      { template: { model: "texera://model-endpoints/00000000-0000-4000-8000-000000000000" } },
    );
    const events = await readSse(await post(app, runInput("Hello")));
    const error = events.at(-1) as unknown as { type: string; message: string; code: string };
    expect(error.type).toBe(EventType.RUN_ERROR);
    expect(error.code).toBe("turn_failed");
    expect(error.message).not.toBe("");
    // The person's message and the reason are both in the record, so a reload still shows them.
    expect(fake.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(fake.messages[1]?.parts).toEqual([{ type: "error", text: error.message }]);
    expect(fake.messages[1]?.template).toBe(`${ANALYST_URI}@1`);
    expect(fake.conversation.status.activeTurn).toBeUndefined();
  });

  const turnState = (model: { doStreamCalls: Array<{ prompt: unknown }> }) => {
    const prompt = model.doStreamCalls[0]?.prompt as Array<{ role: string; content: unknown }>;
    return JSON.stringify(prompt.at(-1)?.content);
  };

  test("an add-on that cannot be reached does not stop the turn, and the agent is told", async () => {
    const { app, fake, model } = makeApp(
      [{ text: "The bio tools are down right now." }],
      {},
      {
        mcpServer: { url: "http://127.0.0.1:9/nowhere" },
        template: { mcpServers: [{ server: `texera://mcp-servers/${MCP_RID}` }] },
      },
    );
    const events = await readSse(await post(app, runInput("Find papers on Cas9.")));
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(events.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
    expect(fake.messages.at(-1)?.parts.at(-1)?.text).toBe("The bio tools are down right now.");
    expect(turnState(model)).toContain("Not available in this turn: the texera tools");
  });

  test("the agent is told the date and the computing unit this chat's runs use", async () => {
    const { app, model } = makeApp(
      [{ text: "On alice's unit." }],
      {},
      { conversationUnit: { name: "alice's unit", phase: "ready" } },
    );
    await readSse(await post(app, runInput("Where will this run?")));
    const state = turnState(model);
    expect(state).toContain("## Turn state");
    expect(state).toContain("Today is 2026-11-05.");
    expect(state).toContain(`Computing unit: alice's unit (${UNIT_URI}), ready.`);
  });

  test("a chat without a unit says nothing about one", async () => {
    const { app, model } = makeApp([{ text: "Hello." }]);
    await readSse(await post(app, runInput("Hi")));
    expect(turnState(model)).toContain("Today is 2026-11-05.");
    expect(turnState(model)).not.toContain("Computing unit");
  });

  const withAttachment = (content: unknown[]) => ({
    ...runInput("x"),
    messages: [{ id: "m1", role: "user", content }],
  });
  const iris = {
    type: "binary",
    mimeType: "application/vnd.texera.resource",
    url: "texera://datasets/d1@1",
    filename: "iris.csv",
  };

  test("an attachment is kept as a resource of the person's message, and the model is told", async () => {
    const { app, fake, model } = makeApp([{ text: "It has flowers." }]);
    const events = await readSse(
      await post(app, withAttachment([{ type: "text", text: "What is in this file?" }, iris])),
    );
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(fake.messages[0]?.parts).toEqual([
      { type: "text", text: "What is in this file?" },
      { type: "resource", resource: "texera://datasets/d1@1", text: "iris.csv" },
    ]);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
      'Attached dataset \\"iris.csv\\" (texera://datasets/d1@1)',
    );
  });

  test("an attachment alone is a message", async () => {
    const { app, fake } = makeApp([{ text: "Got it." }]);
    const events = await readSse(await post(app, withAttachment([iris])));
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(fake.messages[0]?.parts).toEqual([
      { type: "resource", resource: "texera://datasets/d1@1", text: "iris.csv" },
    ]);
  });

  test("binary content that names no catalog resource is not an attachment", async () => {
    const { app, fake } = makeApp([]);
    const foreign = { type: "binary", mimeType: "image/png", url: "https://example.com/a.png" };
    const events = await readSse(await post(app, withAttachment([foreign])));
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "bad_request" });
    expect(fake.messages).toEqual([]);
  });

  test("serves the A2A agent card of a template and answers message/send", async () => {
    const { app } = makeApp([{ text: "pong" }]);
    const card = await app.request(`/agents/templates/${TEMPLATE_RID}/.well-known/agent-card.json`, {
      headers: { authorization: "Bearer user-token" },
    });
    expect(card.status).toBe(200);
    const cardBody = (await card.json()) as { name: string; supportedInterfaces: Array<{ url: string }> };
    expect(cardBody.name).toBe("Data Analyst");
    expect(cardBody.supportedInterfaces[0]?.url).toBe(`http://gateway/agents/templates/${TEMPLATE_RID}/a2a`);

    const rpc = await app.request(`/agents/templates/${BIO_TEMPLATE_RID}/a2a`, {
      method: "POST",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: { messageId: "m1", contextId: CONVERSATION_RID, role: "ROLE_USER", parts: [{ text: "ping" }] },
        },
      }),
    });
    expect(rpc.status).toBe(200);
    expect(JSON.stringify(await rpc.json())).toContain("pong");
  });

  test("healthz answers", async () => {
    const { app } = makeApp([{ text: "x" }]);
    expect(await (await app.request("/healthz")).json()).toEqual({ status: "ok" });
  });
});
