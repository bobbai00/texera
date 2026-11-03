/**
 * AG-UI 1.0 event construction and the mapping from AI SDK stream parts.
 *
 * The runtime speaks AG-UI to the app: one request in, one ordered stream of typed
 * events out. Everything here is pure so the mapping is testable without a model.
 */

import type {
  BaseEvent,
  CustomEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunFinishedOutcome,
  RunStartedEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { MessagePart } from "@texera/catalog-client/types";
import type { TextStreamPart, ToolSet } from "ai";
import { type ResourceRef, resourceRefsInToolOutput } from "../resources.ts";

export type AGUIEvent = BaseEvent;

/** Name of the custom event that announces a catalog resource the agent touched. */
export const RESOURCE_EVENT = "texera.resource";

const stamp = () => Date.now();

export const events = {
  runStarted: (threadId: string, runId: string): RunStartedEvent => ({
    type: EventType.RUN_STARTED,
    timestamp: stamp(),
    threadId,
    runId,
  }),
  runFinished: (threadId: string, runId: string, outcome?: RunFinishedOutcome): RunFinishedEvent => ({
    type: EventType.RUN_FINISHED,
    timestamp: stamp(),
    threadId,
    runId,
    ...(outcome ? { outcome } : {}),
  }),
  runError: (message: string, code?: string): RunErrorEvent => ({
    type: EventType.RUN_ERROR,
    timestamp: stamp(),
    message,
    ...(code ? { code } : {}),
  }),
  stepStarted: (stepName: string): StepStartedEvent => ({
    type: EventType.STEP_STARTED,
    timestamp: stamp(),
    stepName,
  }),
  stepFinished: (stepName: string): StepFinishedEvent => ({
    type: EventType.STEP_FINISHED,
    timestamp: stamp(),
    stepName,
  }),
  textStart: (messageId: string): TextMessageStartEvent => ({
    type: EventType.TEXT_MESSAGE_START,
    timestamp: stamp(),
    messageId,
    role: "assistant",
  }),
  textContent: (messageId: string, delta: string): TextMessageContentEvent => ({
    type: EventType.TEXT_MESSAGE_CONTENT,
    timestamp: stamp(),
    messageId,
    delta,
  }),
  textEnd: (messageId: string): TextMessageEndEvent => ({
    type: EventType.TEXT_MESSAGE_END,
    timestamp: stamp(),
    messageId,
  }),
  toolCallStart: (toolCallId: string, toolCallName: string, parentMessageId?: string): ToolCallStartEvent => ({
    type: EventType.TOOL_CALL_START,
    timestamp: stamp(),
    toolCallId,
    toolCallName,
    ...(parentMessageId ? { parentMessageId } : {}),
  }),
  toolCallArgs: (toolCallId: string, delta: string): ToolCallArgsEvent => ({
    type: EventType.TOOL_CALL_ARGS,
    timestamp: stamp(),
    toolCallId,
    delta,
  }),
  toolCallEnd: (toolCallId: string): ToolCallEndEvent => ({
    type: EventType.TOOL_CALL_END,
    timestamp: stamp(),
    toolCallId,
  }),
  toolCallResult: (messageId: string, toolCallId: string, content: string): ToolCallResultEvent => ({
    type: EventType.TOOL_CALL_RESULT,
    timestamp: stamp(),
    messageId,
    toolCallId,
    content,
    role: "tool",
  }),
  resource: (ref: ResourceRef): CustomEvent => ({
    type: EventType.CUSTOM,
    timestamp: stamp(),
    name: RESOURCE_EVENT,
    value: ref,
  }),
};

export interface MapperOptions {
  /** Id generator; injectable for deterministic tests. */
  newId?: () => string;
}

/** What the mapper has seen, so a turn can be persisted after the stream ends. */
export interface CollectedTurn {
  /** Every part of the assistant message in stream order: text segments, tool calls, results, resources. */
  parts: MessagePart[];
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown; isError: boolean }>;
  resources: ResourceRef[];
  error?: string;
}

/** Serializes a tool output for the AG-UI `content` field. */
export function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * Maps AI SDK stream parts to AG-UI events, one part at a time, and collects the turn.
 */
