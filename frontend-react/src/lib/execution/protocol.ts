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

// What is said to execute a workflow. An execution is created by the Dashboard service (POST /api/executions,
// ExecutionResource.scala), which hands its plan to the computing unit, and the unit starts it. Everything after
// that is said over the unit's socket (/wsapi/workflow-websocket, WorkflowWebsocketResource.scala). Each message
// of the socket is JSON with a "type" that is the name of a Scala class: the requests are the subclasses of
// TexeraWebSocketRequest, the events those of TexeraWebSocketEvent. The engine refuses a request with a field it
// does not know, so a request holds exactly what is typed here. Only the events the app shows are typed.

import type { Attribute } from "@/lib/workflow/compilation";
import type { WorkflowSettings } from "@/lib/workflow/model";
import type { LogicalPlan } from "@/lib/workflow/plan";

/**
 * What POST /api/executions is asked to create (CreateExecutionRequest.scala). The route also takes
 * `targetOperatorId` and `replayFromExecution`, which the app leaves out: an execution up to an operator is sent
 * only the part of the workflow it needs (`logicalPlan(content, operatorId)`), so that every operator in it that is
 * marked to keep its result keeps it, where the service's own cut keeps only the target's.
 */
export interface CreateExecutionRequest {
  wid: number;
  /** Empty for the default name. */
  executionName: string;
  /** The version of the app that asks for the execution, kept with it. */
  engineVersion: string;
  logicalPlan: LogicalPlan;
  workflowSettings: WorkflowSettings;
  emailNotificationEnabled: boolean;
  computingUnitId: number;
  /** Where the execution keeps its results: required on a deployment with warehouses, refused on one without. */
  warehouseId?: number;
}

/** What POST /api/executions answers (201) once the execution is created and its unit has started it. */
export interface CreateExecutionResponse {
  eid: number;
}

/**
 * What POST /api/executions answers (400) for a workflow that does not compile (CreateExecutionFailure.scala): the
 * execution, which is recorded as failed, and the first error of each operator that has one, by the operator's id.
 * The errors come in no order. Any other refusal is the service's {code, message} alone.
 */
export interface CreateExecutionFailure {
  code: number;
  message: string;
  eid: number;
  operatorErrors: Record<string, FatalError>;
}

/**
 * What GET /api/executions/{eid}/state answers (ExecutionStateResponse.scala): where the Dashboard service has an
 * execution stand, whether or not its unit still shows it. Its status is a code of WorkflowExecutionStatus.scala:
 * 0 initializing, 1 running, 2 paused, 3 completed, 4 failed, 5 killed, 6 created and started by no unit yet, and -1
 * for a state that could not be read.
 */
export interface ExecutionStateAnswer {
  eid: number;
  status: number;
  /** Whether the execution can still change state: false once the service has closed it. */
  open: boolean;
  /** Why it is in its state, when there is a reason to give, such as "unit lost". */
  reason?: string | null;
  /** When it took that state, or ended, in epoch milliseconds. */
  timeMs: number;
}

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

/**
 * A request over the socket. No execution is started over it. A pause, a resume and a kill name the execution they
 * are for, and the unit refuses them for any other than the one it holds.
 */
export type ExecutionRequest =
  | { type: "HeartBeatRequest" }
  | { type: "WorkflowPauseRequest"; executionId: number }
  | { type: "WorkflowResumeRequest"; executionId: number }
  | { type: "WorkflowKillRequest"; executionId: number }
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
  | {
      type: "WorkflowStateEvent";
      state: ExecutionState;
      /** The execution the state is of; left out for the state of no execution. */
      executionId?: number;
    }
  | {
      /** A request of this connection, and of no other, that the unit did not do. The execution is as it was. */
      type: "RequestRefusedEvent";
      /** The request's type, as its frame named it. */
      request?: string;
      /** The execution the request named. */
      executionId?: number;
      /** Why, in words for the user. */
      message: string;
    }
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
