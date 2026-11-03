/**
 * The ReAct loop: one model call per step, each step's tool calls run, until the model replies
 * without a tool call (the answer), the step budget is spent, or the run is aborted.
 *
 * It is the loop of the Dataflow Agent (agent-service/src/agent/llm-drivers) on AI SDK 7's
 * `streamText`: `prepareStep` re-renders the turn's state into the system prompt before every
 * model call, `onStepFinish` records each step, and the answer policy decides whether a reply
 * without a tool call is the answer. Under `after_result` such a reply computes nothing until a
 * result-showing tool has succeeded, so it is sent back with a correction, a bounded number of
 * times. A provider refusal (an empty reply ended by a content filter) is retried once; a reply
 * cut off at the output limit is continued once.
 */
import {
  type LanguageModel,
  type ModelMessage,
  type StepResult,
  type SystemModelMessage,
  stepCountIs,
  streamText,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { type ResourceRef, resourceRefsInToolOutput, toolOutputValues } from "../resources.ts";

export type AnswerPolicy = "free" | "after_result";

export interface LoopPolicy {
  /**
   * `free`: a reply without a tool call ends the turn. `after_result`: it ends the turn only
   * once a result-showing tool succeeded in this turn; before that it is sent back with a
   * correction, `maxCorrections` times at most.
   */
  answer: AnswerPolicy;
  /** Tools whose successful result counts as a result shown to the model. */
  resultTools: string[];
  /** How many premature replies are sent back before one is accepted. */
  maxCorrections: number;
}

/** The dataflow tools that show computed results: a completed run, a page of rows, a saved result. */
export const DEFAULT_RESULT_TOOLS = ["run_workflow", "get_port_result", "save_result_as_dataset"];

export const DEFAULT_POLICY: LoopPolicy = { answer: "free", resultTools: DEFAULT_RESULT_TOOLS, maxCorrections: 1 };

export interface LoopToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface LoopToolResult {
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError: boolean;
}

export interface LoopUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Input tokens read from the prompt cache. */
  cachedInputTokens: number;
  /** Input tokens written to the prompt cache. */
  cacheWriteInputTokens: number;
  reasoningTokens: number;
}

/** One model call and what it did: the ReAct step (thought, actions, observations). */
export interface LoopStep {
  /** 1-based within the turn. */
  index: number;
  text: string;
  reasoning?: string;
  toolCalls: LoopToolCall[];
  toolResults: LoopToolResult[];
  /** Catalog resources the step's tool results referred to. */
  resources: ResourceRef[];
  usage: LoopUsage;
  finishReason: string;
}

/** The turn so far, as the loop keeps it and renders it for the model. */
export interface LoopState {
  steps: LoopStep[];
  /** Resources the turn's tool results referred to, in order of first appearance. */
  resources: ResourceRef[];
  resultShown: boolean;
  corrections: number;
  maxSteps: number;
}

export type LoopEvent =
  | { type: "part"; part: TextStreamPart<ToolSet> }
  | { type: "step"; step: LoopStep }
  | { type: "correction"; reason: "premature_answer" | "cut_off" | "refused"; text: string };

export type LoopEnd = "answered" | "step_limit" | "error" | "aborted" | "refused";

export interface LoopOutcome {
  reason: LoopEnd;
  state: LoopState;
  usage: LoopUsage;
}

export interface ReactLoopOptions {
  model: LanguageModel;
  system: string;
  tools: ToolSet;
  messages: ModelMessage[];
  maxSteps: number;
  policy?: Partial<LoopPolicy>;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /** System text rendered before each model call from the turn's state; default `renderTurnState`. */
  renderContext?: (state: LoopState, stepNumber: number) => string;
  /** Provider-side parallel tool calls; off by default so stateful dataflow tools run in order. */
  parallelToolCalls?: boolean;
}

export const PREMATURE_ANSWER_CORRECTION =
  "Your reply computed nothing: no result has been shown in this turn, so it cannot be the answer. " +
  "A reply without a tool call is final. Use the tools first (build or edit the workflow, run it, read " +
  "its results), then reply with the answer those results support. If the question truly needs no " +
  "computation, say so in one sentence and answer.";

export const CUT_OFF_CORRECTION =
  "Your reply was cut off at the output limit. Continue from where it stopped, more briefly.";

const ZERO_USAGE: LoopUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningTokens: 0,
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Reads AI SDK usage defensively: AI SDK 7 details input tokens in `inputTokenDetails` (cache
 * reads and writes) and output tokens in `outputTokenDetails`; older shapes carried flat fields.
 */
