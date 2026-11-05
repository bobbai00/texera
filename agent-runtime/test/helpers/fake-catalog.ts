/**
 * An in-memory stand-in for the catalog, served through a `fetch` function, so the runtime's
 * catalog client and the HTTP handlers can be tested without a server. It speaks the v2
 * contract: conversations with turns and messages, resolve by URI, templates, skills, MCP
 * servers, model endpoints, credential leases.
 */
import type { AgentTemplateSpec, McpServerSpec, Message, SkillSpec } from "@texera/catalog-client/types";

export const CONVERSATION_RID = "33333333-3333-4333-8333-333333333333";
export const TEMPLATE_RID = "22222222-2222-4222-8222-222222222222";
export const BIO_TEMPLATE_RID = "99999999-9999-4999-8999-999999999999";
export const MCP_RID = "44444444-4444-4444-8444-444444444444";
export const SKILL_RID = "55555555-5555-4555-8555-555555555555";
export const USER_PID = "66666666-6666-4666-8666-666666666666";
export const MODEL_RID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CREDENTIAL_RID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const UNIT_RID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const UNIT_URI = `texera://computing-units/${UNIT_RID}`;

export const ANALYST_URI = `texera://agent-templates/${TEMPLATE_RID}`;
export const BIO_URI = `texera://agent-templates/${BIO_TEMPLATE_RID}`;
export const MODEL_URI = `texera://model-endpoints/${MODEL_RID}`;
export const CREDENTIAL_URI = `texera://credentials/${CREDENTIAL_RID}`;

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface FakeCatalogOptions {
  /** Overrides of the Data Analyst's spec. */
  template?: Partial<AgentTemplateSpec>;
  /** Older versions of the Data Analyst, by vno. */
  templateVersions?: Record<number, AgentTemplateSpec>;
  mcpServer?: McpServerSpec;
  skill?: SkillSpec;
  /** The conversation's template at the start; default the Data Analyst. */
  conversationTemplate?: string;
  /** The computing unit the conversation names, with its state. */
  conversationUnit?: { name: string; phase: string };
}

