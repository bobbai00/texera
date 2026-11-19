/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// The app's end of the engine's socket: one connection for a workflow on a computing unit. The engine sends
// everyone connected to the same workflow the same events, and tells whoever connects in the middle of an
// execution where it stands, so the execution a client shows may be one that someone else started. The client
// keeps what the events add up to, the snapshot, and tells its listeners when it changes.

import { getSession } from "@/lib/session";
import type { Attribute } from "@/lib/workflow/compilation";
import type { WorkflowSettings } from "@/lib/workflow/model";
import type { LogicalPlan } from "@/lib/workflow/plan";
import type { ExecutionEvent, ExecutionRequest, ExecutionState } from "./protocol";

/** What an operator is doing in the execution. */
export interface OperatorProgress {
  state: string;
  inputRows: number;
  outputRows: number;
}

/** What an operator has put out: rows to page through, or a visualization as a page of HTML. */
export type OperatorResult =
  { kind: "table"; totalRows: number; revision: number } | { kind: "visualization"; html: string; revision: number };

/** Why an execution failed. */
export interface ExecutionError {
  message: string;
  details?: string;
  /** The operator the error is about, when it is about one. */
  operatorId?: string;
}

export interface ConsoleMessage {
  /** The engine's kind of line, such as "PRINT" or "ERROR". */
  kind: string;
  title: string;
  message: string;
}

/** Everything the app knows of the workflow's latest execution on this computing unit. */
export interface ExecutionSnapshot {
  /** Whether the socket is open. Nothing can be started or asked for while it is not. */
  connected: boolean;
  state: ExecutionState;
  operators: Record<string, OperatorProgress>;
  results: Record<string, OperatorResult>;
  errors: ExecutionError[];
  console: Record<string, ConsoleMessage[]>;
}

/** One page of an operator's result. */
export interface ResultPage {
  rows: Record<string, unknown>[];
  columns: Attribute[];
}

/** The states in which an execution is under way, so that another cannot be started. */
export const activeStates: ReadonlySet<ExecutionState> = new Set([
  "Initializing",
  "Running",
  "Pausing",
  "Paused",
  "Resuming",
  "Recovering",
]);

const heartbeatMs = 10_000;
const reconnectMs = 3_000;
/** The lines kept for each operator. The engine itself keeps the last hundred. */
const consoleLines = 200;

const disconnected: ExecutionSnapshot = {
  connected: false,
  state: "Uninitialized",
  operators: {},
  results: {},
  errors: [],
  console: {},
};

export class ExecutionClient {
  private socket: WebSocket | undefined;
  private current = disconnected;
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly pages = new Map<string, { resolve: (page: ResultPage) => void; reject: (error: Error) => void }>();
  private readonly workflowId: number;
  private readonly computingUnitId: number;

  constructor(workflowId: number, computingUnitId: number) {
    this.workflowId = workflowId;
    this.computingUnitId = computingUnitId;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): ExecutionSnapshot => this.current;

  /** Opens the socket, and opens it again whenever it closes, until close() is called. */
  connect(): void {
    this.closed = false;
    const session = getSession();
    const url = new URL("/wsapi/workflow-websocket", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({
      wid: String(this.workflowId),
      uid: String(session?.userId ?? ""),
      cuid: String(this.computingUnitId),
      "access-token": session?.token ?? "",
    }).toString();
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.heartbeat = setInterval(() => this.send({ type: "HeartBeatRequest" }), heartbeatMs);
    };
    socket.onmessage = event => this.receive(JSON.parse(String(event.data)) as ExecutionEvent);
    socket.onclose = () => {
      clearInterval(this.heartbeat);
      for (const page of this.pages.values()) page.reject(new Error("The connection to the computing unit was lost."));
      this.pages.clear();
      this.update({ connected: false });
      if (!this.closed) this.reconnect = setTimeout(() => this.connect(), reconnectMs);
    };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.socket?.close();
  }