export function toLoopUsage(usage: unknown): LoopUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const inputDetails = (u.inputTokenDetails ?? {}) as Record<string, unknown>;
  const outputDetails = (u.outputTokenDetails ?? {}) as Record<string, unknown>;
  const input = num(u.inputTokens);
  const output = num(u.outputTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: num(u.totalTokens) || input + output,
    cachedInputTokens: num(inputDetails.cacheReadTokens) || num(u.cachedInputTokens),
    cacheWriteInputTokens: num(inputDetails.cacheWriteTokens),
    reasoningTokens: num(outputDetails.reasoningTokens) || num(u.reasoningTokens),
  };
}

export function addUsage(a: LoopUsage, b: LoopUsage): LoopUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An MCP tool result flagged as an error, or a plain `{error}` object. */
export function isErrorOutput(output: unknown): boolean {
  if (!isRecord(output)) return false;
  if (output.isError === true) return true;
  return typeof output.error === "string" && Object.keys(output).length === 1;
}

/**
 * Whether a tool result shows a computed result: a successful result tool, and for `run_workflow`
 * only a completed run (a failed run showed nothing the answer can rest on).
 */
export function showsResult(result: LoopToolResult, resultTools: string[]): boolean {
  if (result.isError || !resultTools.includes(result.toolName)) return false;
  if (result.toolName !== "run_workflow") return true;
  return toolOutputValues(result.output).some((v) => isRecord(v) && v.status === "completed");
}

