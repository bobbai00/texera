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
 * Execution-related tools for Texera Agent Service.
 * These tools provide workflow execution capabilities.
 *
 * Note: Full execution requires WebSocket connection to Texera backend.
 * This module provides the tool definitions and types that mirror
 * the frontend's current-workflow-execution-tools.ts.
 */

import { z } from "zod";
import { tool } from "ai";
import {
  createSuccessResult,
  createErrorResult,
  estimateTokenCount,
  DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT,
} from "./tools-utility";
import type { WorkflowState } from "../workflow/workflow-state";
import {
  ExecutionState,
  type ExecutionStateInfo,
  type OperatorStatistics,
  type ConsoleMessage,
  type OperatorResultInfo,
} from "../types/execution";

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_GET_CURRENT_EXECUTION_STATE = "getCurrentExecutionState";
export const TOOL_NAME_GET_EXISTING_WORKFLOW_EXECUTION_RESULT = "getExistingWorkflowExecutionResult";
export const TOOL_NAME_GET_CURRENT_OPERATOR_RESULT_INFO = "getCurrentOperatorResultInfo";

// ============================================================================
// Execution State Store (Mock for standalone use)
// ============================================================================

/**
 * Mock execution state store for standalone agent use.
 * In production, this would be replaced by WebSocket integration with Texera backend.
 */
export class ExecutionStateStore {
  private executionState: ExecutionStateInfo = { state: ExecutionState.Uninitialized };
  private operatorStatistics: Map<string, OperatorStatistics> = new Map();
  private consoleLogs: Map<string, ConsoleMessage[]> = new Map();
  private operatorResults: Map<string, OperatorResultInfo> = new Map();

  getExecutionState(): ExecutionStateInfo {
    return this.executionState;
  }

  setExecutionState(state: ExecutionStateInfo): void {
    this.executionState = state;
  }

