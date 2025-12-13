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
import { createSuccessResult, createErrorResult } from "./tools-utility";
import type { WorkflowState } from "../workflow/workflow-state";
import { getBackendConfig } from "../api/backend-api";
import type { LogicalPlan, LogicalLink } from "../api/execution-api";
import type { SyncExecutionResult, OperatorInfo, ConsoleMessage } from "../types/execution";

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_EXECUTE_WORKFLOW = "executeWorkflow";

// ============================================================================
// Execution Configuration
// ============================================================================

export interface ExecutionConfig {
  /** User JWT token for authentication */
  userToken: string;
  /** Workflow ID */
  workflowId: number;
  /** Optional computing unit ID (defaults to 0) */
  computingUnitId?: number;
}

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_RESULT_ROWS = 200;

// ============================================================================
// Logical Plan Builder
// ============================================================================

/**
 * Converts WorkflowState to LogicalPlan for execution.
 */
export function buildLogicalPlan(workflowState: WorkflowState, opsToViewResult?: string[]): LogicalPlan {
  const operators = workflowState.getAllEnabledOperators().map(op => ({
    operatorID: op.operatorID,
    operatorType: op.operatorType,
    ...op.operatorProperties,
  }));

  const links: LogicalLink[] = workflowState.getAllLinks().map(link => ({
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
      : operators.filter(op => !links.some(link => link.fromOpId === op.operatorID)).map(op => op.operatorID);

  return {
    operators,
    links,
    opsToViewResult: allOpsToView,
  };
}

// ============================================================================
// HTTP Execution Function
// ============================================================================

/**
 * Execute a workflow via HTTP REST API.
 * This is a stateless call that blocks until execution completes.
 */
async function executeWorkflowHttp(
  config: ExecutionConfig,
  logicalPlan: LogicalPlan,
  options: {
    executionName?: string;
    timeoutSeconds?: number;
    maxResultRows?: number;
  } = {}
): Promise<SyncExecutionResult> {
  const backendConfig = getBackendConfig();
  const executionEndpoint = backendConfig.executionEndpoint || "http://localhost:8085";

  const workflowId = config.workflowId;
  const computingUnitId = config.computingUnitId ?? 0;

  const url = `${executionEndpoint}/api/execution/${workflowId}/${computingUnitId}/run`;

  // Build request matching backend SyncExecutionRequest
  const request = {
    executionName: options.executionName || `agent-execution-${Date.now()}`,
    logicalPlan: {
      operators: logicalPlan.operators,
      links: logicalPlan.links,
      opsToViewResult: logicalPlan.opsToViewResult || [],
      opsToReuseResult: [],
    },
    targetOperatorIds: logicalPlan.opsToViewResult || [],
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    maxResultRows: options.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS,
  };

  console.log(`[ExecutionTools] Executing workflow via HTTP: ${url}`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.userToken}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Execution request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result: SyncExecutionResult = await response.json();
    return result;
  } catch (error) {
    console.error("[ExecutionTools] Execution failed:", error);
    return {
      success: false,
      state: "Error",
      operators: {},
      errors: [error instanceof Error ? error.message : "Unknown error"],
    };
  }
}

// ============================================================================
// Tool Creator
// ============================================================================

/**
 * Create tool to execute the current workflow.
 */
export function createExecuteWorkflowTool(workflowState: WorkflowState, executionConfig: ExecutionConfig) {
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
        .describe(`Optional timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS}).`),
      maxResultRows: z
        .number()
        .optional()
        .describe(`Optional maximum result rows to return per operator (default: ${DEFAULT_MAX_RESULT_ROWS}).`),
    }),
    execute: async (args: {
      operatorIdsToView?: string[];
      executionName?: string;
      timeoutSeconds?: number;
      maxResultRows?: number;
    }) => {
      try {
        // Build logical plan from current workflow state
        const logicalPlan = buildLogicalPlan(workflowState, args.operatorIdsToView);

        if (logicalPlan.operators.length === 0) {
          return createErrorResult("Cannot execute: workflow has no operators.");
        }

        // Execute via HTTP
        const result = await executeWorkflowHttp(executionConfig, logicalPlan, {
          executionName: args.executionName,
          timeoutSeconds: args.timeoutSeconds,
          maxResultRows: args.maxResultRows,
        });

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
        } else if (result.state === "CompilationFailed") {
          const compilationMsgs = result.compilationErrors
            ? Object.entries(result.compilationErrors)
                .map(([k, v]) => `${k}: ${v}`)
                .join("; ")
            : "Unknown compilation error";
          statusMessage = `Workflow compilation failed: ${compilationMsgs}`;
        } else if (result.state === "Timeout") {
          statusMessage = `Workflow execution timed out after ${args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS} seconds.`;
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

// ============================================================================
// Helper Functions
// ============================================================================

interface FormattedOperatorInfo {
  state: string;
  inputTuples: string;
  outputTuples: string;
  resultMode: string;
  resultSummary: string;
  result?: Record<string, any>[];
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
      result: opInfo.result,
      consoleLogs: opInfo.consoleLogs,
      error: opInfo.error,
    };
  }

  return formatted;
}
