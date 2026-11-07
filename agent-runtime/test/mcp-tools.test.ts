import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connectionFor, mountMcpServers, resolveHeaders } from "../src/agent/mcp-tools.ts";
import { TurnContext } from "../src/agent/turn-context.ts";
import type { McpServerRecord, ServerSetting } from "../src/catalog/types.ts";

/** An in-process MCP server with two tools, linked to a client transport. */
async function inProcessServer(name: string) {
  const server = new McpServer({ name, version: "0.0.1" });
  server.registerTool(
    "list_operators",
    { description: "List operators", inputSchema: { group: z.string().optional() } },
    async ({ group }) => ({ content: [{ type: "text", text: JSON.stringify({ operators: ["CSVFileScan"], group }) }] }),
  );
  server.registerTool("run_workflow", { description: "Run", inputSchema: { rid: z.string() } }, async ({ rid }) => ({
    content: [{ type: "text", text: JSON.stringify({ eid: "e", rid }) }],
  }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return { server, clientSide };
}

const CRED = "texera://credentials/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const turn = new TurnContext("service-token", {
  conversation: "c",
  turn: "t",
  template: "texera://agent-templates/x@1",
});
const leaseCredential = async (uri: string): Promise<Record<string, string>> =>
  uri === CRED ? { value: "secret-key", user: "u" } : {};
const catalog: McpServerRecord = {
  uri: "texera://mcp-servers/d",
  rid: "d",
  name: "catalog",
  spec: { url: "https://texera.example.org/mcp/catalog" },
};
/** A server as the chat's settings list it: the platform's own, or an add-on. */
const listed = (server: McpServerRecord, platform: boolean, allow?: string[]): ServerSetting => ({
  uri: server.uri,
  name: server.name,
  from: "agent",
  platform,
  ...(allow ? { allow } : {}),
});

describe("connectionFor", () => {
  test("the platform's own server is reached at the gateway, on its path, with the person's token and the turn's headers", async () => {
    const { url, headers } = await connectionFor(catalog, true, {
      userToken: "tok",
      publicUrl: "http://localhost:8088/",
      turn,
      leaseCredential,
    });
    expect(url).toBe("http://localhost:8088/mcp/catalog");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["X-Texera-Service-Token"]).toBe("service-token");
    expect(headers["X-Texera-Origin"]).toBe("conversation=c;turn=t;template=texera://agent-templates/x@1");
  });

  test("an external server gets its configured headers, credential references leased, and never the person's token", async () => {
    const bio: McpServerRecord = {
      uri: "texera://mcp-servers/b",
      rid: "b",
      name: "biomcp",
      spec: {
        url: "http://localhost:8088/bio-mcp",
        headers: { "X-API-Key": `credential:${CRED}#value`, "X-Static": "yes" },
      },
    };
    const { url, headers } = await connectionFor(bio, false, {
      userToken: "tok",
      publicUrl: "http://localhost:8088",
      turn,
      leaseCredential,
    });
    expect(url).toBe("http://localhost:8088/bio-mcp");
    expect(headers).toEqual({ "X-API-Key": "secret-key", "X-Static": "yes" });
  });

  test("a missing credential field is an error", async () => {
    await expect(
      resolveHeaders({ url: "x", headers: { A: `credential:${CRED}#nope` } }, leaseCredential),
    ).rejects.toThrow(/no field nope/);
  });
});

