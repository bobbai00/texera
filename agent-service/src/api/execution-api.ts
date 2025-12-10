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

/**
 * Execution API client for Texera Agent Service.
 * Provides WebSocket-based workflow execution capabilities.
 */

import WebSocket from "ws";
import { EventEmitter } from "events";
import { getBackendConfig } from "./backend-api";
import type {
  ExecutionState,
  ExecutionStateInfo,
  OperatorStatistics,
  ConsoleMessage,
  OperatorResultInfo,
  PaginatedOperatorResultInfo,
} from "../types/execution";
import { ExecutionState as ExecState } from "../types/execution";

// ============================================================================
// WebSocket Message Types (mirrored from frontend)
// ============================================================================

export interface LogicalLink {
  fromOpId: string;
  fromPortId: { id: number; internal: boolean };
  toOpId: string;
  toPortId: { id: number; internal: boolean };
}

export interface LogicalOperator {
  operatorID: string;
  operatorType: string;
  [key: string]: any;
}

export interface LogicalPlan {
  operators: LogicalOperator[];
  links: LogicalLink[];
  opsToViewResult?: string[];
  opsToReuseResult?: string[];
}

export interface WorkflowExecuteRequest {
  type: "WorkflowExecuteRequest";
  executionName: string;
  engineVersion: string;
  logicalPlan: LogicalPlan;
}

export interface WorkflowKillRequest {
  type: "WorkflowKillRequest";
}

export interface WorkflowPauseRequest {
  type: "WorkflowPauseRequest";
}

export interface WorkflowResumeRequest {
  type: "WorkflowResumeRequest";
}

export interface ResultPaginationRequest {
  type: "ResultPaginationRequest";
  requestID: string;
  operatorID: string;
  pageIndex: number;
  pageSize: number;
  noTruncation?: boolean;
}

export interface HeartBeatRequest {
  type: "HeartBeatRequest";
}

export type WebSocketRequest =
  | WorkflowExecuteRequest
  | WorkflowKillRequest
  | WorkflowPauseRequest
  | WorkflowResumeRequest
  | ResultPaginationRequest
  | HeartBeatRequest;

// ============================================================================
// WebSocket Event Types
// ============================================================================

export interface WorkflowStateEvent {
  type: "WorkflowStateEvent";
  state: ExecutionState;
}

export interface OperatorStatsUpdateEvent {
  type: "OperatorStatisticsUpdateEvent";
  operatorStatistics: Record<string, OperatorStatistics>;
}

export interface WorkflowFatalError {
  message: string;
  details: string;
  operatorId: string;
  workerId: string;
}

export interface WorkflowErrorEvent {
  type: "WorkflowErrorEvent";
  fatalErrors: WorkflowFatalError[];
}

export interface ConsoleUpdateEvent {
  type: "ConsoleUpdateEvent";
  operatorId: string;
  messages: ConsoleMessage[];
}

export interface WebResultUpdate {
  mode: { type: "PaginationMode" } | { type: "SetSnapshotMode" } | { type: "SetDeltaMode" };
  totalNumTuples?: number;
  table?: Record<string, any>[];
  dirtyPageIndices?: number[];
}

export interface WebResultUpdateEvent {
  type: "WebResultUpdateEvent";
  updates: Record<string, WebResultUpdate>;
  tableStats: Record<string, Record<string, Record<string, number>>>;
  sinkStorageMode: string;
}

export interface PaginatedResultEvent {
  type: "PaginatedResultEvent";
  requestID: string;
  operatorID: string;
  pageIndex: number;
  table: Record<string, any>[];
  schema: { attributeName: string; attributeType: string }[];
}

export interface WorkflowAvailableResultEvent {
  type: "WorkflowAvailableResultEvent";
  availableOperators: {
    operatorID: string;
    cacheValid: boolean;
    outputMode: { type: string };
  }[];
}

export interface HeartBeatResponse {
  type: "HeartBeatResponse";
}

