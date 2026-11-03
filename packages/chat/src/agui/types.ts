// The AG-UI 1.0 events the chat consumes. The wire format is `@ag-ui/core`'s; these are
// the fields read here, typed by the event's `type` string so the reducer stays plain.

import { EventType } from "@ag-ui/core";

export { EventType };

export interface AgUiEventBase {
  type: `${EventType}`;
  timestamp?: number;
  subagentRunId?: string;
  rawEvent?: unknown;
}

export interface TextMessageStartEvent extends AgUiEventBase {
  type: "TEXT_MESSAGE_START";
  messageId: string;
  role: string;
}
export interface TextMessageContentEvent extends AgUiEventBase {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}
export interface TextMessageEndEvent extends AgUiEventBase {
  type: "TEXT_MESSAGE_END";
  messageId: string;
}
export interface TextMessageChunkEvent extends AgUiEventBase {
  type: "TEXT_MESSAGE_CHUNK";
  messageId?: string;
  role?: string;
  delta?: string;
}
export interface ToolCallStartEvent extends AgUiEventBase {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}
export interface ToolCallArgsEvent extends AgUiEventBase {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  delta: string;
}
export interface ToolCallEndEvent extends AgUiEventBase {
  type: "TOOL_CALL_END";
  toolCallId: string;
}
export interface ToolCallChunkEvent extends AgUiEventBase {
  type: "TOOL_CALL_CHUNK";
  toolCallId?: string;
  toolCallName?: string;
  parentMessageId?: string;
  delta?: string;
}
export interface ToolCallResultEvent extends AgUiEventBase {
  type: "TOOL_CALL_RESULT";
  messageId: string;
  toolCallId: string;
  content: string;
  role?: string;
}
export interface StateSnapshotEvent extends AgUiEventBase {
  type: "STATE_SNAPSHOT";
  snapshot: unknown;
}
export interface StateDeltaEvent extends AgUiEventBase {
  type: "STATE_DELTA";
  delta: JsonPatchOperation[];
}
export interface MessagesSnapshotEvent extends AgUiEventBase {
  type: "MESSAGES_SNAPSHOT";
  messages: AgUiMessage[];
}
export interface CustomEvent extends AgUiEventBase {
  type: "CUSTOM";
  name: string;
  value: unknown;
}
export interface RawEvent extends AgUiEventBase {
  type: "RAW";
  event: unknown;
  source?: string;
}
export interface RunStartedEvent extends AgUiEventBase {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
  parentRunId?: string;
}
export interface RunFinishedEvent extends AgUiEventBase {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  result?: unknown;
  outcome?: { type: "success" } | { type: "interrupt"; interrupts?: Interrupt[] };
}
export interface RunErrorEvent extends AgUiEventBase {
  type: "RUN_ERROR";
  message: string;
  code?: string;
}
export interface StepStartedEvent extends AgUiEventBase {
  type: "STEP_STARTED";
  stepName: string;
}
export interface StepFinishedEvent extends AgUiEventBase {
  type: "STEP_FINISHED";
  stepName: string;
}
export interface ReasoningMessageStartEvent extends AgUiEventBase {
  type: "REASONING_MESSAGE_START";
  messageId: string;
}
export interface ReasoningMessageContentEvent extends AgUiEventBase {
  type: "REASONING_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}
export interface ReasoningMessageEndEvent extends AgUiEventBase {
  type: "REASONING_MESSAGE_END";
  messageId: string;
}
export interface ReasoningMessageChunkEvent extends AgUiEventBase {
  type: "REASONING_MESSAGE_CHUNK";
  messageId?: string;
  delta?: string;
}
export interface SubagentStartedEvent extends AgUiEventBase {
  type: "SUBAGENT_STARTED";
  subagentRunId: string;
  name: string;
  parentRunId?: string;
  parentMessageId?: string;
}
export interface SubagentFinishedEvent extends AgUiEventBase {
  type: "SUBAGENT_FINISHED";
  subagentRunId: string;
  result?: unknown;
  outcome?: { type: string };
}
export interface SubagentErrorEvent extends AgUiEventBase {
  type: "SUBAGENT_ERROR";
  subagentRunId: string;
  message: string;
  code?: string;
}

/** Every other AG-UI event: activities, reasoning contexts, encrypted values. Ignored. */
export interface OtherEvent extends AgUiEventBase {
  type:
    | "ACTIVITY_SNAPSHOT"
    | "ACTIVITY_DELTA"
    | "REASONING_START"
    | "REASONING_END"
    | "REASONING_ENCRYPTED_VALUE";
}

export type AgUiEvent =
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | TextMessageChunkEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallChunkEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent
  | CustomEvent
  | RawEvent
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningMessageChunkEvent
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | SubagentErrorEvent
  | OtherEvent;

export interface Interrupt {
  id: string;
  reason?: string;
  value?: unknown;
}

export interface JsonPatchOperation {
  op: "add" | "replace" | "remove" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
}

/** AG-UI messages as the run input and the messages snapshot carry them. */
export interface AgUiMessage {
  id: string;
  role: "user" | "assistant" | "system" | "developer" | "tool" | "activity" | "reasoning";
  content?: string | { type: string; text?: string }[];
  name?: string;
  toolCalls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface RunAgentInput {
  threadId: string;
  runId: string;
  protocolVersion?: string;
  parentRunId?: string;
  state?: unknown;
  messages: AgUiMessage[];
  tools: unknown[];
  context: { description: string; value: string }[];
  forwardedProps?: unknown;
}