export class StreamMapper {
  private readonly newId: () => string;
  private step = 0;
  private openStep?: string;
  private currentMessageId?: string;
  private readonly startedToolCalls = new Set<string>();
  readonly collected: CollectedTurn = { parts: [], text: "", toolCalls: [], toolResults: [], resources: [] };
  private openText?: { type: "text"; text: string };

  private appendText(delta: string): void {
    if (!this.openText) {
      this.openText = { type: "text", text: "" };
      this.collected.parts.push(this.openText);
    }
    this.openText.text += delta;
  }

  constructor(options: MapperOptions = {}) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  map(part: TextStreamPart<ToolSet>): AGUIEvent[] {
    switch (part.type) {
      case "start-step": {
        this.step += 1;
        this.openStep = `step-${this.step}`;
        return [events.stepStarted(this.openStep)];
      }
      case "finish-step": {
        const name = this.openStep ?? `step-${this.step}`;
        this.openStep = undefined;
        return [events.stepFinished(name)];
      }
      case "text-start": {
        this.currentMessageId = part.id || this.newId();
        this.openText = undefined;
        if (this.collected.text && !this.collected.text.endsWith("\n")) this.collected.text += "\n\n";
        return [events.textStart(this.currentMessageId)];
      }
      case "text-delta": {
        if (!this.currentMessageId) this.currentMessageId = part.id || this.newId();
        this.collected.text += part.text;
        this.appendText(part.text);
        return [events.textContent(this.currentMessageId, part.text)];
      }
      case "text-end": {
        const id = this.currentMessageId ?? part.id;
        this.currentMessageId = undefined;
        this.openText = undefined;
        return [events.textEnd(id)];
      }
      case "tool-input-start": {
        this.startedToolCalls.add(part.id);
        return [events.toolCallStart(part.id, part.toolName, this.currentMessageId)];
      }
      case "tool-input-delta":
        return [events.toolCallArgs(part.id, part.delta)];
      case "tool-input-end":
        return [events.toolCallEnd(part.id)];
      case "tool-call": {
        this.collected.toolCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
        this.openText = undefined;
        this.collected.parts.push({
          type: "tool_call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.input,
        });
        if (this.startedToolCalls.has(part.toolCallId)) return [];
        // A provider that does not stream tool input: emit the whole call at once.
        this.startedToolCalls.add(part.toolCallId);
        return [
          events.toolCallStart(part.toolCallId, part.toolName, this.currentMessageId),
          events.toolCallArgs(part.toolCallId, JSON.stringify(part.input ?? {})),
          events.toolCallEnd(part.toolCallId),
        ];
      }
      case "tool-result": {
        this.collected.toolResults.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.output,
          isError: false,
        });
        this.collected.parts.push({
          type: "tool_result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.output,
        });
        const out: AGUIEvent[] = [
          events.toolCallResult(this.newId(), part.toolCallId, stringifyToolOutput(part.output)),
        ];
        for (const ref of resourceRefsInToolOutput(part.output)) {
          this.collected.resources.push(ref);
          this.collected.parts.push({
            type: "resource",
            resource: { kind: ref.kind, rid: ref.rid, ...(ref.vno ? { vno: ref.vno } : {}) },
          });
          out.push(events.resource(ref));
        }
        return out;
      }
      case "tool-error": {
        const message = part.error instanceof Error ? part.error.message : String(part.error);
        this.collected.toolResults.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: { error: message },
          isError: true,
        });
        this.collected.parts.push({
          type: "tool_result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: { error: message },
        });
        return [events.toolCallResult(this.newId(), part.toolCallId, JSON.stringify({ error: message }))];
      }
      case "error": {
        const message = part.error instanceof Error ? part.error.message : String(part.error);
        this.collected.error = message;
        this.collected.parts.push({ type: "error", text: message });
        return [events.runError(message, "model_error")];
      }
      case "abort":
        this.collected.error = part.reason ?? "aborted";
        return [events.runError(this.collected.error, "aborted")];
      default:
        return [];
    }
  }
}