  /**
   * Starts an execution of the plan. It replaces the workflow's execution on this unit, whoever started that
   * one. Where the deployment has warehouses, the execution keeps its results in the one that is named.
   */
  start(plan: LogicalPlan, settings: WorkflowSettings, warehouseId?: number): void {
    this.update({ state: "Initializing", operators: {}, results: {}, errors: [], console: {} });
    this.send({
      type: "WorkflowExecuteRequest",
      executionName: "",
      engineVersion: "",
      logicalPlan: plan,
      workflowSettings: settings,
      emailNotificationEnabled: false,
      computingUnitId: this.computingUnitId,
      // The engine refuses a field it is given without a value, so the warehouse is there or left out.
      ...(warehouseId === undefined ? {} : { warehouseId }),
    });
  }

  pause(): void {
    this.send({ type: "WorkflowPauseRequest" });
  }

  resume(): void {
    this.send({ type: "WorkflowResumeRequest" });
  }

  /** Stops the execution for good. */
  kill(): void {
    this.send({ type: "WorkflowKillRequest" });
  }

  /** One page of an operator's result rows. The first page is page 1. */
  page(operatorId: string, pageIndex: number, pageSize: number): Promise<ResultPage> {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to the computing unit."));
        return;
      }
      const requestID = crypto.randomUUID();
      this.pages.set(requestID, { resolve, reject });
      this.send({ type: "ResultPaginationRequest", requestID, operatorID: operatorId, pageIndex, pageSize });
    });
  }

  private send(request: ExecutionRequest): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(request));
  }

  private update(change: Partial<ExecutionSnapshot>): void {
    this.current = { ...this.current, ...change };
    for (const listener of this.listeners) listener();
  }

  private receive(event: ExecutionEvent): void {
    switch (event.type) {
      case "WorkflowStateEvent":
        this.update({
          connected: true,
          state: event.state,
          operators: operatorsAt(event.state, this.current.operators),
        });
        return;
      case "OperatorStatisticsUpdateEvent":
        this.update({
          operators: operatorsAt(
            this.current.state,
            Object.fromEntries(
              Object.entries(event.operatorStatistics).map(([id, statistics]) => [
                id,
                {
                  state: statistics.operatorState,
                  inputRows: statistics.aggregatedInputRowCount,
                  outputRows: statistics.aggregatedOutputRowCount,
                },
              ])
            )
          ),
        });
        return;
      case "WebResultUpdateEvent": {
        const results = { ...this.current.results };
        for (const [id, { mode, totalNumTuples, table }] of Object.entries(event.updates)) {
          const revision = (results[id]?.revision ?? 0) + 1;
          // A snapshot's last row is the whole of it: a visualization, as a page of HTML.
          const html = table?.at(-1)?.["html-content"];
          if (mode.type === "PaginationMode") results[id] = { kind: "table", totalRows: totalNumTuples ?? 0, revision };
          else if (mode.type === "SetSnapshotMode" && typeof html === "string")
            results[id] = { kind: "visualization", html, revision };
        }
        this.update({ results });
        return;
      }
      case "WorkflowErrorEvent": {
        const errors = event.fatalErrors.map(({ message, details, operatorId }) => ({
          message,
          details: details || undefined,
          operatorId: operatorId && operatorId !== "unknown operator" ? operatorId : undefined,
        }));
        // The engine says "Failed" only through its errors.
        this.update({ errors, state: errors.length > 0 ? "Failed" : this.current.state });
        return;
      }
      case "ConsoleUpdateEvent": {
        const lines = event.messages.map(({ msgType, title, message }) => ({ kind: msgType.name, title, message }));
        const kept = [...(this.current.console[event.operatorId] ?? []), ...lines].slice(-consoleLines);
        this.update({ console: { ...this.current.console, [event.operatorId]: kept } });
        return;
      }
      case "PaginatedResultEvent": {
        this.pages.get(event.requestID)?.resolve({ rows: event.table, columns: event.schema });
        this.pages.delete(event.requestID);
        return;
      }
      default:
        if (!this.current.connected) this.update({ connected: true });
    }
  }
}

/**
 * The operators as they stand for an execution in a state. Once an execution has completed, so has each of its
 * operators: the engine's last word on an operator can be older than its last word on the execution.
 */
function operatorsAt(
  state: ExecutionState,
  operators: Record<string, OperatorProgress>
): Record<string, OperatorProgress> {
  if (state !== "Completed") return operators;
  return Object.fromEntries(Object.entries(operators).map(([id, progress]) => [id, { ...progress, state }]));
}
