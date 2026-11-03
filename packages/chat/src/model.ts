// The conversation view model: messages made of parts, built from the catalog's history
// and from AG-UI events as a run streams. Pure; the hook feeds it.

import type { Message as CatalogMessage } from "@texera/catalog-client/types";
import { KIND_IDS, type KindId, type ResourceRef, refKey } from "@texera/kinds";
import type { AgUiEvent, AgUiMessage, Interrupt, JsonPatchOperation } from "./agui/types";

export type ToolStatus = "running" | "done" | "error";

export type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      args: string;
      input?: unknown;
      result?: unknown;
      status: ToolStatus;
      error?: string;
      resources: ResourceRef[];
    }
  | { type: "resource"; ref: ResourceRef }
  | { type: "subagent"; id: string; name: string; status: ToolStatus; error?: string }
  | { type: "approval"; interrupts: Interrupt[] }
  | { type: "error"; message: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  parts: Part[];
  seq?: number;
  createdAt?: string;
}

export interface ChatState {
  messages: ChatMessage[];
  running: boolean;
  runId?: string;
  /** The agent's shared state (AG-UI StateSnapshot/StateDelta), e.g. a workflow draft. */
  state?: unknown;
  steps: string[];
  error?: string;
  /** Every resource the run touched, in order of first appearance. */
  resources: ResourceRef[];
}

