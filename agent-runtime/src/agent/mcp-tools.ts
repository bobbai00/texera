/**
 * Mounts the MCP servers a template binds as AI SDK tools. The built-in Texera server
 * is reached through the gateway with the person's own token, so the catalog's PDP
 * applies the person's permissions to every tool call.
 */
import { createMCPClient, type MCPClient, type MCPTransport } from "@ai-sdk/mcp";
import type { McpBinding } from "@texera/catalog-client/types";
import type { ToolSet } from "ai";
import type { McpServerRecord } from "../catalog/types.ts";
import { fetchWithTurnHeaders, type TurnContext } from "./turn-context.ts";

export interface McpMountOptions {
  bindings: McpBinding[];
  resolveServer: (reference: string) => Promise<McpServerRecord>;
  /** The person's bearer token, sent to the built-in server only. */
  userToken: string;
  /** The gateway URL; the built-in server lives at `${publicUrl}/mcp`. */
  publicUrl: string;
  /** Per-turn agent and origin headers, sent to the built-in server only. */
  turn?: TurnContext;
  /** Supplies a transport instead of Streamable HTTP; tests use an in-memory one. */
  transportFactory?: (
    server: McpServerRecord,
    url: string,
    headers: Record<string, string>,
  ) => MCPTransport | undefined;
}

export interface MountedServer {
  name: string;
  rid: string;
  toolNames: string[];
}

export interface McpMount {
  tools: ToolSet;
  servers: MountedServer[];
  close(): Promise<void>;
}

/** Resolves the URL and headers for a binding. */
export function connectionFor(
  server: McpServerRecord,
  userToken: string,
  publicUrl: string,
): { url: string; headers: Record<string, string> } {
  const spec = server.spec;
  if (spec.transport === "stdio") {
    throw new Error(`MCP server ${server.name}: stdio servers run inside a sandbox and are not supported yet`);
  }
  const url = spec.builtin ? `${publicUrl.replace(/\/$/, "")}/mcp` : spec.url;
  if (!url) throw new Error(`MCP server ${server.name} has no url`);
  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  // Only the built-in server receives the person's Texera token; a third-party server gets the
  // headers its MCP Server resource configures and nothing else.
  if (spec.builtin) headers.Authorization = `Bearer ${userToken}`;
  return { url, headers };
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "server";
}

export async function mountMcpBindings(options: McpMountOptions): Promise<McpMount> {
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};
  const servers: MountedServer[] = [];
  try {
    for (const binding of options.bindings) {
      const server = await options.resolveServer(binding.server);
      const { url, headers } = connectionFor(server, options.userToken, options.publicUrl);
      const fetch = server.spec.builtin && options.turn ? fetchWithTurnHeaders(options.turn) : undefined;
      const transport = options.transportFactory?.(server, url, headers) ?? {
        type: "http" as const,
        url,
        headers,
        fetch,
      };
      const client = await createMCPClient({ transport });
      clients.push(client);
      const all = await client.tools();
      const allow = binding.allow ? new Set(binding.allow) : undefined;
      const mounted: string[] = [];
      for (const [name, t] of Object.entries(all)) {
        if (allow && !allow.has(name)) continue;
        const key = name in tools ? `${sanitize(server.name)}__${name}` : name;
        tools[key] = t;
        mounted.push(key);
      }
      servers.push({ name: server.name, rid: server.rid, toolNames: mounted });
    }
  } catch (err) {
    await Promise.allSettled(clients.map((c) => c.close()));
    throw err;
  }
  return {
    tools,
    servers,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
