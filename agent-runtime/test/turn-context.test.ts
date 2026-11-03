import { describe, expect, test } from "bun:test";
import { fetchWithTurnHeaders, TurnContext } from "../src/agent/turn-context.ts";

describe("TurnContext", () => {
  test("headers name the agent, the service token and the turn origin", () => {
    const ctx = new TurnContext("agent-1");
    expect(ctx.headers()).toEqual({ "X-Texera-Agent": "agent-1" });
    ctx.begin("svc", { conversation: "conv-1", seq: 4 });
    expect(ctx.headers()).toEqual({
      "X-Texera-Agent": "agent-1",
      "X-Texera-Service-Token": "svc",
      "X-Texera-Origin": "conv-1:4",
    });
  });

  test("the fetch wrapper reads the context at request time", async () => {
    const ctx = new TurnContext("agent-1");
    const seen: Headers[] = [];
    const base = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}");
    }) as typeof fetch;
    const f = fetchWithTurnHeaders(ctx, base);
    await f("http://x/mcp", { headers: { Authorization: "Bearer u" } });
    ctx.begin("svc", { conversation: "c", seq: 9 });
    await f("http://x/mcp", { headers: { Authorization: "Bearer u" } });
    expect(seen[0]?.get("x-texera-origin")).toBeNull();
    expect(seen[0]?.get("authorization")).toBe("Bearer u");
    expect(seen[1]?.get("x-texera-origin")).toBe("c:9");
    expect(seen[1]?.get("x-texera-service-token")).toBe("svc");
  });
});
