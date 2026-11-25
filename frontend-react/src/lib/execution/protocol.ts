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

// What is said over the engine's socket (/wsapi/workflow-websocket, WorkflowWebsocketResource.scala). Each message
// is JSON with a "type" that is the name of a Scala class: the requests are the subclasses of
// TexeraWebSocketRequest, the events those of TexeraWebSocketEvent. The engine refuses a request with a field it
// does not know, so a request holds exactly what is typed here. Only the events the app shows are typed.

import type { Attribute } from "@/lib/workflow/compilation";
import type { WorkflowSettings } from "@/lib/workflow/model";
import type { LogicalPlan } from "@/lib/workflow/plan";

/** The state of an execution, in the engine's words (Utils.aggregatedStateToString). */
export type ExecutionState =
  | "Uninitialized"
  | "Initializing"
  | "Running"
  | "Pausing"
  | "Paused"
  | "Resuming"
  | "Recovering"
  | "Completed"
  | "Failed"
  | "Killed"
  | "Terminated"
  | "Unknown";

export type ExecutionRequest =
  | { type: "HeartBeatRequest" }
  | {
      type: "WorkflowExecuteRequest";
      executionName: string;
      engineVersion: string;
      logicalPlan: LogicalPlan;
      workflowSettings: WorkflowSettings;
      emailNotificationEnabled: boolean;
      computingUnitId: number;
      /** Where the execution keeps its results. A deployment with warehouses refuses an execution without one. */
      warehouseId?: number;
    }
  | { type: "WorkflowPauseRequest" }
  | { type: "WorkflowResumeRequest" }
  | { type: "WorkflowKillRequest" }
  | { type: "ResultPaginationRequest"; requestID: string; operatorID: string; pageIndex: number; pageSize: number };

/** What the engine knows of one operator while it executes (OperatorAggregatedMetrics). */
export interface OperatorStatistics {
  operatorState: string;
  aggregatedInputRowCount: number;
  aggregatedOutputRowCount: number;
  numWorkers: number;
}

/** An error that ends an execution, or keeps it from starting (WorkflowFatalError in workflowruntimestate.proto). */
export interface FatalError {
  message: string;
  details?: string;
  /** "unknown operator" when the error is not about one operator. */
  operatorId?: string;
}

/** What an operator has put out so far (WebResultUpdate): rows to page through, or a single snapshot to show whole. */
export interface ResultUpdate {
  mode: { type: "PaginationMode" | "SetSnapshotMode" | "SetDeltaMode" };
  totalNumTuples?: number;
  table?: Record<string, unknown>[];
}

/** A line an operator printed, or one of the debugger's (ConsoleMessage in controlcommands.proto). */
export interface ConsoleMessageEvent {
  msgType: { name: string };
  title: string;
  message: string;
}

export type ExecutionEvent =
  | { type: "WorkflowStateEvent"; state: ExecutionState }
  | { type: "OperatorStatisticsUpdateEvent"; operatorStatistics: Record<string, OperatorStatistics> }
  | { type: "WebResultUpdateEvent"; updates: Record<string, ResultUpdate> }
  | { type: "WorkflowErrorEvent"; fatalErrors: FatalError[] }
  | { type: "ConsoleUpdateEvent"; operatorId: string; messages: ConsoleMessageEvent[] }
  | {
      type: "PaginatedResultEvent";
      requestID: string;
      operatorID: string;
      pageIndex: number;
      table: Record<string, unknown>[];
      schema: Attribute[];
    }
  // Heartbeats, and the events about workers, regions and the cluster, which the app does not show yet.
  | {
      type:
        | "HeartBeatResponse"
        | "ClusterStatusUpdateEvent"
        | "WorkerAssignmentUpdateEvent"
        | "ExecutionDurationUpdateEvent"
        | "RegionUpdateEvent"
        | "RegionStateEvent";
    };
