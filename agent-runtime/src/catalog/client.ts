/**
 * The runtime's view of the catalog: a small fetch layer over the contract's routes, typed
 * with the generated client's types. Every call carries the person's token, and inside a turn
 * the service token and the origin the catalog records on what the call creates.
 */
import {
  type AgentTemplateSpec,
  type AppendMessage,
  type CatalogAuth,
  type ChatSettings,
  type Conversation,
  formatOrigin,
  type Lease,
  type McpServerRecord,
  type McpServerSpec,
  type Message,
  type ModelEndpointRecord,
  type ModelEndpointSpec,
  parseUri,
  type ReplaceMessage,
  type Resolved,
  type Resource,
  type SkillRecord,
  type SkillSpec,
  type TemplateRecord,
  type Turn,
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

const API = "/catalog/v1";

interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export class CatalogClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: CatalogClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Headers for a call made for a person. */
  static headersFor(auth: CatalogAuth): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${auth.userToken}`, Accept: "application/json" };
    if (auth.serviceToken) headers["X-Texera-Service-Token"] = auth.serviceToken;
    if (auth.origin) headers["X-Texera-Origin"] = formatOrigin(auth.origin);
    return headers;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    auth: CatalogAuth,
    body?: unknown,
  ): Promise<T> {
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

  getConversation(rid: string, auth: CatalogAuth): Promise<Conversation> {
    return this.request("GET", `${API}/conversations/${encodeURIComponent(rid)}`, auth);
  }

  createConversation(name: string, template: string, auth: CatalogAuth): Promise<Conversation> {
    return this.request("POST", `${API}/conversations`, auth, { name, spec: { template } });
  }

  /**
   * What a turn of the conversation runs with, for the person: the agent, its model, the unit
   * and the servers, each the chat's choice or the default it falls back to. The catalog
   * decides; the runtime builds what it says.
   */
  chatSettings(rid: string, auth: CatalogAuth): Promise<ChatSettings> {
    return this.request("GET", `${API}/conversations/${encodeURIComponent(rid)}/settings`, auth);
  }

  /** Replaces the conversation's spec (its current template among it). */
  updateConversationSpec(rid: string, spec: Conversation["spec"], auth: CatalogAuth): Promise<Conversation> {
    return this.request("PUT", `${API}/conversations/${encodeURIComponent(rid)}`, auth, { spec });
  }

  /** Takes the conversation's turn lock; 409 (`turn_active`) while another turn runs. */
  startTurn(rid: string, template: string | undefined, auth: CatalogAuth): Promise<Turn> {
    return this.request(
      "POST",
      `${API}/conversations/${encodeURIComponent(rid)}/turns`,
      auth,
      template ? { template } : {},
    );
  }

  endTurn(rid: string, turn: string, auth: CatalogAuth): Promise<void> {
    return this.request(
      "DELETE",
      `${API}/conversations/${encodeURIComponent(rid)}/turns/${encodeURIComponent(turn)}`,
      auth,
    );
  }

  async listMessages(rid: string, auth: CatalogAuth, after?: number): Promise<Message[]> {
    const query = after === undefined ? "?limit=500" : `?after=${after}&limit=500`;
    const page = await this.request<Page<Message>>(
      "GET",
      `${API}/conversations/${encodeURIComponent(rid)}/messages${query}`,
      auth,
    );
    return page.items;
  }

  appendMessage(rid: string, body: AppendMessage, auth: CatalogAuth): Promise<Message> {
    return this.request("POST", `${API}/conversations/${encodeURIComponent(rid)}/messages`, auth, body);
  }

  replaceMessage(rid: string, seq: number, body: ReplaceMessage, auth: CatalogAuth): Promise<Message> {
    return this.request("PUT", `${API}/conversations/${encodeURIComponent(rid)}/messages/${seq}`, auth, body);
  }

  resolve(uri: string, auth: CatalogAuth): Promise<Resolved> {
    return this.request("GET", `${API}/resources/resolve?uri=${encodeURIComponent(uri)}`, auth);
  }

  /**
   * Loads a template at the version its URI pins, or at the head. The version's content is the
   * spec as it was when the version was made.
   */
  async getTemplate(uri: string, auth: CatalogAuth): Promise<TemplateRecord> {
    const resolved = await this.resolve(uri, auth);
    const r = resolved.resource;
    if (r.kind !== "agent-template") throw new CatalogError(400, "not_a_template", `${uri} is not an agent template`);
    const spec = (resolved.version ? resolved.version.content : r.spec) as AgentTemplateSpec;
    const vno = resolved.version ? resolved.version.vno : r.metadata.head;
    return { uri: `${r.metadata.uri}@${vno}`, rid: r.metadata.rid, vno, name: r.metadata.name, spec };
  }

  async getSkill(uri: string, auth: CatalogAuth): Promise<SkillRecord> {
    const resolved = await this.resolve(uri, auth);
    const r = resolved.resource;
    const spec = (resolved.version ? resolved.version.content : r.spec) as SkillSpec;
    const vno = resolved.version ? resolved.version.vno : r.metadata.head;
    return { uri: `${r.metadata.uri}@${vno}`, name: spec.name, description: spec.description, body: spec.body };
  }

  async getMcpServer(uri: string, auth: CatalogAuth): Promise<McpServerRecord> {
    const resolved = await this.resolve(uri, auth);
    const r = resolved.resource;
    const spec = (resolved.version ? resolved.version.content : r.spec) as McpServerSpec;
    return { uri: r.metadata.uri, rid: r.metadata.rid, name: r.metadata.name, spec };
  }

  async getModelEndpoint(uri: string, auth: CatalogAuth): Promise<ModelEndpointRecord> {
    const resolved = await this.resolve(uri, auth);
    const r = resolved.resource;
    return {
      uri: r.metadata.uri,
      rid: r.metadata.rid,
      name: r.metadata.name,
      spec: r.spec as unknown as ModelEndpointSpec,
    };
  }

  /** Leases a credential's value for a purpose (the turn's conversation). */
  lease(credentialUri: string, purpose: string, auth: CatalogAuth): Promise<Lease> {
    const { rid } = parseUri(credentialUri);
    return this.request("POST", `${API}/credentials/${encodeURIComponent(rid)}/lease`, auth, { purpose });
  }

  /** Templates the person may read whose name matches. */
  async searchTemplates(q: string, auth: CatalogAuth): Promise<Resource[]> {
    const page = await this.request<Page<Resource>>(
      "GET",
      `${API}/agent-templates?q=${encodeURIComponent(q)}&limit=20`,
      auth,
    );
    return page.items;
  }
}
