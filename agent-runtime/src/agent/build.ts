/**
 * Builds the agent for a template: model, system prompt, skills, MCP tools and the ReAct loop
 * that runs them (src/run/react-loop.ts). The template's `loop` settings override the runtime's
 * defaults. `toolApproval` is deliberately not configured yet; it is the seam for human approval.
 */
import type { LoopSpec } from "@texera/catalog-client/types";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { SkillRecord, TemplateRecord } from "../catalog/types.ts";
import { DEFAULT_POLICY, type LoopEvent, type LoopOutcome, type LoopPolicy, runReactLoop } from "../run/react-loop.ts";
import type { McpMount } from "./mcp-tools.ts";
import { LOAD_SKILL_TOOL, loadSkillTool } from "./skills.ts";
import { composeSystemPrompt } from "./system-prompt.ts";

/** The Dataflow Agent's sampling temperature. */
export const DEFAULT_TEMPERATURE = 0.2;

export interface BuildAgentOptions {
  template: TemplateRecord;
  skills: SkillRecord[];
  mcp?: McpMount;
  model: LanguageModel;
  /** The runtime's step budget per turn; the template's `loop.maxSteps` overrides it. */
  maxSteps: number;
  /** The runtime's loop policy defaults; the template's `loop` overrides them. */
  policy?: Partial<LoopPolicy>;
  /** Extra tools, e.g. from tests or built-in capabilities. */
  extraTools?: ToolSet;
}

export interface RunInput {
  messages: ModelMessage[];
  abortSignal?: AbortSignal;
}

export interface BuiltAgent {
  tools: ToolSet;
  instructions: string;
  policy: LoopPolicy;
  maxSteps: number;
  temperature: number;
  /** Runs one turn through the loop; the generator's return value says how it ended. */
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

export function buildAgent(options: BuildAgentOptions): BuiltAgent {
  const tools: ToolSet = { ...(options.mcp?.tools ?? {}), ...(options.extraTools ?? {}) };
  if (options.skills.length > 0) tools[LOAD_SKILL_TOOL] = loadSkillTool(options.skills);
  const instructions = composeSystemPrompt(options.template, options.skills);
  const { policy, maxSteps, temperature } = resolveLoop(options.template.spec.loop, {
    maxSteps: options.maxSteps,
    policy: options.policy,
  });
  const maxOutputTokens = options.template.spec.model?.maxOutputTokens;
  return {
    tools,
    instructions,
    policy,
    maxSteps,
    temperature,
    run: (input) =>
      runReactLoop({
        model: options.model,
        system: instructions,
        tools,
        messages: input.messages,
        maxSteps,
        policy,
        temperature,
        maxOutputTokens,
        abortSignal: input.abortSignal,
      }),
    close: async () => {
      await options.mcp?.close();
    },
  };
}
