/**
 * Builds the agent of a template version for one turn: the model from its endpoint and the
 * leased credential, the system prompt, the skills, the MCP servers (the catalog server for
 * every template unless it opts out), the handoff tool, and the loop that runs them. Nothing
 * survives the turn: `close` drops the MCP sessions.
 */
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { CatalogClient } from "../catalog/client.ts";
import type { CatalogAuth, LoopSpec, McpBinding, SkillRecord, TemplateRecord } from "../catalog/types.ts";
import type { Logger } from "../log.ts";
import { DEFAULT_POLICY, type LoopEvent, type LoopOutcome, type LoopPolicy, runReactLoop } from "../run/react-loop.ts";
import { candidatesOf, HANDOFF_TOOL, type HandoffCandidate, handoffTool } from "./handoff.ts";
import { builtinBinding, type McpMount, type McpMountOptions, mountMcpBindings } from "./mcp-tools.ts";
import { defaultModelFactory, type ModelFactory } from "./model.ts";
import { LOAD_SKILL_TOOL, loadSkillTool } from "./skills.ts";
import { composeSystemPrompt } from "./system-prompt.ts";
import type { TurnContext } from "./turn-context.ts";

/** The Dataflow Agent's sampling temperature. */
export const DEFAULT_TEMPERATURE = 0.2;

export interface BuildDeps {
  catalog: CatalogClient;
  publicUrl: string;
  maxSteps: number;
  policy?: Partial<LoopPolicy>;
  log: Logger;
  modelFactory?: ModelFactory;
  transportFactory?: McpMountOptions["transportFactory"];
  /** Extra tools, from tests. */
  extraTools?: ToolSet;
}

export interface BuildInput {
  template: TemplateRecord;
  auth: CatalogAuth;
  turn: TurnContext;
  /** What a lease is for: the conversation URI. */
  purpose: string;
}

export interface RunInput {
  messages: ModelMessage[];
  abortSignal?: AbortSignal;
}

export interface BuiltAgent {
  template: TemplateRecord;
  tools: ToolSet;
  instructions: string;
  handoffs: HandoffCandidate[];
  policy: LoopPolicy;
  maxSteps: number;
  temperature: number;
  /** Runs one loop; the generator's return value says how it ended. */
  run(input: RunInput): AsyncGenerator<LoopEvent, LoopOutcome>;
  close(): Promise<void>;
}

/** The loop settings a template carries, with the runtime's defaults filled in. */
export function resolveLoop(
  spec: LoopSpec | undefined,
  defaults: { maxSteps: number; policy?: Partial<LoopPolicy> },
): { policy: LoopPolicy; maxSteps: number; temperature: number } {
  const policy: LoopPolicy = { ...DEFAULT_POLICY, ...defaults.policy };
  if (spec?.answer) policy.answer = spec.answer;
  if (spec?.resultTools && spec.resultTools.length > 0) policy.resultTools = [...spec.resultTools];
  return {
    policy,
    maxSteps: spec?.maxSteps ?? defaults.maxSteps,
    temperature: spec?.temperature ?? DEFAULT_TEMPERATURE,
  };
}

/** Loads everything a template version needs and builds its agent. */
export async function buildAgent(deps: BuildDeps, input: BuildInput): Promise<BuiltAgent> {
  const { catalog } = deps;
  const { template, auth } = input;
  const spec = template.spec;
  const leases = new Map<string, Promise<Record<string, string>>>();
  const leaseCredential = (uri: string) => {
    let pending = leases.get(uri);
    if (!pending) {
      pending = catalog.lease(uri, input.purpose, auth).then((l) => l.fields);
      leases.set(uri, pending);
    }
    return pending;
  };

  const endpoint = await catalog.getModelEndpoint(spec.model, auth);
  const secret = endpoint.spec.credential ? await leaseCredential(endpoint.spec.credential) : undefined;
  const model: LanguageModel = (deps.modelFactory ?? defaultModelFactory)(endpoint, secret);

  const skills: SkillRecord[] = await Promise.all((spec.skills ?? []).map((uri) => catalog.getSkill(uri, auth)));
  const handoffTemplates = await Promise.all((spec.handoffs ?? []).map((uri) => catalog.getTemplate(uri, auth)));
  const handoffs = candidatesOf(handoffTemplates);

  const bindings: McpBinding[] = [...(spec.mcpServers ?? [])];
  const builtins = new Map<string, ReturnType<typeof builtinBinding>["record"]>();
  if (spec.catalogTools !== false) {
    const { record, binding } = builtinBinding("catalog", deps.publicUrl);
    builtins.set(record.uri, record);
    bindings.unshift(binding);
  }
  const mcp: McpMount = await mountMcpBindings({
    bindings,
    resolveServer: async (uri) => builtins.get(uri) ?? catalog.getMcpServer(uri, auth),
    leaseCredential,
    userToken: auth.userToken,
    publicUrl: deps.publicUrl,
    turn: input.turn,
    transportFactory: deps.transportFactory,
  });

  const tools: ToolSet = { ...mcp.tools, ...(deps.extraTools ?? {}) };
  if (skills.length > 0) tools[LOAD_SKILL_TOOL] = loadSkillTool(skills);
  if (handoffs.length > 0) tools[HANDOFF_TOOL] = handoffTool(handoffs);
  const instructions = composeSystemPrompt(template, skills, handoffs);
  const { policy, maxSteps, temperature } = resolveLoop(spec.loop, { maxSteps: deps.maxSteps, policy: deps.policy });
  const maxOutputTokens = endpoint.spec.maxOutputTokens;
  deps.log.info("agent built", {
    template: template.uri,
    model: endpoint.spec.model,
    tools: Object.keys(tools),
    servers: mcp.servers.map((s) => s.name),
    handoffs: handoffs.map((h) => h.name),
  });
  return {
    template,
    tools,
    instructions,
    handoffs,
    policy,
    maxSteps,
    temperature,
    run: (run) =>
      runReactLoop({
        model,
        system: instructions,
        tools,
        messages: run.messages,
        maxSteps,
        policy,
        temperature,
        maxOutputTokens,
        abortSignal: run.abortSignal,
        interruptTools: handoffs.length > 0 ? [HANDOFF_TOOL] : [],
      }),
    close: () => mcp.close(),
  };
}
