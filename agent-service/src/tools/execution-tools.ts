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
 * These tools provide workflow execution capabilities via HTTP REST API.
 */

import { z } from "zod";
import { tool } from "ai";
import {
  createSuccessResult,
  createErrorResult,
  DEFAULT_EXECUTION_TIMEOUT_MS,
} from "./tools-utility";
import type { WorkflowState } from "../workflow/workflow-state";
import { ExecutionClient, type LogicalPlan, type LogicalLink } from "../api/execution-api";
import type { SyncExecutionResult, OperatorInfo, ConsoleMessage } from "../types/execution";

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_EXECUTE_WORKFLOW = "executeWorkflow";
export const TOOL_NAME_GET_EXECUTION_STATE = "getExecutionState";
export const TOOL_NAME_GET_EXECUTION_RESULT = "getExecutionResult";

// ============================================================================
// Execution Manager
// ============================================================================

/**
 * Manages workflow execution for an agent.
 * Wraps ExecutionClient with state tracking and lifecycle management.
 */
export class ExecutionManager {
  private client: ExecutionClient;
  private lastResult: SyncExecutionResult | null = null;
  private isExecuting = false;

  constructor(
    private config: {
      userToken: string;
      workflowId: number;
      computingUnitId?: number;
      timeoutSeconds?: number;
      maxResultRows?: number;
    }
  ) {
    this.client = new ExecutionClient({
      ...config,
      computingUnitId: config.computingUnitId ?? 0,
      timeoutSeconds: config.timeoutSeconds ?? 300,
      maxResultRows: config.maxResultRows ?? 200,
    });
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
  getState(): string {
    return this.lastResult?.state || "Uninitialized";
  }

  /**
   * Get the last execution result.
   */
  getLastResult(): SyncExecutionResult | null {
    return this.lastResult;
  }

  /**
   * Execute the workflow with the given logical plan.
   */
  async execute(logicalPlan: LogicalPlan, executionName?: string, timeoutMs?: number): Promise<SyncExecutionResult> {
    if (this.isExecuting) {
      throw new Error("A workflow execution is already in progress");
    }

    this.isExecuting = true;

    try {
      // Create a timeout promise (additional client-side timeout)
      const timeout = timeoutMs || DEFAULT_EXECUTION_TIMEOUT_MS;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Execution timeout after ${timeout / 1000} seconds`)), timeout);
      });

      // Race execution against timeout
      this.lastResult = await Promise.race([this.client.executeWorkflow(logicalPlan, executionName), timeoutPromise]);

      return this.lastResult;
    } catch (error) {
      this.lastResult = {
        success: false,
        state: "Failed",
        operators: {},
        errors: [error instanceof Error ? error.message : String(error)],
      };
      throw error;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Get operator results from the last execution.
   */
  getOperatorResults(): Record<string, OperatorInfo> {
    return this.lastResult?.operators || {};
  }

  /**
   * Reset state.
   */
  reset(): void {
    this.lastResult = null;
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
        .describe("Optional timeout in seconds (default: 300 = 5 minutes)."),
    }),
    execute: async (args: { operatorIdsToView?: string[]; executionName?: string; timeoutSeconds?: number }) => {
      try {
        // Check if already executing
        if (executionManager.isRunning()) {
          return createErrorResult("A workflow execution is already in progress.");
        }

        // Build logical plan from current workflow state
        const logicalPlan = buildLogicalPlan(workflowState, args.operatorIdsToView);

        if (logicalPlan.operators.length === 0) {
          return createErrorResult("Cannot execute: workflow has no operators.");
        }

        // Execute with timeout
        const timeoutMs = args.timeoutSeconds ? args.timeoutSeconds * 1000 : DEFAULT_EXECUTION_TIMEOUT_MS;
        const result = await executionManager.execute(logicalPlan, args.executionName, timeoutMs);

        // Format operator info for readability
        const formattedOperators = formatOperatorInfo(result.operators);

        // Determine execution status message
        let statusMessage: string;
        if (result.success) {
          statusMessage = "Workflow execution completed successfully.";
        } else if (result.state === "Failed") {
          const errorMsgs = result.errors?.join("; ") || "Unknown error";
          statusMessage = `Workflow execution failed: ${errorMsgs}`;
        } else if (result.state === "Killed") {
          statusMessage = "Workflow execution was killed.";
        } else {
          statusMessage = `Workflow execution ended with state: ${result.state}`;
        }

        return createSuccessResult(
          {
            success: result.success,
            executionState: result.state,
            operators: formattedOperators,
            compilationErrors: result.compilationErrors,
            errors: result.errors,
            message: statusMessage,
          },
          Object.keys(result.operators),
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
      "Returns the execution state and operator statistics from the last execution.",
    inputSchema: z.object({}),
    execute: async () => {
      const state = executionManager.getState();
      const lastResult = executionManager.getLastResult();
      const operatorCount = lastResult ? Object.keys(lastResult.operators).length : 0;

      return createSuccessResult(
        {
          executionState: state,
          isRunning: executionManager.isRunning(),
          hasResults: lastResult !== null,
          operatorCount,
          message: `Current execution state: ${state}`,
        },
        [],
        [],
        []
      );
    },
  });
}

/**
 * Create tool to get execution results from the last run.
 */
export function createGetExecutionResultTool(
  executionManager: ExecutionManager,
  workflowState: WorkflowState
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

      // Collect results for target operators
      const operatorResults: Record<string, any> = {};
      for (const opId of targetIds) {
        const opInfo = lastResult.operators[opId];
        if (opInfo) {
          operatorResults[opId] = {
            state: opInfo.state,
            inputTuples: opInfo.inputTuples,
            outputTuples: opInfo.outputTuples,
            resultMode: opInfo.resultMode,
            totalRowCount: opInfo.totalRowCount,
            displayedRows: opInfo.displayedRows,
            truncated: opInfo.truncated,
            result: opInfo.result,
            consoleLogs: opInfo.consoleLogs,
            error: opInfo.error,
          };
        }
      }

      return createSuccessResult(
        {
          executionState: lastResult.state,
          success: lastResult.success,
          targetOperatorIds: targetIds,
          operatorResults,
          summary: {
            totalOperatorsChecked: targetIds.length,
            operatorsWithResults: Object.keys(operatorResults).length,
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

// ============================================================================
// Helper Functions
// ============================================================================

interface FormattedOperatorInfo {
  state: string;
  inputTuples: string;
  outputTuples: string;
  resultMode: string;
  resultSummary: string;
  consoleLogs?: ConsoleMessage[];
  error?: string;
}

/**
 * Format operator info with units for readability.
 */
function formatOperatorInfo(operators: Record<string, OperatorInfo>): Record<string, FormattedOperatorInfo> {
  const formatted: Record<string, FormattedOperatorInfo> = {};

  for (const [operatorId, opInfo] of Object.entries(operators)) {
    let resultSummary = "No result";
    if (opInfo.result) {
      const displayedRows = opInfo.displayedRows ?? opInfo.result.length;
      const totalRows = opInfo.totalRowCount ?? displayedRows;
      const truncatedStr = opInfo.truncated ? " (truncated)" : "";
      resultSummary = `${displayedRows}/${totalRows} rows${truncatedStr}`;
    }

    formatted[operatorId] = {
      state: opInfo.state,
      inputTuples: `${opInfo.inputTuples} rows`,
      outputTuples: `${opInfo.outputTuples} rows`,
      resultMode: opInfo.resultMode,
      resultSummary,
      consoleLogs: opInfo.consoleLogs,
      error: opInfo.error,
    };
  }

  return formatted;
}

// ============================================================================
// Re-export ExecutionClient for external use
// ============================================================================

export { ExecutionClient } from "../api/execution-api";
