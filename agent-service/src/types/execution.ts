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
 * Execution and compilation state types for Texera Agent Service.
 */

// ============================================================================
// Execution State
// ============================================================================

/**
 * Workflow execution states
 */
export enum ExecutionState {
  Uninitialized = "Uninitialized",
  Initializing = "Initializing",
  Running = "Running",
  Pausing = "Pausing",
  Paused = "Paused",
  Resuming = "Resuming",
  Recovering = "Recovering",
  Completed = "Completed",
  Terminated = "Terminated",
  Failed = "Failed",
  Killed = "Killed",
}

/**
 * Operator execution states
 */
export enum OperatorState {
  Uninitialized = "Uninitialized",
  Initializing = "Initializing",
  Ready = "Ready",
  Running = "Running",
  Pausing = "Pausing",
  Paused = "Paused",
  Resuming = "Resuming",
  Completed = "Completed",
  Recovering = "Recovering",
}

/**
 * Fatal error from workflow execution
 */
export interface WorkflowFatalError {
  readonly message: string;
  readonly operatorId?: string;
  readonly details?: string;
}

/**
 * Statistics for a single operator during execution
 */
export interface OperatorStatistics {
  readonly operatorState: OperatorState;
  readonly aggregatedInputRowCount: number;
  readonly inputPortMetrics: Record<string, number>;
  readonly aggregatedOutputRowCount: number;
  readonly outputPortMetrics: Record<string, number>;
  readonly numWorkers?: number;
}

/**
 * Execution state info with error details
 */
export type ExecutionStateInfo =
  | {
      readonly state:
        | ExecutionState.Uninitialized
        | ExecutionState.Initializing
        | ExecutionState.Pausing
        | ExecutionState.Running
        | ExecutionState.Resuming
        | ExecutionState.Recovering
        | ExecutionState.Completed
        | ExecutionState.Killed
        | ExecutionState.Terminated;
    }
  | {
      readonly state: ExecutionState.Paused;
      readonly currentTuples: Record<string, any>;
    }
  | {
      readonly state: ExecutionState.Failed;
      readonly errorMessages: readonly WorkflowFatalError[];
    };

// ============================================================================
// Compilation State
// ============================================================================

/**
 * Workflow compilation states
 */
export enum CompilationState {
  Uninitialized = "Uninitialized",
  Succeeded = "Succeeded",
  Failed = "Failed",
}

/**
 * Compilation state info with schema maps and errors
 */
export type CompilationStateInfo =
  | {
      readonly state: CompilationState.Uninitialized;
    }
  | {
      readonly state: CompilationState.Succeeded;
      readonly physicalPlan?: any;
      readonly operatorOutputPortSchemaMap?: Record<string, Record<string, any>>;
    }
  | {
      readonly state: CompilationState.Failed;
      readonly operatorOutputPortSchemaMap?: Record<string, Record<string, any>>;
      readonly operatorErrors: Record<string, WorkflowFatalError>;
    };

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result output modes
 */
export type WebOutputMode =
  | { type: "PaginationMode" }
  | { type: "SetSnapshotMode" }
  | { type: "SetDeltaMode" };

/**
 * Paginated result metadata
 */
export interface PaginatedOperatorResultInfo {
  mode: "table";
  totalRows: number;
  displayedRows: number;
  estimatedTokens: number;
  truncated: boolean;
  tableStats?: Record<string, Record<string, number>>;
  result: Record<string, any>[];
}

/**
 * Visualization result (Plotly JSON)
 */
export interface VisualizationOperatorResultInfo {
  mode: "visualization";
  chartData?: {
    data: any[];
    layout?: {
      title?: any;
      xaxis?: { title?: any };
      yaxis?: { title?: any };
      zaxis?: { title?: any };
      legend?: any;
      annotations?: any[];
    };
  };
  parseError?: string;
}

/**
 * Union of all operator result types
 */
export type OperatorResultInfo = PaginatedOperatorResultInfo | VisualizationOperatorResultInfo;

// ============================================================================
// Console Messages
// ============================================================================

/**
 * Console message from operator execution
 */
export interface ConsoleMessage {
  readonly workerId: string;
  readonly timestamp: {
    nanos: number;
    seconds: number;
  };
  readonly msgType: {
    name: string;
  };
  readonly source: string;
  readonly title: string;
  readonly message: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if execution state indicates workflow is not running
 */
export function isNotInExecution(state: ExecutionState): boolean {
  return [
    ExecutionState.Uninitialized,
    ExecutionState.Failed,
    ExecutionState.Killed,
    ExecutionState.Completed,
  ].includes(state);
}
