// The conversation view model: messages made of parts, built from the catalog's history
// and from AG-UI events as a turn streams. Pure; the hook feeds it.

import type { Message as CatalogMessage } from "@texera/catalog-client/types";
import { isKindId, isUri, type KindId, refKey, refOf, type ResourceRef, uriOf } from "@texera/kinds";
import type { AgUiEvent, AgUiMessage, JsonPatchOperation } from "./agui/types";

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
  | { type: "handoff"; from?: string; to: string; name: string; by: "agent" | "person" }
  | { type: "error"; message: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  parts: Part[];
  /** For an assistant message: the template version (a URI with `@vno`) that wrote it. */
  template?: string;
  /** For an assistant message the catalog holds: the model endpoint that wrote it. */
  model?: string;
  /** The person whose message this is, or whose turn an assistant message answered. */
  author?: string;
  seq?: number;
  createdAt?: string;
}

export interface ChatState {
  messages: ChatMessage[];
  running: boolean;
  runId?: string;
  /** The template version writing now; set when the turn starts, changed by a handoff. */
  template?: string;
  /** The agent's shared state (AG-UI StateSnapshot/StateDelta), when it exposes one. */
  state?: unknown;
  steps: string[];
  error?: string;
  /** Every resource the turn touched, in order of first appearance. */
  resources: ResourceRef[];
}

export const EMPTY_STATE: ChatState = { messages: [], running: false, steps: [], resources: [] };

/**
 * What stays on screen once the catalog has the turn: its copy replaces the live one, except an
 * error it never got (the connection dropped, say), which would otherwise vanish with no trace.
 */
export function settled(live: ChatState, catalogHasTheError: boolean): ChatState {
  if (!live.error || catalogHasTheError) return EMPTY_STATE;
  return { ...EMPTY_STATE, error: live.error, messages: [{ id: `error-${live.runId ?? "turn"}`, role: "assistant", parts: [{ type: "error", message: live.error }] }] };
}

