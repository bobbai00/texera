import type {
  AgentTemplateSpec,
  AppendMessage,
  Conversation,
  Lease,
  LoopSpec,
  McpBinding,
  McpServerSpec,
  Message,
  MessagePart,
  ModelEndpointSpec,
  ReplaceMessage,
  Resolved,
  Resource,
  SkillSpec,
  Turn,
  Version,
} from "@texera/catalog-client/types";

export type {
  AgentTemplateSpec,
  AppendMessage,
  Conversation,
  Lease,
  LoopSpec,
  McpBinding,
  McpServerSpec,
  Message,
  MessagePart,
  ModelEndpointSpec,
  ReplaceMessage,
  Resolved,
  Resource,
  SkillSpec,
  Turn,
  Version,
};

/** The chat turn a call acts in; the catalog records it as the origin of what the call creates. */
export interface Origin {
  conversation: string;
  turn: string;
  /** The template version running the turn, as a URI with `@vno`. */
  template?: string;
}

/** Credentials that accompany a catalog call made for a person. */
export interface CatalogAuth {
  /** The person's bearer token: the catalog applies their permissions. */
  userToken: string;
  /** The runtime's service token, which lets the catalog trust the origin. */
  serviceToken?: string;
  origin?: Origin;
}

/** A template resolved to a specific version. */
export interface TemplateRecord {
  /** The version URI, `texera://agent-templates/{rid}@{vno}`. */
  uri: string;
  rid: string;
  vno: number;
  name: string;
  spec: AgentTemplateSpec;
}

/** A skill resolved to its body. */
export interface SkillRecord {
  uri: string;
  name: string;
  description: string;
  body: string;
}

/** An MCP server resource the agent may mount. */
export interface McpServerRecord {
  uri: string;
  rid: string;
  name: string;
  spec: McpServerSpec;
}

/** A model endpoint resource. */
export interface ModelEndpointRecord {
  uri: string;
  rid: string;
  name: string;
  spec: ModelEndpointSpec;
}

/** Formats the origin header the catalog reads. */
export function formatOrigin(o: Origin): string {
  let s = `conversation=${o.conversation};turn=${o.turn}`;
  if (o.template) s += `;template=${o.template}`;
  return s;
}

const URI = /^texera:\/\/([a-z-]+)\/([0-9a-f-]{36})(?:@(\d+))?(?:\/(.*))?$/i;

/** The parts of a resource URI. */
export interface ParsedUri {
  plural: string;
  rid: string;
  vno?: number;
  subresource?: string;
}

/** Parses `texera://{plural}/{rid}[@vno][/subresource]`. */
export function parseUri(uri: string): ParsedUri {
  const m = URI.exec(uri);
  if (!m?.[1] || !m[2]) throw new Error(`not a resource uri: ${JSON.stringify(uri)}`);
  return {
    plural: m[1],
    rid: m[2],
    ...(m[3] ? { vno: Number.parseInt(m[3], 10) } : {}),
    ...(m[4] ? { subresource: m[4] } : {}),
  };
}

/** The resource URI without version and subresource. */
export function baseUri(uri: string): string {
  const { plural, rid } = parseUri(uri);
  return `texera://${plural}/${rid}`;
}