  getOperatorStatistics(): Record<string, OperatorStatistics> {
    const result: Record<string, OperatorStatistics> = {};
    this.operatorStatistics.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  setOperatorStatistics(operatorId: string, stats: OperatorStatistics): void {
    this.operatorStatistics.set(operatorId, stats);
  }

  getConsoleLogs(operatorId: string): ConsoleMessage[] {
    return this.consoleLogs.get(operatorId) || [];
  }

  addConsoleLog(operatorId: string, message: ConsoleMessage): void {
    const logs = this.consoleLogs.get(operatorId) || [];
    logs.push(message);
    this.consoleLogs.set(operatorId, logs);
  }

  getAllConsoleLogs(): Record<string, ConsoleMessage[]> {
    const result: Record<string, ConsoleMessage[]> = {};
    this.consoleLogs.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  getOperatorResult(operatorId: string): OperatorResultInfo | undefined {
    return this.operatorResults.get(operatorId);
  }

  setOperatorResult(operatorId: string, result: OperatorResultInfo): void {
    this.operatorResults.set(operatorId, result);
  }

  hasResult(operatorId: string): boolean {
    return this.operatorResults.has(operatorId);
  }

  reset(): void {
    this.executionState = { state: ExecutionState.Uninitialized };
    this.operatorStatistics.clear();
    this.consoleLogs.clear();
    this.operatorResults.clear();
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format operator states with units for readability
 */
function formatOperatorStates(
  operatorStates: Record<string, OperatorStatistics>
): Record<string, FormattedOperatorState> {
  const formatted: Record<string, FormattedOperatorState> = {};
  for (const [operatorId, stats] of Object.entries(operatorStates)) {
    formatted[operatorId] = {
      state: String(stats.operatorState),
      inputRows: `${stats.aggregatedInputRowCount} rows`,
      outputRows: `${stats.aggregatedOutputRowCount} rows`,
      inputPortMetrics: Object.fromEntries(
        Object.entries(stats.inputPortMetrics).map(([port, count]) => [port, `${count} rows`])
      ),
      outputPortMetrics: Object.fromEntries(
        Object.entries(stats.outputPortMetrics).map(([port, count]) => [port, `${count} rows`])
      ),
    };
  }
  return formatted;
}

interface FormattedOperatorState {
  state: string;
  inputRows: string;
  outputRows: string;
  inputPortMetrics: Record<string, string>;
  outputPortMetrics: Record<string, string>;
}

/**
 * Filter results by token limit
 */
function filterByTokenLimit(
  rows: readonly Record<string, any>[],
  maxTokenLimit: number = DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT
): {
  limited: Record<string, any>[];
  tokenCount: number;
  truncated: boolean;
} {
  const limited: Record<string, any>[] = [];
  let tokenCount = 0;
  for (const row of rows) {
    const rowTokens = estimateTokenCount(row);
    if (tokenCount + rowTokens > maxTokenLimit) break;
    limited.push(row);
    tokenCount += rowTokens;
  }
  return { limited, tokenCount, truncated: limited.length < rows.length };
}

// ============================================================================
// Tool Creators
// ============================================================================

/**
 * Create tool to get the current execution state.
 */
export function createGetCurrentExecutionStateTool(executionStore: ExecutionStateStore) {
  return tool({
    description:
      "Get the current execution state of the workflow. " +
      "Returns the execution state, operator statistics, and any error messages.",
    inputSchema: z.object({}),
    execute: async () => {
      const state = executionStore.getExecutionState();
      const operatorStates = executionStore.getOperatorStatistics();
      const formattedStates = formatOperatorStates(operatorStates);

      return createSuccessResult(
        {
          executionState: state.state,
          stateInfo: state,
          operatorStates: formattedStates,
          message: `Current execution state: ${state.state}`,
        },
        [],
        [],
        []
      );
    },
  });
}

/**
 * Create tool to get existing workflow execution results.
 */
export function createGetExistingWorkflowExecutionResultTool(
  executionStore: ExecutionStateStore,
  workflowState: WorkflowState,
  maxTokenLimit: number = DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT
) {
  return tool({
    description:
      "Get results and console logs from a previous workflow execution. " +
      "If targetOperatorIds is empty or not provided, retrieves results for all operators in the workflow. " +
      "Returns operator results (limited by token count ~3000 tokens) and console logs for each operator.",
    inputSchema: z.object({
      targetOperatorIds: z
        .array(z.string())
        .optional()
        .describe("Optional list of operator IDs to retrieve results for."),
    }),
    execute: async (args: { targetOperatorIds?: string[] }) => {
      const allOperators = workflowState.getAllOperators();
      const allOperatorIds = allOperators.map((op) => op.operatorID);
      const targetIds =
        args.targetOperatorIds && args.targetOperatorIds.length > 0 ? args.targetOperatorIds : allOperatorIds;

      // Collect console logs
      const consoleLogs: Record<string, ConsoleMessage[]> = {};
      for (const opId of targetIds) {
        const logs = executionStore.getConsoleLogs(opId);
        if (logs.length > 0) {
          consoleLogs[opId] = logs;
        }
      }

      // Collect results
      const operatorResults: Record<string, OperatorResultInfo> = {};
      for (const opId of targetIds) {
        const result = executionStore.getOperatorResult(opId);
        if (result) {
          operatorResults[opId] = result;
        }
      }

      const operatorsWithResults = Object.keys(operatorResults).length;
      const operatorsWithLogs = Object.keys(consoleLogs).length;

      return createSuccessResult(
        {
          targetOperatorIds: targetIds,
          operatorResults,
          consoleLogs,
          summary: {
            totalOperatorsChecked: targetIds.length,
            operatorsWithResults,
            operatorsWithConsoleLogs: operatorsWithLogs,
          },
          message: `Retrieved execution results for ${operatorsWithResults}/${targetIds.length} operators and console logs for ${operatorsWithLogs} operators.`,
        },
        targetIds,
        [],
        []
      );
    },
  });
}

/**
 * Create tool to get operator result information.
 */
export function createGetCurrentOperatorResultInfoTool(executionStore: ExecutionStateStore) {
  return tool({
    description:
      "Get information about an operator's results in the current workflow, " +
      "including total count and table details.",
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to get result info for"),
    }),
    execute: async (args: { operatorId: string }) => {
      const result = executionStore.getOperatorResult(args.operatorId);

      if (!result) {
        return createErrorResult(`No results available for operator ${args.operatorId}`);
      }

      if (result.mode === "table") {
        return createSuccessResult(
          {
            operatorId: args.operatorId,
            mode: "table",
            totalRows: result.totalRows,
            displayedRows: result.displayedRows,
            estimatedTokens: result.estimatedTokens,
            truncated: result.truncated,
            message: `Operator ${args.operatorId} has ${result.totalRows} result tuples`,
          },
          [args.operatorId],
          [],
          []
        );
      } else {
        return createSuccessResult(
          {
            operatorId: args.operatorId,
            mode: "visualization",
            hasChartData: !!result.chartData,
            parseError: result.parseError,
            message: `Operator ${args.operatorId} has visualization output`,
          },
          [args.operatorId],
          [],
          []
        );
      }
    },
  });
}
