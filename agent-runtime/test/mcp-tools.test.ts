import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connectionFor, mountMcpBindings } from "../src/agent/mcp-tools.ts";
import type { McpServerRecord } from "../src/catalog/types.ts";

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

const builtin: McpServerRecord = {
  rid: "mcp-1",
  name: "texera",
  spec: { transport: "streamable_http", builtin: true },
};

describe("connectionFor", () => {
  test("the built-in server is the gateway's /mcp with the person's token", () => {
    const { url, headers } = connectionFor(builtin, "tok", "http://localhost:8088/");
    expect(url).toBe("http://localhost:8088/mcp");
    expect(headers.Authorization).toBe("Bearer tok");
  });

  test("an external server keeps its own Authorization header", () => {
    const external: McpServerRecord = {
      rid: "mcp-2",
      name: "bio",
      spec: {
        transport: "streamable_http",
        url: "https://bio.example/mcp",
        headers: { Authorization: "Bearer other" },
      },
    };
    const { url, headers } = connectionFor(external, "tok", "http://localhost:8088");
    expect(url).toBe("https://bio.example/mcp");
    expect(headers.Authorization).toBe("Bearer other");
  });

  test("an external server never receives the person's token", () => {
    const external: McpServerRecord = {
      rid: "mcp-4",
      name: "facts",
      spec: { transport: "streamable_http", url: "http://localhost:23010/mcp" },
    };
    const { headers } = connectionFor(external, "tok", "http://localhost:8088");
    expect(headers.Authorization).toBeUndefined();
  });

  test("stdio servers are refused for now", () => {
    const stdio: McpServerRecord = { rid: "mcp-3", name: "local", spec: { transport: "stdio", command: ["x"] } };
    expect(() => connectionFor(stdio, "tok", "http://g")).toThrow(/sandbox/);
  });
});

describe("mountMcpBindings", () => {
  test("mounts the tools of a bound server and applies the allow list", async () => {
    const { clientSide } = await inProcessServer("texera");
    const mount = await mountMcpBindings({
      bindings: [{ server: "mcp-1", allow: ["list_operators"] }],
      resolveServer: async () => builtin,
      userToken: "tok",
      publicUrl: "http://localhost:8088",
      transportFactory: () => clientSide,
    });
    expect(Object.keys(mount.tools)).toEqual(["list_operators"]);
    expect(mount.servers).toEqual([{ name: "texera", rid: "mcp-1", toolNames: ["list_operators"] }]);
    const tool = mount.tools.list_operators;
    const result = await tool?.execute?.({ group: "source" }, { toolCallId: "t", messages: [] } as never);
    expect(JSON.stringify(result)).toContain("CSVFileScan");
    await mount.close();
  });

  test("prefixes a colliding tool name with the server name", async () => {
    const a = await inProcessServer("alpha");
    const b = await inProcessServer("beta");
    const servers: Record<string, McpServerRecord> = {
      a: { rid: "a", name: "alpha", spec: { transport: "streamable_http", url: "http://a/mcp" } },
      b: { rid: "b", name: "beta", spec: { transport: "streamable_http", url: "http://b/mcp" } },
    };
    const mount = await mountMcpBindings({
      bindings: [{ server: "a" }, { server: "b", allow: ["run_workflow"] }],
      resolveServer: async (ref) => servers[ref] as McpServerRecord,
      userToken: "tok",
      publicUrl: "http://g",
      transportFactory: (server) => (server.rid === "a" ? a.clientSide : b.clientSide),
    });
    expect(Object.keys(mount.tools).sort()).toEqual(["beta__run_workflow", "list_operators", "run_workflow"]);
    await mount.close();
  });
});
