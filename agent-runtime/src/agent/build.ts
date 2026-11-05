/**
 * Builds the agent of one turn from what the chat's settings resolve to: the agent's version
 * gives the system prompt, the skills, the handoffs and the loop's rules; the settings give the
 * model endpoint (leased as the person) and the MCP servers. The runtime decides none of it.
 * The chat's own facts (the date, its computing unit, add-ons that could not be mounted) go
 * into every step's turn state. Nothing survives the turn: `close` drops the MCP sessions.
 */
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { CatalogClient } from "../catalog/client.ts";
import type { CatalogAuth, ChatSettings, LoopSpec, SkillRecord, TemplateRecord } from "../catalog/types.ts";
import type { Logger } from "../log.ts";
import {
  DEFAULT_POLICY,
  type LoopEvent,
  type LoopOutcome,
  type LoopPolicy,
  renderTurnState,
  runReactLoop,
} from "../run/react-loop.ts";
import { chatContext } from "./chat-context.ts";
import { candidatesOf, HANDOFF_TOOL, type HandoffCandidate, handoffTool } from "./handoff.ts";
import {
  type McpMount,
  type McpMountOptions,
  type MountedServer,
  mountMcpServers,
  type UnavailableServer,
} from "./mcp-tools.ts";
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
  /** The clock, for the date an agent is told; tests fix it. */
  now?: () => Date;
}

export interface BuildInput {
  /** What the chat's settings resolve to for this turn. */
  settings: ChatSettings;
  /** The agent the settings name, at its version. */
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
  /** The servers this turn mounted. */
  servers: MountedServer[];
  /** The add-on servers left out of this turn. */
  unavailable: UnavailableServer[];
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

/** Loads everything the turn's settings name and builds its agent. */
export async function buildAgent(deps: BuildDeps, input: BuildInput): Promise<BuiltAgent> {
  const { catalog } = deps;
  const { settings, template, auth } = input;
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

  const endpoint = await catalog.getModelEndpoint(settings.modelEndpoint.uri, auth);
  const secret = endpoint.spec.credential ? await leaseCredential(endpoint.spec.credential) : undefined;
  const model: LanguageModel = (deps.modelFactory ?? defaultModelFactory)(endpoint, secret);

  const skills: SkillRecord[] = await Promise.all((spec.skills ?? []).map((uri) => catalog.getSkill(uri, auth)));
  const handoffTemplates = await Promise.all((spec.handoffs ?? []).map((uri) => catalog.getTemplate(uri, auth)));
  const handoffs = candidatesOf(handoffTemplates);

  const mcp: McpMount = await mountMcpServers({
    servers: settings.mcpServers,
    resolveServer: (uri) => catalog.getMcpServer(uri, auth),
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
  for (const missing of mcp.unavailable) {
    deps.log.warn("add-on left out of the turn", { server: missing.name, uri: missing.uri, reason: missing.reason });
  }
  const chat = chatContext({
    today: (deps.now ?? (() => new Date()))(),
    project: settings.project,
    computingUnit: settings.computingUnit,
    unavailable: mcp.unavailable,
  });
  deps.log.info("agent built", {
    template: template.uri,
    model: endpoint.spec.model,
    tools: Object.keys(tools),
    servers: mcp.servers.map((s) => s.name),
    unavailable: mcp.unavailable.map((s) => s.name),
    handoffs: handoffs.map((h) => h.name),
  });
  return {
    template,
    tools,
    instructions,
    handoffs,
    servers: mcp.servers,
    unavailable: mcp.unavailable,
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
        renderContext: (state, step) => `${renderTurnState(state, step)}\n\n${chat}`,
      }),
    close: () => mcp.close(),
  };
}