/** A message's parts as they show: each resource once, however many of its tools named it. */
export function visibleParts(parts: Part[]): Part[] {
  const seen = new Set<string>();
  return parts.filter(p => {
    if (p.type !== "resource") return true;
    const key = `${p.ref.kind}:${p.ref.rid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A person's message as a run's input: attachments go by URI, as AG-UI binary content. */
export function messageContent(text: string, attachments: { ref: ResourceRef; name: string }[]): NonNullable<AgUiMessage["content"]> {
  if (attachments.length === 0) return text;
  return [
    ...(text ? [{ type: "text", text }] : []),
    ...attachments.map(a => ({ type: "binary", mimeType: "application/vnd.texera.resource", url: uriOf(a.ref), filename: a.name })),
  ];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isKind = (v: unknown): v is KindId => typeof v === "string" && isKindId(v);

/**
 * Resource references inside a tool result or an event, in the shapes the catalog and the
 * runtime use: an envelope (`{kind, metadata: {rid, uri, parent}}`), a ref (`{kind, rid, uri?,
 * vno?}`), a `texera://` URI, or lists and wrappers of those.
 */
export function extractResourceRefs(value: unknown, depth = 0): ResourceRef[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === "string") {
    const ref = isUri(value) ? refOf(value) : undefined;
    return ref ? [ref] : [];
  }
  if (typeof value !== "object") return [];
  if (Array.isArray(value)) return dedupe(value.flatMap(v => extractResourceRefs(v, depth + 1)));
  const r = value as Record<string, unknown>;
  const found: ResourceRef[] = [];
  const metadata = isRecord(r.metadata) ? r.metadata : undefined;
  if (isKind(r.kind) && metadata && typeof metadata.rid === "string") {
    found.push({ kind: r.kind, rid: metadata.rid, ...(typeof metadata.parent === "string" ? { parent: metadata.parent } : {}) });
  } else if (isKind(r.kind) && typeof r.rid === "string") {
    const fromUri = typeof r.uri === "string" ? refOf(r.uri) : undefined;
    found.push(fromUri ?? { kind: r.kind, rid: r.rid, ...(typeof r.vno === "number" ? { vno: r.vno } : {}) });
  } else if (typeof r.uri === "string" && isUri(r.uri)) {
    const ref = refOf(r.uri);
    if (ref) found.push(ref);
  }
  for (const key of ["resource", "resources", "workflow", "dataset", "version", "execution", "items", "result", "data", "structuredContent"]) {
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

/**
 * What a failed tool said, or undefined when it did not fail: a plain `{error}`, or the text of an
 * MCP error result. The catalog's tools answer `<status>: <its JSON error>`; its message is the words.
 */
export function toolFailure(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  if (typeof result.error === "string") return result.error;
  if (result.isError !== true) return undefined;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.flatMap(c => (isRecord(c) && typeof c.text === "string" ? [c.text] : [])).join("\n");
  const json = /^\d{3}: (\{.*\})$/s.exec(text)?.[1];
  const parsed = json ? parseJson(json) : undefined;
  if (isRecord(parsed) && typeof parsed.message === "string" && parsed.message) return parsed.message;
  return text || "The tool failed.";
}

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
  if (index === -1) {
    const fresh: ChatMessage = { id, role, parts: [], ...(role === "assistant" && state.template ? { template: state.template } : {}) };
    return { ...state, messages: [...state.messages, update(fresh)] };
  }
  const messages = state.messages.slice();
  messages[index] = update(messages[index] as ChatMessage);
  return { ...state, messages };
}

/** The assistant message a part without a message id belongs to: the newest one of this turn. */
function currentAssistantId(state: ChatState): string {
  const last = [...state.messages].reverse().find(m => m.role === "assistant");
  return last?.id ?? `run-${state.runId ?? "local"}`;
}

function appendText(m: ChatMessage, kind: "text" | "reasoning", delta: string): ChatMessage {
  const last = m.parts.at(-1);
  if (last?.type === kind) return { ...m, parts: [...m.parts.slice(0, -1), { type: kind, text: last.text + delta }] };
  return { ...m, parts: [...m.parts, { type: kind, text: delta }] };
}

function updateTool(state: ChatState, toolCallId: string, update: (p: Extract<Part, { type: "tool" }>) => Part): ChatState {
  const messages = state.messages.map(m => ({ ...m, parts: m.parts.map(p => (p.type === "tool" && p.id === toolCallId ? update(p) : p)) }));
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
    case "RUN_FINISHED":
      return { ...state, running: false, steps: [] };
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
      const failure = toolFailure(result);
      const next = updateTool(state, event.toolCallId, p => ({
        ...p,
        result,
        status: failure ? "error" : "done",
        error: failure,
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
        return withMessage(next, currentAssistantId(next), "assistant", m => ({ ...m, parts: [...m.parts, ...refs.map(ref => ({ type: "resource" as const, ref }))] }));
      }
      if (event.name === "texera.handoff" && isRecord(event.value) && typeof event.value.to === "string") {
        const v = event.value as { from?: string; to: string; name?: string; by?: string };
        const part: Part = { type: "handoff", from: v.from, to: v.to, name: v.name ?? "another agent", by: v.by === "person" ? "person" : "agent" };
        // The handoff closes the current assistant message; the next one belongs to the new template.
        const id = `handoff-${state.messages.length}-${v.to}`;
        return withMessage({ ...state, template: v.to }, id, "system", m => ({ ...m, parts: [part] }));
      }
      return state;
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
            resources: [],
          };
          tools.set(part.id, part);
          parts.push(part);
          break;
        }
        case "tool_result": {
          const refs = extractResourceRefs(p.result);
          const failure = toolFailure(p.result);
          const call = p.toolCallId ? tools.get(p.toolCallId) : undefined;
          if (call) {
            call.result = p.result;
            call.resources = refs;
            if (failure) {
              call.status = "error";
              call.error = failure;
            }
          } else {
            parts.push({ type: "tool", id: p.toolCallId ?? crypto.randomUUID(), name: p.toolName ?? "tool", args: "", result: p.result, status: failure ? "error" : "done", error: failure, resources: refs });
          }
          break;
        }
        case "resource": {
          const ref = p.resource ? refOf(p.resource) : undefined;
          if (ref) parts.push({ type: "resource", ref });
          break;
        }
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
    if (m.role === "system") {
      // A system note naming an agent template records a change of hands: by the template that
      // wrote the note (a handoff), or by the person (no template).
      const to = parts.find(p => p.type === "resource" && p.ref.kind === "agent-template");
      if (to?.type === "resource") {
        const uri = m.parts.find(p => p.type === "resource")?.resource ?? "";
        out.push({ id: `seq-${m.seq}`, role: "system", seq: m.seq, createdAt: m.createdAt, parts: [{ type: "handoff", from: m.template, to: uri, name: "", by: m.template ? "agent" : "person" }] });
        continue;
      }
    }
    out.push({
      id: `seq-${m.seq}`,
      role: m.role,
      parts,
      seq: m.seq,
      createdAt: m.createdAt,
      author: m.author,
      ...(m.template ? { template: m.template } : {}),
      ...(m.modelEndpoint ? { model: m.modelEndpoint } : {}),
    });
  }
  return out;
}

/** Every resource the conversation's messages reference, in order. */
export function resourcesOf(messages: ChatMessage[]): ResourceRef[] {
  return dedupe(messages.flatMap(m => m.parts.flatMap(p => (p.type === "tool" ? p.resources : p.type === "resource" ? [p.ref] : []))));
}

/** What the messages were written by, in order of first appearance: agent versions, and the models they used. */
export function writersOf(messages: ChatMessage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    for (const uri of [m.template, m.model, ...m.parts.flatMap(p => (p.type === "handoff" ? [p.to, p.from] : []))]) {
      if (uri && !seen.has(uri)) {
        seen.add(uri);
        out.push(uri);
      }
    }
  }
  return out;
}