function envelope(kind: string, rid: string, name: string, spec: unknown, head = 1, status?: unknown) {
  const plural = `${kind}s`;
  return {
    apiVersion: "catalog.texera.apache.org/v1",
    kind,
    metadata: {
      rid,
      uri: `texera://${plural}/${rid}`,
      name,
      project: "00000000-0000-4000-8000-000000000000",
      owner: USER_PID,
      visibility: "public",
      head,
      etag: "e1",
      createdBy: USER_PID,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    spec,
    ...(status !== undefined ? { status } : {}),
  };
}

export function fakeCatalog(options: FakeCatalogOptions = {}) {
  const calls: RecordedCall[] = [];
  const messages: Message[] = [];
  const analyst: AgentTemplateSpec = {
    card: { name: "Data Analyst", description: "Analyzes data with workflows" },
    model: MODEL_URI,
    prompt: "You analyze data.",
    ...options.template,
  };
  const bio: AgentTemplateSpec = {
    card: { name: "Bio Researcher", description: "Grounds research ideas in the literature" },
    model: MODEL_URI,
    prompt: "You research biology.",
    handoffs: [ANALYST_URI],
    // Tests mount no MCP servers.
    catalogTools: false,
  };
  const analystHead = Math.max(1, ...Object.keys(options.templateVersions ?? {}).map(Number));
  const conversation = {
    spec: {
      template: options.conversationTemplate ?? ANALYST_URI,
      ...(options.conversationUnit ? { computingUnit: UNIT_URI } : {}),
    } as Record<string, unknown>,
    status: { messages: 0 } as Record<string, unknown>,
  };
  const leases: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const conversationEnvelope = () => ({
    ...envelope("conversation", CONVERSATION_RID, "chat", conversation.spec, 0),
    status: conversation.status,
  });

  const resources: Record<
    string,
    {
      kind: string;
      rid: string;
      name: string;
      spec: unknown;
      head: number;
      versions?: Record<number, unknown>;
      status?: unknown;
    }
  > = {
    [`agent-templates/${TEMPLATE_RID}`]: {
      kind: "agent-template",
      rid: TEMPLATE_RID,
      name: "Data Analyst",
      spec: analyst,
      head: analystHead,
      versions: options.templateVersions,
    },
    [`agent-templates/${BIO_TEMPLATE_RID}`]: {
      kind: "agent-template",
      rid: BIO_TEMPLATE_RID,
      name: "Bio Researcher",
      spec: bio,
      head: 1,
    },
    [`model-endpoints/${MODEL_RID}`]: {
      kind: "model-endpoint",
      rid: MODEL_RID,
      name: "scripted",
      spec: { provider: "anthropic", model: "scripted", credential: CREDENTIAL_URI },
      head: 0,
    },
    [`credentials/${CREDENTIAL_RID}`]: {
      kind: "credential",
      rid: CREDENTIAL_RID,
      name: "key",
      spec: { kind: "api_key" },
      head: 0,
    },
  };
  if (options.mcpServer)
    resources[`mcp-servers/${MCP_RID}`] = {
      kind: "mcp-server",
      rid: MCP_RID,
      name: "texera",
      spec: options.mcpServer,
      head: 1,
    };
  if (options.conversationUnit)
    resources[`computing-units/${UNIT_RID}`] = {
      kind: "computing-unit",
      rid: UNIT_RID,
      name: options.conversationUnit.name,
      spec: { provider: "static" },
      head: 0,
      status: { phase: options.conversationUnit.phase },
    };
  if (options.skill)
    resources[`skills/${SKILL_RID}`] = {
      kind: "skill",
      rid: SKILL_RID,
      name: options.skill.name,
      spec: options.skill,
      head: 1,
    };

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
    if (p === "/catalog/v1/resources/resolve") {
      const uri = url.searchParams.get("uri") ?? "";
      const m = /^texera:\/\/([a-z-]+)\/([0-9a-f-]{36})(?:@(\d+))?$/i.exec(uri);
      const r = m ? resources[`${m[1]}/${m[2]}`] : undefined;
      if (!m || !r) return json(404, { code: "not_found", message: `no resource ${uri}` });
      const out: Record<string, unknown> = { resource: envelope(r.kind, r.rid, r.name, r.spec, r.head, r.status) };
      if (m[3]) {
        const vno = Number(m[3]);
        const content = vno === r.head ? r.spec : r.versions?.[vno];
        if (!content) return json(404, { code: "not_found", message: `no version ${vno}` });
        out.version = {
          rid: r.rid,
          uri: `${uri}`,
          kind: r.kind,
          vno,
          contentKind: "spec",
          digest: "sha256:x",
          content,
          createdBy: USER_PID,
          createdAt: "",
        };
      }
      return json(200, out);
    }
    if (p === "/catalog/v1/agent-templates" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const items = [resources[`agent-templates/${TEMPLATE_RID}`], resources[`agent-templates/${BIO_TEMPLATE_RID}`]]
        .filter((r): r is NonNullable<typeof r> => !!r && (!q || r.name.toLowerCase().includes(q)))
        .map((r) => envelope(r.kind, r.rid, r.name, r.spec, r.head));
      return json(200, { items });
    }
    if (p === `/catalog/v1/credentials/${CREDENTIAL_RID}/lease` && method === "POST") {
      leases.push(String((body as { purpose?: string })?.purpose));
      return json(201, { lease: "lease-1", fields: { value: "sk-test" }, expiresAt: "2099-01-01T00:00:00Z" });
    }
    if (p === `/catalog/v1/conversations/${CONVERSATION_RID}`) {
      if (method === "PUT") {
        conversation.spec = (body as { spec: Record<string, unknown> }).spec;
        return json(200, conversationEnvelope());
      }
      return json(200, conversationEnvelope());
    }
    if (p === "/catalog/v1/conversations" && method === "POST") {
      const b = body as { name: string; spec: Record<string, unknown> };
      return json(201, { ...envelope("conversation", CONVERSATION_RID, b.name, b.spec, 0), status: {} });
    }
    if (p === `/catalog/v1/conversations/${CONVERSATION_RID}/turns` && method === "POST") {
      if (conversation.status.activeTurn)
        return json(409, { code: "turn_active", message: "a turn is already running" });
      const template = (body as { template?: string })?.template;
      if (template) conversation.spec = { ...conversation.spec, template };
      const turn = `turn-${calls.length}`;
      conversation.status = { ...conversation.status, activeTurn: turn };
      const current = String(conversation.spec.template);
      const m = /^texera:\/\/agent-templates\/([0-9a-f-]{36})/i.exec(current);
      const r = m ? resources[`agent-templates/${m[1]}`] : undefined;
      return json(201, { turn, template: `${current}@${r?.head ?? 1}`, startedAt: new Date().toISOString() });
    }
    const endTurn = /^\/catalog\/v1\/conversations\/([^/]+)\/turns\/([^/]+)$/.exec(p);
    if (endTurn && method === "DELETE") {
      const { activeTurn: _, ...rest } = conversation.status;
      conversation.status = rest;
      return new Response(null, { status: 204 });
    }
    if (p === `/catalog/v1/conversations/${CONVERSATION_RID}/messages`) {
      if (method === "GET") {
        const after = url.searchParams.get("after");
        return json(200, { items: after ? messages.filter((m) => m.seq > Number(after)) : messages });
      }
      const post = body as { turn?: string; role: Message["role"]; template?: string; parts: Message["parts"] };
      const message: Message = {
        conversation: CONVERSATION_RID,
        seq: messages.length + 1,
        turn: post.turn,
        role: post.role,
        author: USER_PID,
        template: post.template,
        parts: post.parts ?? [],
        createdAt: new Date().toISOString(),
      };
      messages.push(message);
      conversation.status = { ...conversation.status, messages: messages.length };
      return json(201, message);
    }
    const replace = /^\/catalog\/v1\/conversations\/([^/]+)\/messages\/(\d+)$/.exec(p);
    if (replace && method === "PUT") {
      const message = messages[Number(replace[2]) - 1];
      if (!message) return json(404, { code: "not_found", message: "no such message" });
      message.parts = (body as { parts: Message["parts"] }).parts;
      return json(200, message);
    }
    return json(404, { code: "not_found", message: `no route ${method} ${p}` });
  };

  return { fetch: fetchImpl, calls, messages, conversation, leases, analyst, bio };
}
