/**
 * End to end over HTTP with everything faked: the identity provider, the catalog and
 * the model. A turn with one tool call streams AG-UI events and persists both messages.
 */
import { describe, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { buildAgent } from "../src/agent/build.ts";
import { TurnContext } from "../src/agent/turn-context.ts";
import { AuthError } from "../src/auth/jwt.ts";
import { CatalogClient } from "../src/catalog/client.ts";
import type { RuntimeConfig } from "../src/config.ts";
import { AgentHost } from "../src/host/agent-host.ts";
import type { AgentInstance, Spawner } from "../src/host/spawner.ts";
import { silentLogger } from "../src/log.ts";
import { RESOURCE_EVENT } from "../src/run/ag-ui-events.ts";
import { createApp } from "../src/server.ts";
import { CONVERSATION_RID, fakeCatalog, PID, TEMPLATE_RID } from "./helpers/fake-catalog.ts";
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
  llm: { provider: "anthropic", apiKey: "unused", defaultModel: "scripted" },
  maxSteps: 5,
  answerPolicy: "free",
};

/** A spawner whose agent runs a scripted model with one local tool. */
function scriptedSpawner(responses: ScriptedResponse[], tools: ToolSet): Spawner & { spawned: number } {
  const spawner = {
    spawned: 0,
    async spawn(ctx): Promise<AgentInstance> {
      spawner.spawned += 1;
      const template = {
        ref: ctx.record.template,
        name: "Data Analyst",
        spec: { card: { name: "Data Analyst", description: "d" } },
      };
      const built = buildAgent({
        template,
        skills: [],
        model: scriptedModel(responses),
        maxSteps: 5,
        extraTools: tools,
      });
      return {
        pid: ctx.pid,
        template,
        conversation: ctx.record.conversation,
        built,
        userToken: ctx.auth.userToken,
        turn: new TurnContext(ctx.pid),
        createdAt: Date.now(),
        close: async () => {},
      };
    },
  } satisfies Spawner & { spawned: number };
  return spawner;
}

function makeApp(spawner: Spawner) {
  const fake = fakeCatalog();
  const catalog = new CatalogClient({ baseUrl: "http://catalog", fetch: fake.fetch });
  const app = createApp({
    config,
    log: silentLogger,
    catalog,
    host: new AgentHost(spawner),
    verifyUser: async (token) => {
      if (token !== "user-token") throw new AuthError("bad token");
      return { subject: "alice", token, claims: {} };
    },
    serviceTokens: { get: async () => "service-token", invalidate() {} },
    newId: () => "fixed-id",
  });
  return { app, fake };
}

async function readSse(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as { type: string } & Record<string, unknown>);
}

const runInput = (text: string) => ({
  threadId: CONVERSATION_RID,
  runId: "run-1",
  messages: [{ id: "m1", role: "user", content: text }],
  tools: [],
  context: [],
  state: {},
});

