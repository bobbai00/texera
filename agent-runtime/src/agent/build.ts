/**
 * Builds the AI SDK 7 agent for a template: model, system prompt, skills and MCP tools.
 * `toolApproval` is deliberately not configured yet; it is the seam for human approval.
 */
import { type LanguageModel, stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import type { SkillRecord, TemplateRecord } from "../catalog/types.ts";
import type { McpMount } from "./mcp-tools.ts";
import { LOAD_SKILL_TOOL, loadSkillTool } from "./skills.ts";
import { composeSystemPrompt } from "./system-prompt.ts";

export type TexeraAgent = ToolLoopAgent<never, ToolSet>;

export interface BuildAgentOptions {
  template: TemplateRecord;
  skills: SkillRecord[];
  mcp?: McpMount;
  model: LanguageModel;
  maxSteps: number;
  /** Extra tools, e.g. from tests or built-in capabilities. */
  extraTools?: ToolSet;
}

export interface BuiltAgent {
  agent: TexeraAgent;
  tools: ToolSet;
  instructions: string;
  close(): Promise<void>;
}

export function buildAgent(options: BuildAgentOptions): BuiltAgent {
  const tools: ToolSet = { ...(options.mcp?.tools ?? {}), ...(options.extraTools ?? {}) };
  if (options.skills.length > 0) tools[LOAD_SKILL_TOOL] = loadSkillTool(options.skills);
  const instructions = composeSystemPrompt(options.template, options.skills);
  const agent = new ToolLoopAgent({
    id: options.template.ref.rid,
    model: options.model,
    instructions,
    tools,
    stopWhen: stepCountIs(options.maxSteps),
    maxOutputTokens: options.template.spec.model?.maxOutputTokens,
  });
  return {
    agent,
    tools,
    instructions,
    close: async () => {
      await options.mcp?.close();
    },
  };
}