export const EMPTY_STATE: ChatState = { messages: [], running: false, steps: [], resources: [] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isKind = (v: unknown): v is KindId => typeof v === "string" && (KIND_IDS as readonly string[]).includes(v);

/**
 * Resource references inside a tool result, in the shapes the catalog's tools return:
 * the envelope (`{kind, metadata: {rid}}`), a ref (`{kind, rid, vno?}`), an execution
 * (`{eid, workflow}`), a version (`{rid, vno, contentKind}`), or lists and wrappers of those.
 */
export function extractResourceRefs(value: unknown, depth = 0): ResourceRef[] {
  if (depth > 4 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return dedupe(value.flatMap(v => extractResourceRefs(v, depth + 1)));
  const r = value as Record<string, unknown>;
  const found: ResourceRef[] = [];
  if (isKind(r.kind) && isRecord(r.metadata) && typeof r.metadata.rid === "string") {
    found.push({ kind: r.kind, rid: r.metadata.rid });
  } else if (isKind(r.kind) && typeof r.rid === "string") {
    found.push({ kind: r.kind, rid: r.rid, ...(typeof r.vno === "number" ? { vno: r.vno } : {}) });
  } else if (typeof r.eid === "string" && isRecord(r.workflow)) {
    found.push({ kind: "execution", rid: r.eid });
  }
  for (const key of ["resource", "resources", "workflow", "dataset", "version", "execution", "items", "result", "data"]) {
    if (key in r) found.push(...extractResourceRefs(r[key], depth + 1));
  }
  return dedupe(found);
}

const dedupe = (refs: ResourceRef[]) => {
  const seen = new Set<string>();
  return refs.filter(r => {
    const k = `${r.kind}:${r.rid}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A minimal RFC 6902 patch for `/a/b` paths over JSON objects and arrays. */
export function applyPatch(target: unknown, ops: JsonPatchOperation[]): unknown {
  let doc: unknown = structuredClone(target ?? {});
  for (const op of ops) {
    const path = op.path.split("/").slice(1).map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (path.length === 0) {
      if (op.op === "replace" || op.op === "add") doc = structuredClone(op.value);
      continue;
    }
    const parent = path.slice(0, -1).reduce<unknown>((acc, key) => (isRecord(acc) || Array.isArray(acc) ? (acc as Record<string, unknown>)[key] : undefined), doc);
    const key = path.at(-1) as string;
    if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : Number(key);
      if (op.op === "add") parent.splice(index, 0, structuredClone(op.value));
      else if (op.op === "replace") parent[index] = structuredClone(op.value);
      else if (op.op === "remove") parent.splice(index, 1);
    } else if (isRecord(parent)) {
      if (op.op === "add" || op.op === "replace") parent[key] = structuredClone(op.value);
      else if (op.op === "remove") delete parent[key];
    }
  }
  return doc;
}

function withMessage(state: ChatState, id: string, role: ChatMessage["role"], update: (m: ChatMessage) => ChatMessage): ChatState {
  const index = state.messages.findIndex(m => m.id === id);
  if (index === -1) return { ...state, messages: [...state.messages, update({ id, role, parts: [] })] };
  const messages = state.messages.slice();
  messages[index] = update(messages[index] as ChatMessage);
  return { ...state, messages };
}

/** The assistant message a part without a message id belongs to: the newest one of this run. */
function currentAssistantId(state: ChatState): string {
  const last = [...state.messages].reverse().find(m => m.role === "assistant");
  return last?.id ?? `run-${state.runId ?? "local"}`;
}

function appendText(m: ChatMessage, kind: "text" | "reasoning", delta: string): ChatMessage {
  const last = m.parts.at(-1);
  if (last?.type === kind) {
    return { ...m, parts: [...m.parts.slice(0, -1), { type: kind, text: last.text + delta }] };
  }
  return { ...m, parts: [...m.parts, { type: kind, text: delta }] };
}

function updateTool(state: ChatState, toolCallId: string, update: (p: Extract<Part, { type: "tool" }>) => Part): ChatState {
  const messages = state.messages.map(m => ({
    ...m,
    parts: m.parts.map(p => (p.type === "tool" && p.id === toolCallId ? update(p) : p)),
  }));
  return { ...state, messages };
}

function addResources(state: ChatState, refs: ResourceRef[]): ChatState {
  if (!refs.length) return state;
  const known = new Set(state.resources.map(refKey));
  const fresh = refs.filter(r => !known.has(refKey(r)));
  return fresh.length ? { ...state, resources: [...state.resources, ...fresh] } : state;
}

/** Applies one AG-UI event. */
export function applyEvent(state: ChatState, event: AgUiEvent): ChatState {
  switch (event.type) {
    case "RUN_STARTED":
      return { ...state, running: true, runId: event.runId, error: undefined, steps: [] };
    case "RUN_FINISHED": {
      const next = { ...state, running: false, steps: [] };
      if (event.outcome?.type === "interrupt") {
        return withMessage(next, currentAssistantId(next), "assistant", m => ({
          ...m,
          parts: [...m.parts, { type: "approval", interrupts: event.outcome?.type === "interrupt" ? (event.outcome.interrupts ?? []) : [] }],
        }));
      }
      return next;
    }
    case "RUN_ERROR":
      return withMessage({ ...state, running: false, error: event.message }, currentAssistantId(state), "assistant", m => ({
        ...m,
        parts: [...m.parts, { type: "error", message: event.message }],
      }));
    case "STEP_STARTED":
      return { ...state, steps: [...state.steps, event.stepName] };
    case "STEP_FINISHED":
      return { ...state, steps: state.steps.filter(s => s !== event.stepName) };
    case "TEXT_MESSAGE_START":
      return withMessage(state, event.messageId, event.role === "user" ? "user" : "assistant", m => m);
    case "TEXT_MESSAGE_CONTENT":
      return withMessage(state, event.messageId, "assistant", m => appendText(m, "text", event.delta));
    case "TEXT_MESSAGE_CHUNK":
      if (!event.delta) return state;
      return withMessage(state, event.messageId ?? currentAssistantId(state), "assistant", m => appendText(m, "text", event.delta ?? ""));
    case "TEXT_MESSAGE_END":
      return state;
    case "REASONING_MESSAGE_START":
      return withMessage(state, event.messageId, "assistant", m => m);
    case "REASONING_MESSAGE_CONTENT":
      return withMessage(state, event.messageId, "assistant", m => appendText(m, "reasoning", event.delta));
    case "REASONING_MESSAGE_CHUNK":
      if (!event.delta) return state;
      return withMessage(state, event.messageId ?? currentAssistantId(state), "assistant", m => appendText(m, "reasoning", event.delta ?? ""));
    case "REASONING_MESSAGE_END":
      return state;
    case "TOOL_CALL_START":
      return withMessage(state, event.parentMessageId ?? currentAssistantId(state), "assistant", m => ({
        ...m,
        parts: [...m.parts, { type: "tool", id: event.toolCallId, name: event.toolCallName, args: "", status: "running", resources: [] }],
      }));
    case "TOOL_CALL_ARGS":
      return updateTool(state, event.toolCallId, p => ({ ...p, args: p.args + event.delta }));
    case "TOOL_CALL_END":
      return updateTool(state, event.toolCallId, p => ({ ...p, input: p.args ? parseJson(p.args) : undefined }));
    case "TOOL_CALL_CHUNK": {
      if (!event.toolCallId) return state;
      const exists = state.messages.some(m => m.parts.some(p => p.type === "tool" && p.id === event.toolCallId));
      const id = event.toolCallId;
      const started = exists
        ? state
        : withMessage(state, event.parentMessageId ?? currentAssistantId(state), "assistant", m => ({
            ...m,
            parts: [...m.parts, { type: "tool", id, name: event.toolCallName ?? "tool", args: "", status: "running", resources: [] }],
          }));
      return event.delta ? updateTool(started, id, p => ({ ...p, args: p.args + (event.delta ?? "") })) : started;
    }
    case "TOOL_CALL_RESULT": {
      const result = parseJson(event.content);
      const refs = extractResourceRefs(result);
      const failed = isRecord(result) && (typeof result.error === "string" || result.isError === true);
      const next = updateTool(state, event.toolCallId, p => ({
        ...p,
        result,
        status: failed ? "error" : "done",
        error: failed ? String((result as { error?: unknown }).error ?? "The tool failed.") : undefined,
        resources: refs,
      }));
      return addResources(next, refs);
    }
    case "STATE_SNAPSHOT":
      return { ...state, state: event.snapshot };
    case "STATE_DELTA":
      return { ...state, state: applyPatch(state.state, event.delta) };
    case "MESSAGES_SNAPSHOT":
      return { ...state, messages: event.messages.map(fromAgUiMessage) };
    case "CUSTOM": {
      if (event.name === "texera.resource") {
        const refs = extractResourceRefs(event.value);
        if (!refs.length) return state;
        const next = addResources(state, refs);
        return withMessage(next, currentAssistantId(next), "assistant", m => ({
          ...m,
          parts: [...m.parts, ...refs.map(ref => ({ type: "resource" as const, ref }))],
        }));
      }
      return state;
    }
    case "SUBAGENT_STARTED":
      return withMessage(state, event.parentMessageId ?? currentAssistantId(state), "assistant", m => ({
        ...m,
        parts: [...m.parts, { type: "subagent", id: event.subagentRunId, name: event.name, status: "running" }],
      }));
    case "SUBAGENT_FINISHED":
    case "SUBAGENT_ERROR": {
      const messages = state.messages.map(m => ({
        ...m,
        parts: m.parts.map(p =>
          p.type === "subagent" && p.id === event.subagentRunId
            ? { ...p, status: event.type === "SUBAGENT_ERROR" ? ("error" as const) : ("done" as const), error: event.type === "SUBAGENT_ERROR" ? event.message : undefined }
            : p
        ),
      }));
      return { ...state, messages };
    }
    default:
      return state;
  }
}

function fromAgUiMessage(m: AgUiMessage): ChatMessage {
  const parts: Part[] = [];
  const text = typeof m.content === "string" ? m.content : (m.content ?? []).map(c => c.text ?? "").join("");
  if (text) parts.push({ type: m.role === "reasoning" ? "reasoning" : "text", text });
  for (const call of m.toolCalls ?? []) {
    parts.push({ type: "tool", id: call.id, name: call.function.name, args: call.function.arguments, input: parseJson(call.function.arguments), status: "done", resources: [] });
  }
  const role: ChatMessage["role"] = m.role === "user" ? "user" : m.role === "tool" ? "tool" : m.role === "system" || m.role === "developer" ? "system" : "assistant";
  return { id: m.id, role, parts };
}

/** The catalog's persisted messages as the view model; tool results attach to their calls. */
export function fromHistory(messages: CatalogMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const tools = new Map<string, Extract<Part, { type: "tool" }>>();
  for (const m of messages) {
    const parts: Part[] = [];
    for (const p of m.parts) {
      switch (p.type) {
        case "text":
          if (p.text) parts.push({ type: "text", text: p.text });
          break;
        case "reasoning":
          if (p.text) parts.push({ type: "reasoning", text: p.text });
          break;
        case "tool_call": {
          const part: Extract<Part, { type: "tool" }> = {
            type: "tool",
            id: p.toolCallId ?? crypto.randomUUID(),
            name: p.toolName ?? "tool",
            args: typeof p.args === "string" ? p.args : JSON.stringify(p.args ?? {}),
            input: p.args,
            status: "done",
            resources: extractResourceRefs(p.result),
            result: p.result,
          };
          tools.set(part.id, part);
          parts.push(part);
          break;
        }
        case "tool_result": {
          const refs = extractResourceRefs(p.result);
          const call = p.toolCallId ? tools.get(p.toolCallId) : undefined;
          if (call) {
            call.result = p.result;
            call.resources = refs;
          } else {
            parts.push({ type: "tool", id: p.toolCallId ?? crypto.randomUUID(), name: p.toolName ?? "tool", args: "", result: p.result, status: "done", resources: refs });
          }
          break;
        }
        case "resource":
          {
            const kind = p.resource ? kindOf(p) : undefined;
            if (p.resource && kind) parts.push({ type: "resource", ref: { kind, rid: p.resource.rid, vno: p.resource.vno } });
          }
          break;
        case "file":
          parts.push({ type: "text", text: `[file: ${String(p.file?.name ?? "attachment")}]` });
          break;
        case "error":
          parts.push({ type: "error", message: p.text ?? "Something went wrong." });
          break;
      }
    }
    if (parts.length === 0 && m.role !== "tool") continue;
    if (m.role === "tool" && parts.every(p => p.type === "tool" && tools.has(p.id))) continue;
    out.push({ id: `seq-${m.seq}`, role: m.role, parts, seq: m.seq, createdAt: m.createdAt });
  }
  return out;
}

/** A persisted resource part names its kind; a part from an older runtime without one is skipped. */
function kindOf(p: CatalogMessage["parts"][number]): KindId | undefined {
  const kind = p.resource?.kind;
  return isKind(kind) ? kind : undefined;
}

/** Every resource the conversation's messages reference, in order. */
export function resourcesOf(messages: ChatMessage[]): ResourceRef[] {
  return dedupe(messages.flatMap(m => m.parts.flatMap(p => (p.type === "tool" ? p.resources : p.type === "resource" ? [p.ref] : []))));
}
