/**
 * Mounts MCP servers as AI SDK tools. The platform's own servers (catalog, dataflow) are
 * reached through the gateway with the person's token and the turn's origin headers, so the
 * catalog's PDP applies the person's permissions and records the turn on what the tools
 * create. Any other server gets the headers its resource configures, with `credential:<uri>`
 * values replaced by the leased secret, and nothing else.
 *
 * The platform's servers are an agent's basic tools: without them it cannot work, so a failure to
 * mount one fails the turn. Every other server is an add-on: one that cannot be reached, does not
 * answer in time or whose credential cannot be leased is left out and named, and the turn goes on
 * with the rest.
 */
import { createMCPClient, type MCPClient, type MCPTransport } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import type { McpBinding, McpServerRecord } from "../catalog/types.ts";
import type { TurnContext } from "./turn-context.ts";

export interface McpMountOptions {
  bindings: McpBinding[];
  resolveServer: (uri: string) => Promise<McpServerRecord>;
  /** Leases a credential and returns its fields. */
  leaseCredential: (uri: string) => Promise<Record<string, string>>;
  /** The person's bearer token, sent to the platform's servers only. */
  userToken: string;
  /** The gateway URL; the platform's servers live under `${publicUrl}/mcp`. */
  publicUrl: string;
  /** The turn's origin headers, sent to the platform's servers only. */
  turn: TurnContext;
  /** Supplies a transport instead of Streamable HTTP; tests use an in-memory one. */
  transportFactory?: (
    server: McpServerRecord,
    url: string,
    headers: Record<string, string>,
  ) => MCPTransport | undefined;
  /** How long an add-on may take to connect and list its tools; default 10 s. */
  addOnTimeoutMs?: number;
}

/** An add-on server left out of a turn, and why. */
export interface UnavailableServer {
  name: string;
  uri: string;
  reason: string;
}

export interface MountedServer {
  name: string;
  uri: string;
  toolNames: string[];
}

export interface McpMount {
  tools: ToolSet;
  servers: MountedServer[];
  /** The add-ons that could not be mounted. */
  unavailable: UnavailableServer[];
  close(): Promise<void>;
}

export const DEFAULT_ADD_ON_TIMEOUT_MS = 10_000;

/** Waits for a promise for at most `ms`; `late` runs on a value that arrives after the wait gave up. */
async function within<T>(promise: Promise<T>, ms: number, late?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gaveUp = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      gaveUp = true;
      reject(new Error(`no answer within ${ms} ms`));
    }, ms);
  });
  promise.then(
    (value) => {
      if (gaveUp) late?.(value);
    },
    () => {},
  );
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const CREDENTIAL = /^credential:(texera:\/\/credentials\/[0-9a-f-]{36})(?:#(.+))?$/i;

/** Resolves the headers of a server: credential references become leased values. */
export async function resolveHeaders(
  spec: McpServerRecord["spec"],
  leaseCredential: (uri: string) => Promise<Record<string, string>>,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    const m = CREDENTIAL.exec(value);
    if (!m?.[1]) {
      headers[name] = value;
      continue;
    }
    const fields = await leaseCredential(m[1]);
    const field = m[2] ?? "value";
    const resolved = fields[field];
    if (resolved === undefined) throw new Error(`credential ${m[1]} has no field ${field}`);
    headers[name] = resolved;
  }
  return headers;
}

/** The URL and headers for a server. */
export async function connectionFor(
  server: McpServerRecord,
  options: Pick<McpMountOptions, "userToken" | "publicUrl" | "turn" | "leaseCredential">,
): Promise<{ url: string; headers: Record<string, string>; builtin: boolean }> {
  const spec = server.spec;
  const builtin = !!spec.builtin;
  const url = builtin ? `${options.publicUrl.replace(/\/$/, "")}/mcp/${spec.builtin}` : spec.url;
  if (!url) throw new Error(`MCP server ${server.name} has no url`);
  const headers = await resolveHeaders(spec, options.leaseCredential);
  if (builtin) {
    headers.Authorization = `Bearer ${options.userToken}`;
    Object.assign(headers, options.turn.headers());
  }
  return { url, headers, builtin };
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "server";
}

export async function mountMcpBindings(options: McpMountOptions): Promise<McpMount> {
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};
  const servers: MountedServer[] = [];
  const unavailable: UnavailableServer[] = [];
  const timeout = options.addOnTimeoutMs ?? DEFAULT_ADD_ON_TIMEOUT_MS;
  try {
    for (const binding of options.bindings) {
      const server = await options.resolveServer(binding.server);
      const addOn = !server.spec.builtin;
      // An add-on gets a bounded wait; a client that connects after it is closed again.
      const bounded = <T>(work: Promise<T>, late?: (value: T) => void) => (addOn ? within(work, timeout, late) : work);
      try {
        const { url, headers } = await connectionFor(server, options);
        const transport = options.transportFactory?.(server, url, headers) ?? { type: "http" as const, url, headers };
        const client = await bounded(createMCPClient({ transport }), (late) => void late.close().catch(() => {}));
        clients.push(client);
        const all = await bounded(client.tools());
        const allow = binding.allow ? new Set(binding.allow) : undefined;
        const mounted: string[] = [];
        for (const [name, t] of Object.entries(all)) {
          if (allow && !allow.has(name)) continue;
          const key = name in tools ? `${sanitize(server.name)}__${name}` : name;
          tools[key] = t;
          mounted.push(key);
        }
        servers.push({ name: server.name, uri: server.uri, toolNames: mounted });
      } catch (err) {
        if (!addOn) throw err;
        unavailable.push({
          name: server.name,
          uri: server.uri,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    await Promise.allSettled(clients.map((c) => c.close()));
    throw err;
  }
  return {
    tools,
    servers,
    unavailable,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

/** The binding of a platform server, for templates that do not list it (the catalog server). */
export function builtinBinding(name: string, publicUrl: string): { record: McpServerRecord; binding: McpBinding } {
  const uri = `builtin://${name}`;
  const record: McpServerRecord = {
    uri,
    rid: "",
    name,
    spec: { url: `${publicUrl.replace(/\/$/, "")}/mcp/${name}`, builtin: name },
  };
  return { record, binding: { server: uri } };
}
