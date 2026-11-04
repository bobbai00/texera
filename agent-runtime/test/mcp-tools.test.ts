import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { builtinBinding, connectionFor, mountMcpBindings, resolveHeaders } from "../src/agent/mcp-tools.ts";
import { TurnContext } from "../src/agent/turn-context.ts";
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

const CRED = "texera://credentials/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const turn = new TurnContext("service-token", {
  conversation: "c",
  turn: "t",
  template: "texera://agent-templates/x@1",
});
const leaseCredential = async (uri: string): Promise<Record<string, string>> =>
  uri === CRED ? { value: "secret-key", user: "u" } : {};
const dataflow: McpServerRecord = {
  uri: "texera://mcp-servers/d",
  rid: "d",
  name: "dataflow",
  spec: { url: "http://localhost:8090/mcp/dataflow", builtin: "dataflow" },
};

describe("connectionFor", () => {
  test("a platform server is the gateway's /mcp/<name> with the person's token and the turn's headers", async () => {
    const { url, headers, builtin } = await connectionFor(dataflow, {
      userToken: "tok",
      publicUrl: "http://localhost:8088/",
      turn,
      leaseCredential,
    });
    expect(builtin).toBe(true);
    expect(url).toBe("http://localhost:8088/mcp/dataflow");
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
    const { url, headers, builtin } = await connectionFor(bio, {
      userToken: "tok",
      publicUrl: "http://localhost:8088",
      turn,
      leaseCredential,
    });
    expect(builtin).toBe(false);
    expect(url).toBe("http://localhost:8088/bio-mcp");
    expect(headers).toEqual({ "X-API-Key": "secret-key", "X-Static": "yes" });
  });

  test("a missing credential field is an error", async () => {
    await expect(
      resolveHeaders({ url: "x", headers: { A: `credential:${CRED}#nope` } }, leaseCredential),
    ).rejects.toThrow(/no field nope/);
  });

  test("the catalog server binding every template mounts", () => {
    const { record, binding } = builtinBinding("catalog", "http://g/");
    expect(binding.server).toBe(record.uri);
    expect(record.spec).toEqual({ url: "http://g/mcp/catalog", builtin: "catalog" });
  });
});

describe("mountMcpBindings", () => {
  test("mounts the tools of a bound server and applies the allow list", async () => {
    const { clientSide } = await inProcessServer("dataflow");
    const mount = await mountMcpBindings({
      bindings: [{ server: dataflow.uri, allow: ["list_operators"] }],
      resolveServer: async () => dataflow,
      leaseCredential,
      userToken: "tok",
      publicUrl: "http://localhost:8088",
      turn,
      transportFactory: () => clientSide,
    });
    expect(Object.keys(mount.tools)).toEqual(["list_operators"]);
    expect(mount.servers).toEqual([{ name: "dataflow", uri: dataflow.uri, toolNames: ["list_operators"] }]);
    const tool = mount.tools.list_operators;
    const result = await tool?.execute?.({ group: "source" }, { toolCallId: "t", messages: [] } as never);
    expect(JSON.stringify(result)).toContain("CSVFileScan");
    await mount.close();
  });

  test("prefixes a colliding tool name with the server name", async () => {
    const a = await inProcessServer("alpha");
    const b = await inProcessServer("beta");
    const servers: Record<string, McpServerRecord> = {
      a: { uri: "a", rid: "a", name: "alpha", spec: { url: "http://a/mcp" } },
      b: { uri: "b", rid: "b", name: "beta", spec: { url: "http://b/mcp" } },
    };
    const mount = await mountMcpBindings({
      bindings: [{ server: "a" }, { server: "b", allow: ["run_workflow"] }],
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
