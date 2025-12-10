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
 * Execution tools for Texera Agent Service.
 * These tools provide workflow execution capabilities via WebSocket.
 */

import { z } from "zod";
import { tool } from "ai";
import {
  createSuccessResult,
  createErrorResult,
  filterByTokenLimit,
  DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT,
  DEFAULT_EXECUTION_TIMEOUT_MS,
} from "./tools-utility";
import type { WorkflowState } from "../workflow/workflow-state";
import { ExecutionClient, type LogicalPlan, type LogicalLink, type ExecutionResult } from "../api/execution-api";
import {
  ExecutionState,
  type ExecutionStateInfo,
  type OperatorStatistics,
  type ConsoleMessage,
  type OperatorResultInfo,
  isNotInExecution,
} from "../types/execution";

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_EXECUTE_WORKFLOW = "executeWorkflow";
export const TOOL_NAME_GET_EXECUTION_STATE = "getExecutionState";
export const TOOL_NAME_KILL_WORKFLOW = "killWorkflow";
export const TOOL_NAME_GET_EXECUTION_RESULT = "getExecutionResult";
export const TOOL_NAME_GET_OPERATOR_RESULT = "getOperatorResult";

// ============================================================================
// Execution Manager
// ============================================================================

/**
 * Manages workflow execution for an agent.
 * Wraps ExecutionClient with state tracking and lifecycle management.
 */
export class ExecutionManager {
  private client: ExecutionClient | null = null;
  private lastResult: ExecutionResult | null = null;
  private isExecuting = false;

  constructor(
    private config: {
      userToken: string;
      workflowId: number;
      userId: number;
      computingUnitId?: number;
    }
  ) {}

  /**
   * Get or create the execution client.
   */
  private getClient(): ExecutionClient {
    if (!this.client) {
      this.client = new ExecutionClient(this.config);
    }
    return this.client;
  }

  /**
   * Check if currently executing.
   */
  isRunning(): boolean {
    return this.isExecuting;
  }

  /**
   * Get the current execution state.
   */
  getState(): ExecutionStateInfo {
    if (!this.client) {
      return { state: ExecutionState.Uninitialized };
    }
    return this.client.getExecutionState();
  }

  /**
   * Get the last execution result.
   */
  getLastResult(): ExecutionResult | null {
    return this.lastResult;
  }

