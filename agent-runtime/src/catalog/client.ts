/**
 * The runtime's view of the catalog.
 *
 * Types come from the generated `@texera/catalog-client`; the transport is a small
 * fetch layer over the contract's routes so the runtime has no runtime dependency on
 * the generated client's bootstrap (see docs/texera-2-0/API-REQUESTS.md). Every call
 * carries the person's token plus the headers that name the acting agent.
 */
import type { Conversation, PostMessage } from "@texera/catalog-client/types";
import {
  type Agent,
  type AgentTemplateSpec,
  type CatalogAuth,
  type McpServerRecord,
  type Message,
  parseRef,
  type SkillRecord,
  type TemplateRecord,
  type VersionRef,
} from "./types.ts";

/** An error returned by the catalog, with its HTTP status. */
export class CatalogError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

/** The subset of `fetch` the runtime needs; lets tests pass a plain function. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CatalogClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
}

/** Strips YAML frontmatter from a SKILL.md document. */
export function stripFrontmatter(markdown: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return m ? markdown.slice(m[0].length) : markdown;
}

interface Envelope<Spec> {
  metadata: { rid: string; name: string; headVersion: number };
  spec: Spec;
}

interface VersionBody {
  rid: string;
  vno: number;
  content?: unknown;
}

export class CatalogClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: CatalogClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Headers for a call made on a person's behalf by an agent. */
  static headersFor(auth: CatalogAuth): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${auth.userToken}`, Accept: "application/json" };
    if (auth.agentPid) headers["X-Texera-Agent"] = auth.agentPid;
    if (auth.serviceToken) headers["X-Texera-Service-Token"] = auth.serviceToken;
    return headers;
  }

  private async request<T>(method: "GET" | "POST", path: string, auth: CatalogAuth, body?: unknown): Promise<T> {
    const headers = CatalogClient.headersFor(auth);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = `catalog ${method} ${path} failed with ${res.status}`;
      try {
        const err = (await res.json()) as { code?: string; message?: string };
        if (err.code) code = err.code;
        if (err.message) message = err.message;
      } catch {
        // non-JSON error body: keep the defaults
      }
      throw new CatalogError(res.status, code, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  getAgent(pid: string, auth: CatalogAuth): Promise<Agent> {
    return this.request("GET", `/catalog/v1/agents/${encodeURIComponent(pid)}`, auth);
  }

  getConversation(rid: string, auth: CatalogAuth): Promise<Conversation> {
    return this.request("GET", `/catalog/v1/conversations/${encodeURIComponent(rid)}`, auth);
  }

  private readVersion(rid: string, vno: number, auth: CatalogAuth): Promise<VersionBody> {
    return this.request("GET", `/catalog/v1/resources/${encodeURIComponent(rid)}/versions/${vno}`, auth);
  }

  /**
   * Loads a template at a pinned version. A version's content is the spec as it was
   * when the version was made; the head read supplies the name.
   */
  async getTemplate(ref: VersionRef, auth: CatalogAuth): Promise<TemplateRecord> {
    const head = await this.request<Envelope<AgentTemplateSpec>>(
      "GET",
      `/catalog/v1/agent-templates/${encodeURIComponent(ref.rid)}`,
      auth,
    );
    let spec = head.spec;
    let vno = head.metadata.headVersion;
    if (ref.vno && ref.vno !== head.metadata.headVersion) {
      const version = await this.readVersion(ref.rid, ref.vno, auth);
      if (version.content && typeof version.content === "object") spec = version.content as AgentTemplateSpec;
      vno = ref.vno;
    }
    return { ref: { rid: ref.rid, vno }, name: head.metadata.name, spec };
  }

  async getMcpServer(reference: string, auth: CatalogAuth): Promise<McpServerRecord> {
    const { rid } = parseRef(reference);
    const server = await this.request<Envelope<McpServerRecord["spec"]>>(
      "GET",
      `/catalog/v1/mcp-servers/${encodeURIComponent(rid)}`,
      auth,
    );
    return { rid, name: server.metadata.name, spec: server.spec };
  }

  async getSkill(reference: string, auth: CatalogAuth): Promise<SkillRecord> {
    const { rid, vno } = parseRef(reference);
    const head = await this.request<Envelope<SkillRecord["spec"]>>(
      "GET",
      `/catalog/v1/skills/${encodeURIComponent(rid)}`,
      auth,
    );
    const version = await this.readVersion(rid, vno ?? head.metadata.headVersion, auth);
    const content = version.content;
    const markdown =
      typeof content === "string"
        ? content
        : content && typeof content === "object" && typeof (content as { markdown?: unknown }).markdown === "string"
          ? (content as { markdown: string }).markdown
          : "";
    return { ref: { rid, vno: version.vno }, spec: head.spec, body: stripFrontmatter(markdown) };
  }

  listMessages(conversationRid: string, auth: CatalogAuth, after?: number): Promise<Message[]> {
    const query = after === undefined ? "" : `?after=${after}`;
    return this.request(
      "GET",
      `/catalog/v1/conversations/${encodeURIComponent(conversationRid)}/messages${query}`,
      auth,
    );
  }

  postMessage(conversationRid: string, body: PostMessage, auth: CatalogAuth): Promise<Message> {
    return this.request(
      "POST",
      `/catalog/v1/conversations/${encodeURIComponent(conversationRid)}/messages`,
      auth,
      body,
    );
  }
}
