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

import { ExecutionState, OperatorStatsUpdate, WorkflowResultUpdateEvent } from "./execute-workflow.interface";
import { IndexableObject } from "./result-table.interface";
import { ConsoleUpdateEvent } from "./workflow-common.interface";
import { SchemaAttribute } from "./workflow-compiling.interface";

/**
 *  @fileOverview Type Definitions of WebSocket (Ws) API
 * WebSocket API can be either
 * either "Request" types - messages from frontend to server
 * or     "Event" types - messages from server to frontend.
 *
 * Each type definition MUST follow the following rules:
 * in either TexeraWebsocketRequestTypeMap or TexeraWebsocketEventTypeMap
 * add a map entry:
 * 1. key is the 'type' string, it must be the same as corresponding backend class name
 * 2. value is the payload this request/event needs
 */

/** Starts an execution the Dashboard service created, from its stored plan. */
export type WorkflowStartRequest = Readonly<{
  executionId: number;
  /** The execution's plan table, as `POST /api/executions` answered it. */
  planUri: string;
}>;

/** Applies, when the paused run of an execution resumes, a change to an operator that the Dashboard service stored. */
export type OperatorUpdateRequest = Readonly<{
  executionId: number;
  /** The id `POST /api/executions/{eid}/updates` answered with. */
  updateId: string;
}>;

/**
 * Tells this session that a request it sent was not done, and why. It says nothing about the run the
 * computing unit holds.
 */
export type RequestRefusedEvent = Readonly<{
  /** The type of the request, as its frame named it; left out for a frame that named none. */
  request?: string;
  /** The execution the request named, when it named one. */
  executionId?: number;
  message: string;
}>;

export interface WorkflowFatalError
  extends Readonly<{
    message: string;
    details: string;
    operatorId: string;
    workerId: string;
    type: {
      name: string;
    };
    timestamp: {
      nanos: number;
      seconds: number;
    };
  }> {}

export interface WorkflowErrorEvent
  extends Readonly<{
    fatalErrors: ReadonlyArray<WorkflowFatalError>;
  }> {}

export type WorkerTuples = Readonly<{
  workerID: string;
  tuple: ReadonlyArray<string>;
}>;

export type OperatorCurrentTuples = Readonly<{
  operatorID: string;
  tuples: ReadonlyArray<WorkerTuples>;
}>;

export type PaginationRequest = Readonly<{
  requestID: string;
  operatorID: string;
  pageIndex: number;
  pageSize: number;
  columnOffset?: number;
  columnLimit?: number;
  columnSearch?: string;
  // which of the operator's output ports to read; left out, the first
  portIndex?: number;
}>;

export type PaginatedResultEvent = Readonly<{
  requestID: string;
  operatorID: string;
  pageIndex: number;
  table: ReadonlyArray<IndexableObject>;
  schema: ReadonlyArray<SchemaAttribute>;
  portIndex: number;
  // the port's whole row count, for a port the running execution does not report on
  totalTuples: number;
}>;

export type OperatorResultCacheStatus = "cache invalid" | "cache valid";

export type PythonExpressionEvaluateRequest = Readonly<{
  expression: string;
  operatorId: string;
}>;
export type TypedValue = Readonly<{
  expression: string;
  valueRef: string;
  valueStr: string;
  valueType: string;
  expandable: boolean;
}>;
export type EvaluatedValue = Readonly<{
  value: TypedValue;
  attributes: TypedValue[];
}>;

export type PythonExpressionEvaluateResponse = Readonly<{
  expression: string;
  values: EvaluatedValue[];
}>;

export type WorkerAssignmentUpdateEvent = Readonly<{
  operatorId: string;
  workerIds: readonly string[];
}>;

export type ExecutionDurationUpdateEvent = Readonly<{
  duration: number;
  isRunning: boolean;
}>;

export type ClusterStatusUpdateEvent = Readonly<{
  numWorkers: number;
}>;

export type RegionUpdateEvent = Readonly<{
  regions: readonly [number, string[]][];
}>;

export type RegionStateEvent = Readonly<{
  id: number;
  state: string;
}>;

export type ModifyLogicResponse = Readonly<{
  opId: string;
  isValid: boolean;
  errorMessage: string;
}>;

export type ModifyLogicCompletedEvent = Readonly<{
  opIds: readonly string[];
}>;

export type DebugCommandRequest = Readonly<{
  operatorId: string;
  workerId: string;
  cmd: string;
}>;

/** The state of the run the computing unit holds, as it tells every session on the workflow. */
export type WorkflowStateInfo = Readonly<{
  state: ExecutionState;
  /** The execution the run is of; left out when the state is of no run. */
  executionId?: number;
}>;

export type TexeraWebsocketRequestTypeMap = {
  HeartBeatRequest: {};
  OperatorUpdateRequest: OperatorUpdateRequest;
  ResultPaginationRequest: PaginationRequest;
  RetryRequest: { workers: ReadonlyArray<string> };
  SkipTupleRequest: { workers: ReadonlyArray<string> };
  WorkflowStartRequest: WorkflowStartRequest;
  WorkflowKillRequest: {};
  WorkflowPauseRequest: {};
  WorkflowCheckpointRequest: {};
  WorkflowResumeRequest: {};
  PythonExpressionEvaluateRequest: PythonExpressionEvaluateRequest;
  DebugCommandRequest: DebugCommandRequest;
};

export type TexeraWebsocketEventTypeMap = {
  HeartBeatResponse: {};
  RequestRefusedEvent: RequestRefusedEvent;
  WorkflowStateEvent: WorkflowStateInfo;
  OperatorStatisticsUpdateEvent: OperatorStatsUpdate;
  WebResultUpdateEvent: WorkflowResultUpdateEvent;
  RecoveryStartedEvent: {};
  WorkflowErrorEvent: WorkflowErrorEvent;
  ConsoleUpdateEvent: ConsoleUpdateEvent;
  OperatorCurrentTuplesUpdateEvent: OperatorCurrentTuples;
  PaginatedResultEvent: PaginatedResultEvent;
  PythonExpressionEvaluateResponse: PythonExpressionEvaluateResponse;
  WorkerAssignmentUpdateEvent: WorkerAssignmentUpdateEvent;
  ModifyLogicResponse: ModifyLogicResponse;
  ModifyLogicCompletedEvent: ModifyLogicCompletedEvent;
  ExecutionDurationUpdateEvent: ExecutionDurationUpdateEvent;
  ClusterStatusUpdateEvent: ClusterStatusUpdateEvent;
  RegionUpdateEvent: RegionUpdateEvent;
  RegionStateEvent: RegionStateEvent;
};

// helper type definitions to generate the request and event types
type ValueOf<T> = T[keyof T];
type CustomUnionType<T> = ValueOf<{
  [P in keyof T]: {
    type: P;
  } & T[P];
}>;

export type TexeraWebsocketRequestTypes = keyof TexeraWebsocketRequestTypeMap;
export type TexeraWebsocketRequest = CustomUnionType<TexeraWebsocketRequestTypeMap>;

export type TexeraWebsocketEventTypes = keyof TexeraWebsocketEventTypeMap;
export type TexeraWebsocketEvent = CustomUnionType<TexeraWebsocketEventTypeMap>;
