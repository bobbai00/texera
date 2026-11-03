import type {
  Agent,
  AgentTemplateSpec,
  McpServerSpec,
  Message,
  MessagePart,
  SkillSpec,
  VersionRef,
} from "@texera/catalog-client/types";

export type { Agent, AgentTemplateSpec, McpServerSpec, Message, MessagePart, SkillSpec, VersionRef };

/** Credentials that accompany a catalog call made on a person's behalf. */
export interface CatalogAuth {
  /** The person's bearer token: the catalog applies their permissions. */
  userToken: string;
  /** The agent acting for the person, recorded by the catalog as the actor. */
  agentPid?: string;
  /** The runtime's service token, which lets the catalog trust `agentPid`. */
  serviceToken?: string;
}

/** An agent template resolved to a specific version. */
export interface TemplateRecord {
  ref: VersionRef;
  name: string;
  spec: AgentTemplateSpec;
}

/** A skill resolved to its SKILL.md content. */
export interface SkillRecord {
  ref: VersionRef;
  spec: SkillSpec;
  /** The SKILL.md body (Markdown), frontmatter removed. */
  body: string;
}

/** An MCP server resource the agent may mount. */
export interface McpServerRecord {
  rid: string;
  name: string;
  spec: McpServerSpec;
}

/** Parses `rid` or `rid@vno` references used inside template specs. */
export function parseRef(ref: string): { rid: string; vno?: number } {
  const at = ref.lastIndexOf("@");
  if (at < 0) return { rid: ref };
  const vno = Number.parseInt(ref.slice(at + 1), 10);
  if (Number.isNaN(vno)) throw new Error(`invalid resource reference ${JSON.stringify(ref)}`);
  return { rid: ref.slice(0, at), vno };
}