export type WebSocketEvent =
  | WorkflowStateEvent
  | OperatorStatsUpdateEvent
  | WorkflowErrorEvent
  | ConsoleUpdateEvent
  | WebResultUpdateEvent
  | PaginatedResultEvent
  | WorkflowAvailableResultEvent
  | HeartBeatResponse;

// ============================================================================
// Execution Client
// ============================================================================

export interface ExecutionClientConfig {
  /** User JWT token for authentication */
  userToken: string;
  /** Workflow ID */
  workflowId: number;
  /** User ID */
  userId: number;
  /** Optional computing unit ID */
  computingUnitId?: number;
  /** Heartbeat interval in ms (default: 10000) */
  heartbeatInterval?: number;
  /** Connection timeout in ms (default: 30000) */
  connectionTimeout?: number;
}

export interface ExecutionResult {
  /** Final execution state */
  state: ExecutionStateInfo;
  /** Operator statistics at completion */
  operatorStats: Record<string, OperatorStatistics>;
  /** Operator results (paginated data) */
  operatorResults: Record<string, OperatorResultInfo>;
  /** Console logs per operator */
  consoleLogs: Record<string, ConsoleMessage[]>;
  /** Error messages if failed */
  errors: WorkflowFatalError[];
  /** Execution duration in ms */
  durationMs: number;
}

/**
 * WebSocket client for workflow execution.
 * Connects to Texera backend and manages execution lifecycle.
 */