/** Converts a finished AI SDK step into the loop's record of it. */
export function stepFromResult(index: number, step: StepResult<ToolSet>, resultTools: string[]): LoopStep {
  const toolCalls: LoopToolCall[] = step.toolCalls.map((c) => ({
    toolCallId: c.toolCallId,
    toolName: c.toolName,
    input: c.input,
  }));
  const toolResults: LoopToolResult[] = [];
  for (const item of step.content) {
    if (item.type === "tool-result") {
      toolResults.push({
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        output: item.output,
        isError: isErrorOutput(item.output),
      });
    } else if (item.type === "tool-error") {
      const message = item.error instanceof Error ? item.error.message : String(item.error);
      toolResults.push({
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        output: { error: message },
        isError: true,
      });
    }
  }
  const resources: ResourceRef[] = [];
  const seen = new Set<string>();
  for (const r of toolResults) {
    if (r.isError) continue;
    for (const ref of resourceRefsInToolOutput(r.output)) {
      const key = `${ref.kind}:${ref.rid}:${ref.vno ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        resources.push(ref);
      }
    }
  }
  void resultTools;
  return {
    index,
    text: step.text ?? "",
    reasoning: step.reasoningText || undefined,
    toolCalls,
    toolResults,
    resources,
    usage: toLoopUsage(step.usage),
    finishReason: String(step.finishReason),
  };
}

/** Folds a step into the turn's state. */
export function applyStep(state: LoopState, step: LoopStep, policy: LoopPolicy): void {
  state.steps.push(step);
  const seen = new Set(state.resources.map((r) => `${r.kind}:${r.rid}:${r.vno ?? ""}`));
  for (const ref of step.resources) {
    const key = `${ref.kind}:${ref.rid}:${ref.vno ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      state.resources.push(ref);
    }
  }
  if (!state.resultShown) state.resultShown = step.toolResults.some((r) => showsResult(r, policy.resultTools));
}

/**
 * The turn's state as the model reads it before each call: where it is in its budget, the
 * resources it has touched (with the ids it must reuse), and whether a result has been shown.
 */
export function renderTurnState(state: LoopState, stepNumber: number): string {
  const lines = [`## Turn state`, `Step ${stepNumber} of ${state.maxSteps} in this turn.`];
  if (state.resources.length > 0) {
    lines.push("Resources this turn touched, oldest first (reuse these ids):");
    for (const r of state.resources)
      lines.push(`- ${r.kind} ${r.rid}${r.vno !== undefined ? ` version ${r.vno}` : ""}`);
  }
  lines.push(
    state.resultShown
      ? "A computed result has been shown in this turn; a reply without a tool call is the final answer."
      : "No computed result has been shown in this turn yet.",
  );
  return lines.join("\n");
}

function newState(maxSteps: number): LoopState {
  return { steps: [], resources: [], resultShown: false, corrections: 0, maxSteps };
}

/** Anthropic prompt caching: the prefix up to a marked block is reused by later calls. */
const CACHED = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

/**
 * The instructions as a cacheable system message: the tools and the instructions precede it,
 * so every step and every turn reads them from cache.
 */
export function cachedInstructions(system: string): SystemModelMessage[] {
  return [{ role: "system", content: system, providerOptions: CACHED }];
}

/**
 * The messages of one model call: the conversation with a cache breakpoint on its newest message
 * (so each step reads the previous steps from cache), then the turn's state as the newest user
 * message, the only part that changes between steps.
 */
export function stepMessages(conversation: ModelMessage[], state: string): ModelMessage[] {
  const out: ModelMessage[] = conversation.map((m, i) =>
    i === conversation.length - 1 && m.role !== "system"
      ? ({ ...m, providerOptions: { ...m.providerOptions, ...CACHED } } as ModelMessage)
      : m,
  );
  out.push({ role: "user", content: state });
  return out;
}

/**
 * Runs the loop, yielding stream parts (as AI SDK emits them), one `step` event per finished
 * step and a `correction` event whenever a reply is sent back; returns how the turn ended.
 */
export async function* runReactLoop(options: ReactLoopOptions): AsyncGenerator<LoopEvent, LoopOutcome> {
  const policy: LoopPolicy = { ...DEFAULT_POLICY, ...options.policy };
  const state = newState(options.maxSteps);
  const render = options.renderContext ?? renderTurnState;
  let messages: ModelMessage[] = [...options.messages];
  let usage = ZERO_USAGE;
  let refusals = 0;
  let continuations = 0;

  while (true) {
    const remaining = options.maxSteps - state.steps.length;
    if (remaining <= 0) return { reason: "step_limit", state, usage };
    const finishedSteps: LoopStep[] = [];
    // `stepNumber` counts the steps of this streamText call; earlier calls' steps are in the state.
    const stepsBefore = state.steps.length;
    const result = streamText({
      model: options.model,
      instructions: cachedInstructions(options.system),
      messages,
      tools: options.tools,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      abortSignal: options.abortSignal,
      stopWhen: stepCountIs(remaining),
      toolChoice: "auto",
      providerOptions: { anthropic: { disableParallelToolUse: !(options.parallelToolCalls ?? false) } },
      // Every step re-renders the turn's state at the end of the prompt (the Dataflow Agent's
      // prepareStep), so the instructions and the conversation stay a cacheable prefix.
      prepareStep: ({ stepNumber, messages: current }) => ({
        messages: stepMessages(current, render(state, stepsBefore + stepNumber + 1)),
      }),
      onStepFinish: (step) => {
        const record = stepFromResult(state.steps.length + 1, step, policy.resultTools);
        applyStep(state, record, policy);
        finishedSteps.push(record);
      },
    });

    let errored = false;
    let aborted = false;
    let emitted = 0;
    for await (const part of result.fullStream) {
      if (part.type === "error") errored = true;
      if (part.type === "abort") aborted = true;
      yield { type: "part", part };
      // Steps finish between parts; surface each one as soon as it is recorded.
      while (emitted < finishedSteps.length) {
        yield { type: "step", step: finishedSteps[emitted++] as LoopStep };
      }
    }
    while (emitted < finishedSteps.length) yield { type: "step", step: finishedSteps[emitted++] as LoopStep };
    for (const s of finishedSteps) usage = addUsage(usage, s.usage);
    if (aborted || options.abortSignal?.aborted) return { reason: "aborted", state, usage };
    if (errored) return { reason: "error", state, usage };

    const last = finishedSteps[finishedSteps.length - 1];
    if (!last) return { reason: "error", state, usage };
    const responseMessages = (await result.response).messages;
    const textOnly = last.toolCalls.length === 0;
    const text = last.text.trim();

    if (last.finishReason === "content-filter" && textOnly && !text) {
      // The provider refused: no reply and no tool call. Retried like a dropped request.
      if (refusals++ < 1) {
        yield { type: "correction", reason: "refused", text: "" };
        continue;
      }
      return { reason: "refused", state, usage };
    }
    if (last.finishReason === "length" && textOnly && continuations++ < 1) {
      messages = [...messages, ...responseMessages, { role: "user", content: CUT_OFF_CORRECTION }];
      yield { type: "correction", reason: "cut_off", text: CUT_OFF_CORRECTION };
      continue;
    }
    if (!textOnly) {
      // The budget ran out while the model was still calling tools.
      return { reason: "step_limit", state, usage };
    }
    if (policy.answer === "after_result" && !state.resultShown && text && state.corrections < policy.maxCorrections) {
      state.corrections += 1;
      messages = [...messages, ...responseMessages, { role: "user", content: PREMATURE_ANSWER_CORRECTION }];
      yield { type: "correction", reason: "premature_answer", text: PREMATURE_ANSWER_CORRECTION };
      continue;
    }
    return { reason: "answered", state, usage };
  }
}