  /**
   * Execute the workflow with the given logical plan.
   */
  async execute(logicalPlan: LogicalPlan, executionName?: string, timeoutMs?: number): Promise<ExecutionResult> {
    if (this.isExecuting) {
      throw new Error("A workflow execution is already in progress");
    }

    const client = this.getClient();
    this.isExecuting = true;

    try {
      // Create a timeout promise
      const timeout = timeoutMs || DEFAULT_EXECUTION_TIMEOUT_MS;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Execution timeout after ${timeout / 1000} seconds`)), timeout);
      });

      // Race execution against timeout
      this.lastResult = await Promise.race([client.executeWorkflow(logicalPlan, executionName), timeoutPromise]);

      return this.lastResult;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Kill the current workflow execution.
   */
  async kill(): Promise<void> {
    if (!this.client) {
      throw new Error("No execution client initialized");
    }
    await this.client.killWorkflow();
    this.isExecuting = false;
  }

  /**
   * Request paginated results for an operator.
   */
  async getPaginatedResult(operatorId: string, pageIndex: number, pageSize: number = 10) {
    if (!this.client) {
      throw new Error("No execution client initialized");
    }
    return this.client.requestPaginatedResult(operatorId, pageIndex, pageSize);
  }

  /**
   * Get operator results from the last execution.
   */
  getOperatorResults(): Record<string, OperatorResultInfo> {
    if (!this.client) {
      return {};
    }
    return this.client.getOperatorResults();
  }

  /**
   * Get operator statistics from the last execution.
   */
  getOperatorStats(): Record<string, OperatorStatistics> {
    if (!this.client) {
      return {};
    }
    return this.client.getOperatorStats();
  }

  /**
   * Get console logs from the last execution.
   */
  getConsoleLogs(): Record<string, ConsoleMessage[]> {
    if (!this.client) {
      return {};
    }
    return this.client.getConsoleLogs();
  }

  /**
   * Disconnect and cleanup.
   */
  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.isExecuting = false;
  }
}

// ============================================================================
// Logical Plan Builder
// ============================================================================

/**
 * Converts WorkflowState to LogicalPlan for execution.
 */
export function buildLogicalPlan(workflowState: WorkflowState, opsToViewResult?: string[]): LogicalPlan {
  const operators = workflowState.getAllEnabledOperators().map((op) => ({
    operatorID: op.operatorID,
    operatorType: op.operatorType,
    ...op.operatorProperties,
  }));

  const links: LogicalLink[] = workflowState.getAllLinks().map((link) => ({
    fromOpId: link.source.operatorID,
    fromPortId: {
      id: parseInt(link.source.portID.replace(/\D/g, "") || "0", 10),
      internal: false,
    },
    toOpId: link.target.operatorID,
    toPortId: {
      id: parseInt(link.target.portID.replace(/\D/g, "") || "0", 10),
      internal: false,
    },
  }));

  // If no specific operators requested, find sink operators (no outgoing links)
  const allOpsToView =
    opsToViewResult && opsToViewResult.length > 0
      ? opsToViewResult
      : operators
          .filter((op) => !links.some((link) => link.fromOpId === op.operatorID))
          .map((op) => op.operatorID);

  return {
    operators,
    links,
    opsToViewResult: allOpsToView,
  };
}

// ============================================================================
// Tool Creators
// ============================================================================

/**
 * Create tool to execute the current workflow.
 */
export function createExecuteWorkflowTool(workflowState: WorkflowState, executionManager: ExecutionManager) {
  return tool({
    description:
      "Execute the current workflow and retrieve results. " +
      "This will run all operators in the workflow and collect output from sink operators. " +
      "Optionally specify which operator IDs to view results for.",
    inputSchema: z.object({
      operatorIdsToView: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of operator IDs to view results for. If not specified, results from all sink operators will be collected."
        ),
      executionName: z.string().optional().describe("Optional name for this execution run."),
      timeoutSeconds: z
        .number()
        .optional()
        .describe("Optional timeout in seconds (default: 600 = 10 minutes)."),
    }),
    execute: async (args: { operatorIdsToView?: string[]; executionName?: string; timeoutSeconds?: number }) => {
      try {
        // Check if already executing
        if (executionManager.isRunning()) {
          return createErrorResult("A workflow execution is already in progress. Use killWorkflow to stop it first.");
        }

        // Build logical plan from current workflow state
        const logicalPlan = buildLogicalPlan(workflowState, args.operatorIdsToView);

        if (logicalPlan.operators.length === 0) {
          return createErrorResult("Cannot execute: workflow has no operators.");
        }

        // Execute with timeout
        const timeoutMs = args.timeoutSeconds ? args.timeoutSeconds * 1000 : DEFAULT_EXECUTION_TIMEOUT_MS;
        const result = await executionManager.execute(logicalPlan, args.executionName, timeoutMs);

        // Format operator states for readability
        const formattedStats = formatOperatorStats(result.operatorStats);

        // Collect results with token limiting
        const collectedResults: Record<
          string,
          {
            mode: string;
            totalRows?: number;
            displayedRows?: number;
            truncated?: boolean;
            data?: any[];
          }
        > = {};

        for (const [opId, opResult] of Object.entries(result.operatorResults)) {
          if (opResult.mode === "table") {
            const { limited, truncated } = filterByTokenLimit(
              opResult.result || [],
              DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT
            );
            collectedResults[opId] = {
              mode: "table",
              totalRows: opResult.totalRows,
              displayedRows: limited.length,
              truncated,
              data: limited,
            };
          } else {
            collectedResults[opId] = {
              mode: "visualization",
            };
          }
        }

        // Determine execution status message
        const stateStr = result.state.state;
        let statusMessage: string;
        if (stateStr === ExecutionState.Completed) {
          statusMessage = "Workflow execution completed successfully.";
        } else if (stateStr === ExecutionState.Failed) {
          const errorMsgs =
            "errorMessages" in result.state
              ? result.state.errorMessages.map((e) => e.message).join("; ")
              : "Unknown error";
          statusMessage = `Workflow execution failed: ${errorMsgs}`;
        } else if (stateStr === ExecutionState.Killed) {
          statusMessage = "Workflow execution was killed.";
        } else {
          statusMessage = `Workflow execution ended with state: ${stateStr}`;
        }

        return createSuccessResult(
          {
            executionState: stateStr,
            operatorStats: formattedStats,
            results: collectedResults,
            consoleLogs: result.consoleLogs,
            errors: result.errors,
            durationMs: result.durationMs,
            message: statusMessage,
          },
          Object.keys(result.operatorStats),
          [],
          []
        );
      } catch (error: any) {
        return createErrorResult(`Execution failed: ${error.message || String(error)}`);
      }
    },
  });
}

/**
 * Create tool to get the current execution state.
 */
export function createGetExecutionStateTool(executionManager: ExecutionManager) {
  return tool({
    description:
      "Get the current execution state of the workflow. " +
      "Returns the execution state and operator statistics.",
    inputSchema: z.object({}),
    execute: async () => {
      const state = executionManager.getState();
      const stats = executionManager.getOperatorStats();
      const formattedStats = formatOperatorStats(stats);

      return createSuccessResult(
        {
          executionState: state.state,
          isRunning: !isNotInExecution(state.state),
          operatorStats: formattedStats,
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
 * Create tool to kill the current workflow execution.
 */
export function createKillWorkflowTool(executionManager: ExecutionManager) {
  return tool({
    description: "Kill (stop) the currently running workflow execution.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        if (!executionManager.isRunning()) {
          return createErrorResult("No workflow execution is currently running.");
        }

        await executionManager.kill();

        return createSuccessResult(
          {
            message: "Workflow execution has been killed.",
          },
          [],
          [],
          []
        );
      } catch (error: any) {
        return createErrorResult(`Failed to kill workflow: ${error.message || String(error)}`);
      }
    },
  });
}

/**
 * Create tool to get execution results from the last run.
 */
export function createGetExecutionResultTool(
  executionManager: ExecutionManager,
  workflowState: WorkflowState,
  maxTokenLimit: number = DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT
) {
  return tool({
    description:
      "Get results and console logs from the last workflow execution. " +
      "If targetOperatorIds is not provided, retrieves results for all operators.",
    inputSchema: z.object({
      targetOperatorIds: z
        .array(z.string())
        .optional()
        .describe("Optional list of operator IDs to retrieve results for."),
    }),
    execute: async (args: { targetOperatorIds?: string[] }) => {
      const lastResult = executionManager.getLastResult();

      if (!lastResult) {
        return createErrorResult("No execution results available. Execute the workflow first.");
      }

      const allOperators = workflowState.getAllOperators();
      const allOperatorIds = allOperators.map((op) => op.operatorID);
      const targetIds =
        args.targetOperatorIds && args.targetOperatorIds.length > 0 ? args.targetOperatorIds : allOperatorIds;

      // Collect results
      const operatorResults: Record<string, any> = {};
      for (const opId of targetIds) {
        const result = lastResult.operatorResults[opId];
        if (result) {
          if (result.mode === "table") {
            const { limited, truncated } = filterByTokenLimit(result.result || [], maxTokenLimit);
            operatorResults[opId] = {
              mode: "table",
              totalRows: result.totalRows,
              displayedRows: limited.length,
              truncated,
              data: limited,
            };
          } else {
            operatorResults[opId] = result;
          }
        }
      }

      // Collect console logs
      const consoleLogs: Record<string, ConsoleMessage[]> = {};
      for (const opId of targetIds) {
        const logs = lastResult.consoleLogs[opId];
        if (logs && logs.length > 0) {
          consoleLogs[opId] = logs;
        }
      }

      return createSuccessResult(
        {
          executionState: lastResult.state.state,
          targetOperatorIds: targetIds,
          operatorResults,
          consoleLogs,
          summary: {
            totalOperatorsChecked: targetIds.length,
            operatorsWithResults: Object.keys(operatorResults).length,
            operatorsWithConsoleLogs: Object.keys(consoleLogs).length,
          },
          message: `Retrieved results for ${Object.keys(operatorResults).length}/${targetIds.length} operators.`,
        },
        targetIds,
        [],
        []
      );
    },
  });
}

/**
 * Create tool to get paginated results for a specific operator.
 */
export function createGetOperatorResultTool(
  executionManager: ExecutionManager,
  maxTokenLimit: number = DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT
) {
  return tool({
    description:
      "Get paginated results for a specific operator from the last execution. " +
      "Useful for operators with large result sets.",
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to get results for."),
      pageIndex: z.number().optional().describe("Page index (0-based, default: 0)."),
      pageSize: z.number().optional().describe("Number of rows per page (default: 10, max: 100)."),
    }),
    execute: async (args: { operatorId: string; pageIndex?: number; pageSize?: number }) => {
      try {
        const pageIndex = args.pageIndex || 0;
        const pageSize = Math.min(args.pageSize || 10, 100);

        const paginatedResult = await executionManager.getPaginatedResult(args.operatorId, pageIndex, pageSize);

        // Apply token limit
        const { limited, truncated } = filterByTokenLimit(paginatedResult.table || [], maxTokenLimit);

        return createSuccessResult(
          {
            operatorId: args.operatorId,
            pageIndex: paginatedResult.pageIndex,
            schema: paginatedResult.schema,
            data: limited,
            displayedRows: limited.length,
            truncated,
            message: `Retrieved page ${pageIndex} of results for operator ${args.operatorId}.`,
          },
          [args.operatorId],
          [],
          []
        );
      } catch (error: any) {
        return createErrorResult(`Failed to get operator result: ${error.message || String(error)}`);
      }
    },
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

interface FormattedOperatorStats {
  state: string;
  inputRows: string;
  outputRows: string;
  inputPortMetrics: Record<string, string>;
  outputPortMetrics: Record<string, string>;
}

/**
 * Format operator statistics with units for readability.
 */
function formatOperatorStats(stats: Record<string, OperatorStatistics>): Record<string, FormattedOperatorStats> {
  const formatted: Record<string, FormattedOperatorStats> = {};

  for (const [operatorId, opStats] of Object.entries(stats)) {
    formatted[operatorId] = {
      state: String(opStats.operatorState),
      inputRows: `${opStats.aggregatedInputRowCount} rows`,
      outputRows: `${opStats.aggregatedOutputRowCount} rows`,
      inputPortMetrics: Object.fromEntries(
        Object.entries(opStats.inputPortMetrics).map(([port, count]) => [port, `${count} rows`])
      ),
      outputPortMetrics: Object.fromEntries(
        Object.entries(opStats.outputPortMetrics).map(([port, count]) => [port, `${count} rows`])
      ),
    };
  }

  return formatted;
}

// ============================================================================
// Re-export ExecutionStateStore for backward compatibility
// ============================================================================

/**
 * Legacy execution state store for standalone use (mock mode).
 * @deprecated Use ExecutionManager with ExecutionClient for real execution.
 */
export { ExecutionClient } from "../api/execution-api";
