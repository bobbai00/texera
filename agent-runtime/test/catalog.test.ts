import { describe, expect, test } from "bun:test";
import { CatalogClient, CatalogError, stripFrontmatter } from "../src/catalog/client.ts";
import { parseRef } from "../src/catalog/types.ts";
import { CONVERSATION_RID, fakeCatalog, MCP_RID, PID, SKILL_RID, TEMPLATE_RID } from "./helpers/fake-catalog.ts";

const auth = { userToken: "user-token", agentPid: PID, serviceToken: "service-token" };

describe("CatalogClient", () => {
  test("sends the person's token and the agent headers on every call", async () => {
    const fake = fakeCatalog();
    const client = new CatalogClient({ baseUrl: "http://catalog", fetch: fake.fetch });
    const agent = await client.getAgent(PID, auth);
    expect(agent.conversation).toBe(CONVERSATION_RID);
    const call = fake.calls[0];
    expect(call?.path).toBe(`/catalog/v1/agents/${PID}`);
    expect(call?.headers.authorization).toBe("Bearer user-token");
    expect(call?.headers["x-texera-agent"]).toBe(PID);
    expect(call?.headers["x-texera-service-token"]).toBe("service-token");
  });

  test("loads a template at the head and at a pinned version", async () => {
    const pinned = { card: { name: "Old", description: "v1" }, model: { name: "scripted" } };
    const fake = fakeCatalog({ templateVersions: { 1: pinned, 2: { card: { name: "New", description: "v2" } } } });
    const client = new CatalogClient({ baseUrl: "http://catalog", fetch: fake.fetch });
    const head = await client.getTemplate({ rid: TEMPLATE_RID, vno: 2 }, auth);
    expect(head.ref).toEqual({ rid: TEMPLATE_RID, vno: 2 });
    expect(head.spec.card.name).toBe("Data Analyst");
    const old = await client.getTemplate({ rid: TEMPLATE_RID, vno: 1 }, auth);
    expect(old.ref.vno).toBe(1);
    expect(old.spec.card.name).toBe("Old");
  });

  test("reads MCP servers, skills and messages, and posts messages", async () => {
    const fake = fakeCatalog({
      mcpServer: { transport: "streamable_http", builtin: true },
      skill: {
        spec: { name: "csv-analysis", description: "How to profile CSVs" },
        markdown: "---\nname: csv-analysis\n---\n# Steps\nLook at the header.",
      },
    });
    const client = new CatalogClient({ baseUrl: "http://catalog/", fetch: fake.fetch });
    const server = await client.getMcpServer(`${MCP_RID}@1`, auth);
    expect(server.spec.builtin).toBe(true);
    const skill = await client.getSkill(SKILL_RID, auth);
    expect(skill.body).toBe("# Steps\nLook at the header.");
    const posted = await client.postMessage(
      CONVERSATION_RID,
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      auth,
    );
    expect(posted.seq).toBe(1);
    const history = await client.listMessages(CONVERSATION_RID, auth);
    expect(history).toHaveLength(1);
    expect(await client.listMessages(CONVERSATION_RID, auth, 1)).toHaveLength(0);
  });

  test("turns catalog errors into CatalogError with status and code", async () => {
    const fake = fakeCatalog();
    const client = new CatalogClient({ baseUrl: "http://catalog", fetch: fake.fetch });
    const err = await client.getAgent("missing", auth).catch((e) => e);
    expect(err).toBeInstanceOf(CatalogError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
  });

  test("parses references and strips frontmatter", () => {
    expect(parseRef("abc")).toEqual({ rid: "abc" });
    expect(parseRef("abc@7")).toEqual({ rid: "abc", vno: 7 });
    expect(() => parseRef("abc@x")).toThrow();
    expect(stripFrontmatter("no frontmatter")).toBe("no frontmatter");
    expect(stripFrontmatter("---\na: 1\n---\nbody")).toBe("body");
  });
});
