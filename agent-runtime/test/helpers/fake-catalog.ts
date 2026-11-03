/**
 * An in-memory stand-in for the catalog, served through a `fetch` function, so the
 * runtime's catalog client and the HTTP handlers can be tested without a server.
 */
import type {
  Agent,
  AgentTemplateSpec,
  McpServerSpec,
  Message,
  PostMessage,
  SkillSpec,
} from "@texera/catalog-client/types";

export const PID = "11111111-1111-4111-8111-111111111111";
export const TEMPLATE_RID = "22222222-2222-4222-8222-222222222222";
export const CONVERSATION_RID = "33333333-3333-4333-8333-333333333333";
export const MCP_RID = "44444444-4444-4444-8444-444444444444";
export const SKILL_RID = "55555555-5555-4555-8555-555555555555";
export const USER_PID = "66666666-6666-4666-8666-666666666666";

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface FakeCatalogOptions {
  template?: Partial<AgentTemplateSpec>;
  templateVersions?: Record<number, AgentTemplateSpec>;
  mcpServer?: McpServerSpec;
  skill?: { spec: SkillSpec; markdown: string };
  agent?: Partial<Agent>;
}

export function fakeCatalog(options: FakeCatalogOptions = {}) {
  const calls: RecordedCall[] = [];
  const messages: Message[] = [];
  const templateSpec: AgentTemplateSpec = {
    card: { name: "Data Analyst", description: "Analyzes data with workflows" },
    model: { name: "scripted" },
    prompts: { system: "You analyze data." },
    ...options.template,
  };
  const agent: Agent = {
    pid: PID,
    template: { rid: TEMPLATE_RID, vno: 1 },
    conversation: CONVERSATION_RID,
    lifetime: "conversation",
    status: "active",
    createdAt: new Date().toISOString(),
    ...options.agent,
  };
  const envelope = (rid: string, name: string, kind: string, spec: unknown, headVersion = 1) => ({
    apiVersion: "catalog.texera.apache.org/v1",
    kind,
    metadata: {
      rid,
      name,
      headVersion,
      owner: USER_PID,
      visibility: "private",
      createdBy: USER_PID,
      createdAt: "",
      updatedAt: "",
    },
    spec,
  });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, headers, body });
    if (!headers.authorization?.startsWith("Bearer "))
      return json(401, { code: "unauthenticated", message: "no token" });

    const p = url.pathname;
    if (p === `/catalog/v1/agents/${PID}`) return json(200, agent);
    if (p.startsWith("/catalog/v1/agents/")) return json(404, { code: "not_found", message: "no such agent" });
    if (p === `/catalog/v1/agent-templates/${TEMPLATE_RID}`) {
      const head = Math.max(1, ...Object.keys(options.templateVersions ?? {}).map(Number));
      return json(200, envelope(TEMPLATE_RID, "Data Analyst", "agent_template", templateSpec, head));
    }
    const version = /^\/catalog\/v1\/resources\/([^/]+)\/versions\/(\d+)$/.exec(p);
    if (version) {
      const [, rid, vno] = version;
      if (rid === TEMPLATE_RID) {
        const content = options.templateVersions?.[Number(vno)] ?? templateSpec;
        return json(200, { rid, vno: Number(vno), contentKind: "json", content, createdBy: USER_PID, createdAt: "" });
      }
      if (rid === SKILL_RID && options.skill) {
        return json(200, {
          rid,
          vno: Number(vno),
          contentKind: "json",
          content: options.skill.markdown,
          createdBy: USER_PID,
          createdAt: "",
        });
      }
      return json(404, { code: "not_found", message: "no such version" });
    }
    if (p === `/catalog/v1/mcp-servers/${MCP_RID}` && options.mcpServer) {
      return json(200, envelope(MCP_RID, "texera", "mcp_server", options.mcpServer));
    }
    if (p === `/catalog/v1/skills/${SKILL_RID}` && options.skill) {
      return json(200, envelope(SKILL_RID, options.skill.spec.name, "skill", options.skill.spec));
    }
    if (p === `/catalog/v1/conversations/${CONVERSATION_RID}/messages`) {
      if (method === "GET") {
        const after = url.searchParams.get("after");
        return json(200, after ? messages.filter((m) => m.seq > Number(after)) : messages);
      }
      const post = body as PostMessage;
      const message: Message = {
        conversation: CONVERSATION_RID,
        seq: messages.length + 1,
        role: post.role,
        author: post.role === "user" ? USER_PID : PID,
        parts: post.parts,
        createdAt: new Date().toISOString(),
      };
      messages.push(message);
      return json(200, message);
    }
    return json(404, { code: "not_found", message: `no route ${method} ${p}` });
  };

  return { fetch: fetchImpl, calls, messages, agent, templateSpec };
}