describe("POST /agents/:pid/ag-ui", () => {
  test("streams a full turn with a tool call and persists both messages", async () => {
    const getResource = tool({
      description: "get",
      inputSchema: z.object({ rid: z.string() }),
      execute: async ({ rid }) => ({
        apiVersion: "catalog.texera.apache.org/v1",
        kind: "workflow",
        metadata: { rid, headVersion: 2, name: "penguins" },
        spec: {},
      }),
    });
    const spawner = scriptedSpawner(
      [
        { toolCalls: [{ id: "c1", toolName: "get_resource", input: { rid: WORKFLOW_RID } }] },
        { text: "The workflow has two operators." },
      ],
      { get_resource: getResource },
    );
    const { app, fake } = makeApp(spawner);
    const res = await app.request(`/agents/${PID}/ag-ui`, {
      method: "POST",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      body: JSON.stringify(runInput("Describe the workflow")),
    });
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
    expect(resource).toMatchObject({ name: RESOURCE_EVENT, value: { kind: "workflow", rid: WORKFLOW_RID, vno: 2 } });
    expect(events.filter((e) => e.type === EventType.STEP_STARTED)).toHaveLength(2);

    // The catalog holds the user message and the assistant message with every part.
    expect(fake.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const assistant = fake.messages[1];
    const kinds = assistant?.parts.map((p) => p.type);
    expect(kinds).toEqual(["tool_call", "tool_result", "resource", "text"]);
    expect(assistant?.parts[3]?.text).toBe("The workflow has two operators.");
    expect(assistant?.parts[2]?.resource).toEqual({ kind: "workflow", rid: WORKFLOW_RID, vno: 2 });
    // Every catalog call carried the delegation headers.
    for (const call of fake.calls) {
      expect(call.headers.authorization).toBe("Bearer user-token");
      expect(call.headers["x-texera-agent"]).toBe(PID);
      expect(call.headers["x-texera-service-token"]).toBe("service-token");
    }
    // The agent record was read for the template, pinned at its version.
    expect(fake.calls[0]?.path).toBe(`/catalog/v1/agents/${PID}`);
    expect(spawner.spawned).toBe(1);
  });

  test("reuses the live agent across turns and rebuilds it when the token changes", async () => {
    const spawner = scriptedSpawner([{ text: "one" }, { text: "two" }, { text: "three" }], {});
    const { app } = makeApp(spawner);
    const post = (token: string) =>
      app.request(`/agents/${PID}/ag-ui`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(runInput("hi")),
      });
    expect((await post("user-token")).status).toBe(200);
    expect((await post("user-token")).status).toBe(200);
    expect(spawner.spawned).toBe(1);
  });

  test("rejects missing and invalid tokens, unknown agents and bad input", async () => {
    const { app } = makeApp(scriptedSpawner([{ text: "x" }], {}));
    const body = JSON.stringify(runInput("hi"));
    const headers = { "content-type": "application/json" };
    expect((await app.request(`/agents/${PID}/ag-ui`, { method: "POST", headers, body })).status).toBe(401);
    expect(
      (
        await app.request(`/agents/${PID}/ag-ui`, {
          method: "POST",
          headers: { ...headers, authorization: "Bearer nope" },
          body,
        })
      ).status,
    ).toBe(401);
    const unknown = await app.request("/agents/unknown/ag-ui", {
      method: "POST",
      headers: { ...headers, authorization: "Bearer user-token" },
      body,
    });
    expect(unknown.status).toBe(404);
    const bad = await app.request(`/agents/${PID}/ag-ui`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer user-token" },
      body: "{}",
    });
    expect(bad.status).toBe(400);
  });

  test("a run without a user message ends with RUN_ERROR", async () => {
    const { app, fake } = makeApp(scriptedSpawner([{ text: "x" }], {}));
    const res = await app.request(`/agents/${PID}/ag-ui`, {
      method: "POST",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      body: JSON.stringify({ ...runInput("hi"), messages: [] }),
    });
    const events = await readSse(res);
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR]);
    expect(fake.messages).toHaveLength(0);
  });

  test("serves the A2A agent card and answers message/send", async () => {
    const { app } = makeApp(scriptedSpawner([{ text: "pong" }], {}));
    const card = await app.request(`/agents/${PID}/.well-known/agent-card.json`, {
      headers: { authorization: "Bearer user-token" },
    });
    expect(card.status).toBe(200);
    const cardBody = (await card.json()) as { name: string; supportedInterfaces: Array<{ url: string }> };
    expect(cardBody.name).toBe("Data Analyst");
    expect(cardBody.supportedInterfaces[0]?.url).toBe(`http://gateway/agents/${PID}/a2a`);

    const rpc = await app.request(`/agents/${PID}/a2a`, {
      method: "POST",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "ping" }] } },
      }),
    });
    expect(rpc.status).toBe(200);
    const reply = (await rpc.json()) as { result?: unknown; error?: unknown };
    expect(JSON.stringify(reply)).toContain("pong");
  });

  test("healthz reports the number of live agents", async () => {
    const { app } = makeApp(scriptedSpawner([{ text: "x" }], {}));
    const res = await app.request("/healthz");
    expect(await res.json()).toEqual({ status: "ok", agents: 0 });
  });
});

describe("template pinning", () => {
  test("the agent record names the template version", () => {
    expect(fakeCatalog().agent.template).toEqual({ rid: TEMPLATE_RID, vno: 1 });
  });
});
