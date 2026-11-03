/**
 * Spawning turns an agent principal (from the catalog) into a live agent: template,
 * skills, MCP mounts and model. The in-process spawner runs it in this process; a
 * Kubernetes spawner that starts one process per agent on a sandbox node is the
 * planned alternative behind the same interface.
 */
import type { MCPTransport } from "@ai-sdk/mcp";
import { type BuiltAgent, buildAgent } from "../agent/build.ts";
import { mountMcpBindings } from "../agent/mcp-tools.ts";
import { resolveModel } from "../agent/model.ts";
import { TurnContext } from "../agent/turn-context.ts";
import type { CatalogClient } from "../catalog/client.ts";
import type { Agent, CatalogAuth, McpServerRecord, TemplateRecord } from "../catalog/types.ts";
import type { LlmConfig } from "../config.ts";
import type { Logger } from "../log.ts";

export interface AgentInstance {
  pid: string;
  template: TemplateRecord;
  conversation?: string;
  built: BuiltAgent;
  /** The user token the instance was built with; its MCP sessions carry it. */
  userToken: string;
  /** Agent, service token and chat turn sent with each built-in MCP call; set per turn. */
  turn: TurnContext;
  createdAt: number;
  close(): Promise<void>;
}

export interface SpawnContext {
  pid: string;
  record: Agent;
  auth: CatalogAuth;
}

export interface Spawner {
  spawn(ctx: SpawnContext): Promise<AgentInstance>;
}

export interface InProcessSpawnerDeps {
  catalog: CatalogClient;
  llm: LlmConfig;
  publicUrl: string;
  maxSteps: number;
  log: Logger;
  transportFactory?: (
    server: McpServerRecord,
    url: string,
    headers: Record<string, string>,
  ) => MCPTransport | undefined;
}

export class InProcessSpawner implements Spawner {
  constructor(private readonly deps: InProcessSpawnerDeps) {}

  async spawn(ctx: SpawnContext): Promise<AgentInstance> {
    const { catalog } = this.deps;
    const template = await catalog.getTemplate(ctx.record.template, ctx.auth);
    const skills = await Promise.all((template.spec.skills ?? []).map((ref) => catalog.getSkill(ref, ctx.auth)));
    const turn = new TurnContext(ctx.pid);
    turn.begin(ctx.auth.serviceToken, undefined);
    const mcp = await mountMcpBindings({
      turn,
      bindings: template.spec.tools?.mcp ?? [],
      resolveServer: (ref) => catalog.getMcpServer(ref, ctx.auth),
      userToken: ctx.auth.userToken,
      publicUrl: this.deps.publicUrl,
      transportFactory: this.deps.transportFactory,
    });
    const built = buildAgent({
      template,
      skills,
      mcp,
      model: resolveModel(this.deps.llm, template.spec.model?.name),
      maxSteps: this.deps.maxSteps,
    });
    this.deps.log.info("agent spawned", {
      pid: ctx.pid,
      template: template.ref,
      tools: Object.keys(built.tools),
      servers: mcp.servers.map((s) => s.name),
    });
    return {
      pid: ctx.pid,
      template,
      conversation: ctx.record.conversation,
      built,
      userToken: ctx.auth.userToken,
      turn,
      createdAt: Date.now(),
      close: () => built.close(),
    };
  }
}
