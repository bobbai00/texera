// The engine's workflow WebSocket, reached through the gateway at
// /units/{unit}/wsapi/workflow-websocket. Frames are `{type, ...}` with the engine's class
// names. Runs start through the catalog (POST /workflows/{rid}/executions); the socket
// carries live state, operator statistics, results and console output, and takes pause,
// resume and kill.

import type { Attribute } from "@texera/catalog-client/types";
import { engineToken } from "./config";

export type ExecutionState =
  | "Uninitialized"
  | "Initializing"
  | "Running"
  | "Pausing"
  | "Paused"
  | "Resuming"
  | "Recovering"
  | "Completed"
  | "Terminated"
  | "Failed"
  | "Killed";

export const ACTIVE_STATES: ReadonlySet<ExecutionState> = new Set([
  "Initializing",
  "Running",
  "Pausing",
  "Paused",
  "Resuming",
  "Recovering",
]);

export interface OperatorProgress {
  state: string;
  inputRows: number;
  outputRows: number;
}

export type OperatorOutput =
  | { kind: "table"; total: number; revision: number }
  | { kind: "visualization"; html?: string; revision: number };

export interface RunError {
  message: string;
  details?: string;
  operatorId?: string;
}

export interface ConsoleLine {
  kind: string;
  title: string;
  message: string;
}

export interface RunSnapshot {
  connected: boolean;
  state: ExecutionState;
  operators: Record<string, OperatorProgress>;
  outputs: Record<string, OperatorOutput>;
  errors: RunError[];
  console: Record<string, ConsoleLine[]>;
}

export interface ResultPage {
  rows: Record<string, unknown>[];
  schema: Attribute[];
}

const HEARTBEAT_MS = 10_000;
const RECONNECT_MS = 3_000;
const CONSOLE_LINES = 200;

export const IDLE_SNAPSHOT: RunSnapshot = {
  connected: false,
  state: "Uninitialized",
  operators: {},
  outputs: {},
  errors: [],
  console: {},
};