describe("mountMcpServers", () => {
  test("mounts the tools of a listed server and applies the allow list", async () => {
    const { clientSide } = await inProcessServer("catalog");
    const mount = await mountMcpServers({
      servers: [listed(catalog, true, ["list_operators"])],
      resolveServer: async () => catalog,
      leaseCredential,
      userToken: "tok",
      publicUrl: "http://localhost:8088",
      turn,
      transportFactory: () => clientSide,
    });
    expect(Object.keys(mount.tools)).toEqual(["list_operators"]);
    expect(mount.servers).toEqual([{ name: "catalog", uri: catalog.uri, toolNames: ["list_operators"] }]);
    const tool = mount.tools.list_operators;
    const result = await tool?.execute?.({ group: "source" }, { toolCallId: "t", messages: [] } as never);
    expect(JSON.stringify(result)).toContain("CSVFileScan");
    await mount.close();
  });

  test("the platform's tools that its server does not mark read-only are its changes; an add-on has none", async () => {
    const server = new McpServer({ name: "catalog", version: "0.0.1" });
    server.registerTool(
      "get_resource",
      { description: "Read", inputSchema: { rid: z.string() }, annotations: { readOnlyHint: true } },
      async () => ({ content: [] }),
    );
    server.registerTool("create_workflow", { description: "Create", inputSchema: { name: z.string() } }, async () => ({
      content: [],
    }));
    const pair = () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      return { clientSide, ready: server.connect(serverSide) };
    };
    const platform = pair();
    await platform.ready;
    const asPlatform = await mountMcpServers({
      servers: [listed(catalog, true)],
      resolveServer: async () => catalog,
      leaseCredential,
      userToken: "tok",
      publicUrl: "http://localhost:8088",
      turn,
      transportFactory: () => platform.clientSide,
    });
    expect([...asPlatform.changes]).toEqual(["create_workflow"]);
    await asPlatform.close();

    const addOn = await inProcessServer("bio");
    const asAddOn = await mountMcpServers({
      servers: [listed(catalog, false)],
      resolveServer: async () => catalog,
      leaseCredential,
      userToken: "tok",
      publicUrl: "http://localhost:8088",
      turn,
      transportFactory: () => addOn.clientSide,
    });
    expect(Object.keys(asAddOn.tools).sort()).toEqual(["list_operators", "run_workflow"]);
    expect([...asAddOn.changes]).toEqual([]);
    await asAddOn.close();
  });

  /** A transport whose connection fails at once, or never comes up. */
  const dead = (hang = false) =>
    ({
      start: () => (hang ? new Promise<void>(() => {}) : Promise.reject(new Error("connect ECONNREFUSED"))),
      send: async () => {},
      close: async () => {},
    }) as never;
  const bio: McpServerRecord = {
    uri: "texera://mcp-servers/b",
    rid: "b",
    name: "biomcp",
    spec: { url: "http://bio/mcp" },
  };
  const both = {
    servers: [listed(bio, false), listed(catalog, true)],
    resolveServer: async (ref: string) => (ref === bio.uri ? bio : catalog),
    leaseCredential,
    userToken: "tok",
    publicUrl: "http://g",
    turn,
  };

  test("an add-on that cannot be reached is skipped and named, and the rest still mounts", async () => {
    const { clientSide } = await inProcessServer("catalog");
    const mount = await mountMcpServers({
      ...both,
      transportFactory: (server) => (server.rid === "b" ? dead() : clientSide),
    });
    expect(Object.keys(mount.tools).sort()).toEqual(["list_operators", "run_workflow"]);
    expect(mount.servers.map((s) => s.name)).toEqual(["catalog"]);
    expect(mount.unavailable).toEqual([
      { name: "biomcp", uri: bio.uri, reason: expect.stringContaining("ECONNREFUSED") },
    ]);
    await mount.close();
  });

  test("an add-on that does not answer in time is skipped", async () => {
    const { clientSide } = await inProcessServer("catalog");
    const started = Date.now();
    const mount = await mountMcpServers({
      ...both,
      addOnTimeoutMs: 40,
      transportFactory: (server) => (server.rid === "b" ? dead(true) : clientSide),
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(mount.servers.map((s) => s.name)).toEqual(["catalog"]);
    expect(mount.unavailable).toEqual([{ name: "biomcp", uri: bio.uri, reason: "no answer within 40 ms" }]);
    await mount.close();
  });

  test("an add-on whose credential cannot be leased is skipped", async () => {
    const { clientSide } = await inProcessServer("catalog");
    const keyed: McpServerRecord = {
      ...bio,
      spec: { url: "http://bio/mcp", headers: { "X-API-Key": `credential:${CRED}` } },
    };
    const mount = await mountMcpServers({
      ...both,
      resolveServer: async (ref: string) => (ref === bio.uri ? keyed : catalog),
      leaseCredential: async () => {
        throw new Error("409: no_secret");
      },
      transportFactory: () => clientSide,
    });
    expect(mount.servers.map((s) => s.name)).toEqual(["catalog"]);
    expect(mount.unavailable).toEqual([{ name: "biomcp", uri: bio.uri, reason: "409: no_secret" }]);
    await mount.close();
  });

  test("the platform's server that cannot be reached fails the mount: an agent cannot work without it", async () => {
    await expect(
      mountMcpServers({ ...both, servers: [listed(catalog, true)], transportFactory: () => dead() }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  test("everything mounted leaves nothing unavailable", async () => {
    const { clientSide } = await inProcessServer("catalog");
    const mount = await mountMcpServers({
      ...both,
      servers: [listed(catalog, true)],
      transportFactory: () => clientSide,
    });
    expect(mount.unavailable).toEqual([]);
    await mount.close();
  });

  test("prefixes a colliding tool name with the server name", async () => {
    const a = await inProcessServer("alpha");
    const b = await inProcessServer("beta");
    const servers: Record<string, McpServerRecord> = {
      a: { uri: "a", rid: "a", name: "alpha", spec: { url: "http://a/mcp" } },
      b: { uri: "b", rid: "b", name: "beta", spec: { url: "http://b/mcp" } },
    };
    const mount = await mountMcpServers({
      servers: [
        listed(servers.a as McpServerRecord, false),
        listed(servers.b as McpServerRecord, false, ["run_workflow"]),
      ],
      resolveServer: async (ref) => servers[ref] as McpServerRecord,
      leaseCredential,
      userToken: "tok",
      publicUrl: "http://g",
      turn,
      transportFactory: (server) => (server.rid === "a" ? a.clientSide : b.clientSide),
    });
    expect(Object.keys(mount.tools).sort()).toEqual(["beta__run_workflow", "list_operators", "run_workflow"]);
    await mount.close();
  });
});