export class ExecutionClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: ExecutionClientConfig;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectionPromise: Promise<void> | null = null;

  // Execution state
  private currentState: ExecutionStateInfo = { state: ExecState.Uninitialized };
  private operatorStats: Record<string, OperatorStatistics> = {};
  private operatorResults: Record<string, OperatorResultInfo> = {};
  private consoleLogs: Record<string, ConsoleMessage[]> = {};
  private errors: WorkflowFatalError[] = [];
  private executionStartTime: number = 0;

  // Pagination tracking
  private pendingPaginationRequests: Map<
    string,
    { resolve: (data: PaginatedResultEvent) => void; reject: (err: Error) => void }
  > = new Map();

  constructor(config: ExecutionClientConfig) {
    super();
    this.config = {
      heartbeatInterval: 10000,
      connectionTimeout: 30000,
      ...config,
    };
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Connect to the Texera WebSocket endpoint.
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    if (this.connectionPromise) {
      return this.connectionPromise; // Connection in progress
    }

    this.connectionPromise = this.doConnect();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const backendConfig = getBackendConfig();
      const wsEndpoint = backendConfig.wsEndpoint || "ws://localhost:8085";

      // Build WebSocket URL with auth params
      let url = `${wsEndpoint}/wsapi/workflow-websocket?wid=${this.config.workflowId}&uid=${this.config.userId}`;
      if (this.config.computingUnitId !== undefined) {
        url += `&cuid=${this.config.computingUnitId}`;
      }
      url += `&access-token=${this.config.userToken}`;

      console.log(`[ExecutionClient] Connecting to ${wsEndpoint}/wsapi/workflow-websocket`);

      const timeout = setTimeout(() => {
        if (this.ws) {
          this.ws.close();
        }
        reject(new Error("WebSocket connection timeout"));
      }, this.config.connectionTimeout);

      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        console.log("[ExecutionClient] WebSocket connected");
        this.startHeartbeat();
        this.emit("connected");
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString()) as WebSocketEvent;
          this.handleMessage(message);
        } catch (err) {
          console.error("[ExecutionClient] Failed to parse message:", err);
        }
      });

      this.ws.on("error", (err: Error) => {
        clearTimeout(timeout);
        console.error("[ExecutionClient] WebSocket error:", err);
        this.emit("error", err);
        reject(err);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        console.log(`[ExecutionClient] WebSocket closed: ${code} ${reason.toString()}`);
        this.stopHeartbeat();
        this.emit("disconnected", { code, reason: reason.toString() });
      });
    });
  }

  /**
   * Disconnect from the WebSocket.
   */
  disconnect(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    // Reject any pending pagination requests
    for (const [requestId, { reject }] of this.pendingPaginationRequests) {
      reject(new Error("Connection closed"));
    }
    this.pendingPaginationRequests.clear();
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "HeartBeatRequest" });
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ============================================================================
  // Message Handling
  // ============================================================================

  private send(request: WebSocketRequest): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[ExecutionClient] Cannot send - WebSocket not connected");
      return;
    }
    this.ws.send(JSON.stringify(request));
  }

  private handleMessage(message: WebSocketEvent): void {
    switch (message.type) {
      case "WorkflowStateEvent":
        this.handleStateUpdate(message);
        break;
      case "OperatorStatisticsUpdateEvent":
        this.handleStatsUpdate(message);
        break;
      case "WorkflowErrorEvent":
        this.handleErrorEvent(message);
        break;
      case "ConsoleUpdateEvent":
        this.handleConsoleUpdate(message);
        break;
      case "WebResultUpdateEvent":
        this.handleResultUpdate(message);
        break;
      case "PaginatedResultEvent":
        this.handlePaginatedResult(message);
        break;
      case "WorkflowAvailableResultEvent":
        this.emit("availableResults", message.availableOperators);
        break;
      case "HeartBeatResponse":
        // Ignore heartbeat responses
        break;
      default:
        // Unknown message type
        break;
    }
  }

  private handleStateUpdate(event: WorkflowStateEvent): void {
    const prevState = this.currentState.state;
    this.currentState = { state: event.state } as ExecutionStateInfo;
    this.emit("stateChange", this.currentState);

    // Check for terminal states
    if (this.isTerminalState(event.state) && !this.isTerminalState(prevState)) {
      this.emit("executionComplete", this.getExecutionResult());
    }
  }

  private handleStatsUpdate(event: OperatorStatsUpdateEvent): void {
    this.operatorStats = { ...this.operatorStats, ...event.operatorStatistics };
    this.emit("statsUpdate", this.operatorStats);
  }

  private handleErrorEvent(event: WorkflowErrorEvent): void {
    this.errors.push(...event.fatalErrors);
    this.currentState = {
      state: ExecState.Failed,
      errorMessages: this.errors,
    } as ExecutionStateInfo;
    this.emit("error", event.fatalErrors);
  }

  private handleConsoleUpdate(event: ConsoleUpdateEvent): void {
    const operatorId = event.operatorId;
    if (!this.consoleLogs[operatorId]) {
      this.consoleLogs[operatorId] = [];
    }
    this.consoleLogs[operatorId].push(...event.messages);
    this.emit("consoleUpdate", { operatorId, messages: event.messages });
  }

  private handleResultUpdate(event: WebResultUpdateEvent): void {
    for (const [operatorId, update] of Object.entries(event.updates)) {
      if (update.mode.type === "PaginationMode") {
        // Store pagination metadata
        this.operatorResults[operatorId] = {
          mode: "table",
          totalRows: update.totalNumTuples || 0,
          displayedRows: 0,
          estimatedTokens: 0,
          truncated: false,
          result: [],
        };
      } else if (update.table) {
        // Store snapshot/delta data
        this.operatorResults[operatorId] = {
          mode: "table",
          totalRows: update.table.length,
          displayedRows: update.table.length,
          estimatedTokens: this.estimateTokens(update.table),
          truncated: false,
          result: update.table,
        };
      }
    }
    this.emit("resultUpdate", event.updates);
  }

  private handlePaginatedResult(event: PaginatedResultEvent): void {
    // Resolve pending pagination request
    const pending = this.pendingPaginationRequests.get(event.requestID);
    if (pending) {
      pending.resolve(event);
      this.pendingPaginationRequests.delete(event.requestID);
    }

    // Update stored results
    const existingResult = this.operatorResults[event.operatorID] as PaginatedOperatorResultInfo | undefined;
    if (existingResult && existingResult.mode === "table") {
      existingResult.result = event.table;
      existingResult.displayedRows = event.table.length;
      existingResult.estimatedTokens = this.estimateTokens(event.table);
    }

    this.emit("paginatedResult", event);
  }

  private isTerminalState(state: ExecutionState): boolean {
    return [ExecState.Completed, ExecState.Failed, ExecState.Killed, ExecState.Terminated].includes(state as ExecState);
  }

  private estimateTokens(data: any): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(JSON.stringify(data).length / 4);
  }

  // ============================================================================
  // Execution Operations
  // ============================================================================

  /**
   * Execute a workflow with the given logical plan.
   * Returns a promise that resolves when execution completes.
   */
  async executeWorkflow(logicalPlan: LogicalPlan, executionName?: string): Promise<ExecutionResult> {
    await this.connect();

    // Reset state
    this.currentState = { state: ExecState.Uninitialized };
    this.operatorStats = {};
    this.operatorResults = {};
    this.consoleLogs = {};
    this.errors = [];
    this.executionStartTime = Date.now();

    return new Promise((resolve, reject) => {
      const onComplete = (result: ExecutionResult) => {
        this.removeListener("executionComplete", onComplete);
        this.removeListener("error", onError);
        resolve(result);
      };

      const onError = (errors: WorkflowFatalError[]) => {
        this.removeListener("executionComplete", onComplete);
        this.removeListener("error", onError);
        // Don't reject - let executionComplete handle it
      };

      this.once("executionComplete", onComplete);
      this.on("error", onError);

      // Send execute request
      this.send({
        type: "WorkflowExecuteRequest",
        executionName: executionName || `execution-${Date.now()}`,
        engineVersion: "1.0",
        logicalPlan,
      });
    });
  }

  /**
   * Kill the current workflow execution.
   */
  async killWorkflow(): Promise<void> {
    if (!this.isConnected()) {
      throw new Error("Not connected");
    }
    this.send({ type: "WorkflowKillRequest" });
  }

  /**
   * Pause the current workflow execution.
   */
  async pauseWorkflow(): Promise<void> {
    if (!this.isConnected()) {
      throw new Error("Not connected");
    }
    this.send({ type: "WorkflowPauseRequest" });
  }

  /**
   * Resume the current workflow execution.
   */
  async resumeWorkflow(): Promise<void> {
    if (!this.isConnected()) {
      throw new Error("Not connected");
    }
    this.send({ type: "WorkflowResumeRequest" });
  }

  /**
   * Request paginated results for an operator.
   */
  async requestPaginatedResult(
    operatorId: string,
    pageIndex: number,
    pageSize: number = 10
  ): Promise<PaginatedResultEvent> {
    if (!this.isConnected()) {
      throw new Error("Not connected");
    }

    const requestId = `pagination-${operatorId}-${pageIndex}-${Date.now()}`;

    return new Promise((resolve, reject) => {
      // Set timeout for pagination request
      const timeout = setTimeout(() => {
        this.pendingPaginationRequests.delete(requestId);
        reject(new Error("Pagination request timeout"));
      }, 30000);

      this.pendingPaginationRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.send({
        type: "ResultPaginationRequest",
        requestID: requestId,
        operatorID: operatorId,
        pageIndex,
        pageSize,
      });
    });
  }

  // ============================================================================
  // State Accessors
  // ============================================================================

  /**
   * Get the current execution state.
   */
  getExecutionState(): ExecutionStateInfo {
    return this.currentState;
  }

  /**
   * Get current operator statistics.
   */
  getOperatorStats(): Record<string, OperatorStatistics> {
    return { ...this.operatorStats };
  }

  /**
   * Get current operator results.
   */
  getOperatorResults(): Record<string, OperatorResultInfo> {
    return { ...this.operatorResults };
  }

  /**
   * Get console logs for all operators.
   */
  getConsoleLogs(): Record<string, ConsoleMessage[]> {
    return { ...this.consoleLogs };
  }

  /**
   * Get execution errors.
   */
  getErrors(): WorkflowFatalError[] {
    return [...this.errors];
  }

  /**
   * Get complete execution result.
   */
  getExecutionResult(): ExecutionResult {
    return {
      state: this.currentState,
      operatorStats: this.operatorStats,
      operatorResults: this.operatorResults,
      consoleLogs: this.consoleLogs,
      errors: this.errors,
      durationMs: Date.now() - this.executionStartTime,
    };
  }
}