/** Builds the socket URL; exported for tests. */
export function engineSocketUrl(unitRid: string, workflowRid: string, token: string | undefined, origin: string): string {
  const url = new URL(`/units/${encodeURIComponent(unitRid)}/wsapi/workflow-websocket`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = new URLSearchParams({ wid: workflowRid, cuid: unitRid, ...(token ? { access_token: token } : {}) }).toString();
  return url.toString();
}

export class WorkflowRunner {
  private ws?: WebSocket;
  private snapshot: RunSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private closed = false;
  private pages = new Map<string, { resolve: (p: ResultPage) => void; reject: (e: Error) => void }>();

  readonly unitRid: string;
  readonly workflowRid: string;

  constructor(unitRid: string, workflowRid: string) {
    this.unitRid = unitRid;
    this.workflowRid = workflowRid;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private update(change: Partial<RunSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const l of this.listeners) l();
  }

  connect() {
    this.closed = false;
    const ws = new WebSocket(engineSocketUrl(this.unitRid, this.workflowRid, engineToken(), window.location.href));
    this.ws = ws;
    ws.onmessage = e => this.receive(JSON.parse(String(e.data)));
    ws.onclose = () => {
      clearInterval(this.heartbeat);
      this.update({ connected: false });
      for (const p of this.pages.values()) p.reject(new Error("Disconnected from the computing unit"));
      this.pages.clear();
      if (!this.closed) this.reconnect = setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.onopen = () => {
      this.update({ connected: true });
      this.heartbeat = setInterval(() => this.send({ type: "HeartBeatRequest" }), HEARTBEAT_MS);
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.ws?.close();
  }

  private send(frame: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  /** Clears the last run's results before a new run starts. */
  reset() {
    this.update({ state: "Initializing", errors: [], outputs: {}, operators: {}, console: {} });
  }

  kill = () => this.send({ type: "WorkflowKillRequest" });
  pause = () => this.send({ type: "WorkflowPauseRequest" });
  resume = () => this.send({ type: "WorkflowResumeRequest" });

  /** One page (1-based) of an operator's result rows. */
  page(operatorId: string, pageIndex: number, pageSize: number): Promise<ResultPage> {
    const requestID = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error("Not connected to the computing unit"));
      this.pages.set(requestID, { resolve, reject });
      this.send({ type: "ResultPaginationRequest", requestID, operatorID: operatorId, pageIndex, pageSize });
    });
  }

  /** Applies one engine frame to the snapshot; exported through `receive` for tests. */
  receive(event: { type: string } & Record<string, unknown>) {
    switch (event.type) {
      case "WorkflowStateEvent": {
        this.update({ connected: true, state: event.state as ExecutionState });
        return;
      }
      case "OperatorStatisticsUpdateEvent": {
        const stats = event.operatorStatistics as Record<
          string,
          { operatorState: string; aggregatedInputRowCount: number; aggregatedOutputRowCount: number }
        >;
        const operators: Record<string, OperatorProgress> = {};
        for (const [id, s] of Object.entries(stats)) {
          operators[id] = {
            state: s.operatorState,
            inputRows: s.aggregatedInputRowCount,
            outputRows: s.aggregatedOutputRowCount,
          };
        }
        this.update({ connected: true, operators });
        return;
      }
      case "WebResultUpdateEvent": {
        const updates = event.updates as Record<
          string,
          { mode: { type: string }; totalNumTuples?: number; table?: Record<string, unknown>[] }
        >;
        const outputs = { ...this.snapshot.outputs };
        for (const [id, u] of Object.entries(updates)) {
          const revision = (outputs[id]?.revision ?? 0) + 1;
          if (u.mode.type === "PaginationMode") outputs[id] = { kind: "table", total: u.totalNumTuples ?? 0, revision };
          else if (u.mode.type === "SetSnapshotMode") {
            const last = u.table?.at(-1);
            const html = typeof last?.["html-content"] === "string" ? (last["html-content"] as string) : undefined;
            outputs[id] = { kind: "visualization", html, revision };
          }
        }
        this.update({ outputs });
        return;
      }
      case "WorkflowErrorEvent": {
        const errors = ((event.fatalErrors as RunError[] | undefined) ?? []).map(e => ({
          message: e.message,
          details: e.details,
          operatorId: e.operatorId && e.operatorId !== "unknown operator" ? e.operatorId : undefined,
        }));
        this.update({ errors, state: errors.length ? "Failed" : this.snapshot.state });
        return;
      }
      case "ConsoleUpdateEvent": {
        const lines = (event.messages as { msgType: { name: string }; title: string; message: string }[]) ?? [];
        if (!lines.length) return;
        const id = event.operatorId as string;
        const previous = this.snapshot.console[id] ?? [];
        const next = [...previous, ...lines.map(l => ({ kind: l.msgType.name, title: l.title, message: l.message }))];
        this.update({ console: { ...this.snapshot.console, [id]: next.slice(-CONSOLE_LINES) } });
        return;
      }
      case "PaginatedResultEvent": {
        const pending = this.pages.get(event.requestID as string);
        if (!pending) return;
        this.pages.delete(event.requestID as string);
        pending.resolve({ rows: event.table as Record<string, unknown>[], schema: event.schema as Attribute[] });
        return;
      }
      default:
        if (!this.snapshot.connected) this.update({ connected: true });
    }
  }
}

// One runner per (unit, workflow) while any view of it is open.
const runners = new Map<string, { runner: WorkflowRunner; users: number }>();

export function acquireRunner(unitRid: string, workflowRid: string): WorkflowRunner {
  const key = `${unitRid}:${workflowRid}`;
  const entry = runners.get(key);
  if (entry) {
    entry.users++;
    return entry.runner;
  }
  const runner = new WorkflowRunner(unitRid, workflowRid);
  runner.connect();
  runners.set(key, { runner, users: 1 });
  return runner;
}

export function releaseRunner(runner: WorkflowRunner): void {
  const key = `${runner.unitRid}:${runner.workflowRid}`;
  const entry = runners.get(key);
  if (!entry || --entry.users > 0) return;
  runners.delete(key);
  runner.close();
}
