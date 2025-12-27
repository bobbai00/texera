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
import { OperatorMetadataStore } from "./metadata-tools";

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
  /** Maximum tokens per cell (truncates individual cell values beyond this limit) */
  maxCellTokens?: number;
  /** Serialization mode for operator results: "json" (default) or "table" */
  serializationMode?: "json" | "table";
  /** Whether to restrict operator result token limits (if false, no truncation applied) */
  restrictOperatorResultToken?: boolean;
  /** Whether to disable print statements in Python UDFs (validation at compile time) */
  disablePrint?: boolean;
}

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_RESULT_ROWS = 200;
const DEFAULT_MAX_CELL_TOKENS = 200;

// ============================================================================
// Workflow Validation
// ============================================================================

export interface WorkflowValidationResult {
  isValid: boolean;
  errors: Record<string, Record<string, string>>; // operatorId -> { field -> message }
}

interface OperatorValidation {
  isValid: boolean;
  messages: Record<string, string>;
}

/**
 * Validate operator's JSON schema (properties).
 */
function validateOperatorSchema(operatorType: string, operatorProperties: Record<string, any>): OperatorValidation {
  const metadataStore = OperatorMetadataStore.getInstance();
  const validation = metadataStore.validateOperatorProperties(operatorType, operatorProperties);
  return validation.isValid ? { isValid: true, messages: {} } : { isValid: false, messages: validation.messages };
}

/**
 * Validate operator connections (input ports are properly connected).
 * Mimics frontend ValidationWorkflowService.validateOperatorConnection()
 */
function validateOperatorConnection(operatorId: string, workflowState: WorkflowState): OperatorValidation {
  const operator = workflowState.getOperator(operatorId);
  if (!operator) {
    return { isValid: false, messages: { error: `Operator ${operatorId} not found` } };
  }

  // Count input links by port
  const numInputLinksByPort = new Map<string, number>();
  const allLinks = workflowState.getAllLinks();

  for (const link of allLinks) {
    if (link.target.operatorID === operatorId) {
      const portID = link.target.portID;
      const num = numInputLinksByPort.get(portID) ?? 0;
      numInputLinksByPort.set(portID, num + 1);
    }
  }

  // Check each input port satisfies its requirements
  let satisfyInput = true;
  let inputPortsViolationMessage = "";

  for (const port of operator.inputPorts) {
    const portNumInputs = numInputLinksByPort.get(port.portID) ?? 0;

    if (port.allowMultiInputs) {
      if (portNumInputs < 1) {
        satisfyInput = false;
        inputPortsViolationMessage += `${port.displayName ?? port.portID} requires at least 1 input, has ${portNumInputs}. `;
      }
    } else {
      if (portNumInputs !== 1) {
        satisfyInput = false;
        inputPortsViolationMessage += `${port.displayName ?? port.portID} requires 1 input, has ${portNumInputs}. `;
      }
    }
  }

  if (satisfyInput) {
    return { isValid: true, messages: {} };
  } else {
    return { isValid: false, messages: { inputs: inputPortsViolationMessage.trim() } };
  }
}

/**
 * Combine multiple validation results.
 */
function combineValidations(...validations: OperatorValidation[]): OperatorValidation {
  let isValid = true;
  let messages: Record<string, string> = {};

  for (const validation of validations) {
    if (!validation.isValid) {
      isValid = false;
      messages = { ...messages, ...validation.messages };
    }
  }

  return { isValid, messages };
}

/**
 * Validate all operators in the workflow against their schemas and connection requirements.
 * Returns validation errors for each operator that fails validation.
 */
export function validateWorkflow(workflowState: WorkflowState): WorkflowValidationResult {
  const errors: Record<string, Record<string, string>> = {};

  for (const operator of workflowState.getAllEnabledOperators()) {
    // Validate JSON schema
    const schemaValidation = validateOperatorSchema(operator.operatorType, operator.operatorProperties);

    // Validate connections
    const connectionValidation = validateOperatorConnection(operator.operatorID, workflowState);

    // Combine validations
    const combined = combineValidations(schemaValidation, connectionValidation);

    if (!combined.isValid) {
      errors[operator.operatorID] = combined.messages;
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Format workflow validation errors into a readable message.
 */
function formatWorkflowValidationErrors(validationResult: WorkflowValidationResult): string {
  if (validationResult.isValid) return "";

  const lines: string[] = ["Workflow validation failed:"];
  for (const [operatorId, fieldErrors] of Object.entries(validationResult.errors)) {
    lines.push(`  Operator ${operatorId}:`);
    for (const [field, message] of Object.entries(fieldErrors)) {
      lines.push(`    - ${field}: ${message}`);
    }
  }
  return lines.join("\n");
}

// ============================================================================
// Logical Plan Builder
// ============================================================================

/**
 * Converts WorkflowState to LogicalPlan for execution.
 *
 * Execute To behavior:
 * - If opsToViewResult has exactly 1 operator ID: execute only the sub-DAG up to that operator
 * - If opsToViewResult is empty or has 2+ IDs: execute the full DAG and collect results from specified operators
 */
export function buildLogicalPlan(workflowState: WorkflowState, opsToViewResult?: string[]): LogicalPlan {
  // Determine if we should use sub-DAG (Execute To single operator)
  const useSubDAG = opsToViewResult && opsToViewResult.length === 1;
  const targetOperatorId = useSubDAG ? opsToViewResult[0] : undefined;

  let operatorsList: { operatorID: string; operatorType: string; [key: string]: any }[];
  let linksList: LogicalLink[];

  // Helper to get port ordinal by looking up in the operator's port list
  const getInputPortOrdinal = (operatorID: string, inputPortID: string): number => {
    const op = workflowState.getOperator(operatorID);
    if (!op) return 0;
    const idx = op.inputPorts.findIndex(port => port.portID === inputPortID);
    return idx >= 0 ? idx : 0;
  };

  const getOutputPortOrdinal = (operatorID: string, outputPortID: string): number => {
    const op = workflowState.getOperator(operatorID);
    if (!op) return 0;
    const idx = op.outputPorts.findIndex(port => port.portID === outputPortID);
    return idx >= 0 ? idx : 0;
  };

  if (targetOperatorId) {
    // Execute To: Get sub-DAG up to the target operator
    const subDAG = workflowState.getSubDAG(targetOperatorId);

    operatorsList = subDAG.operators.map(op => ({
      ...op.operatorProperties,
      operatorID: op.operatorID,
      operatorType: op.operatorType,
      inputPorts: op.inputPorts,
      outputPorts: op.outputPorts,
    }));

    linksList = subDAG.links.map(link => ({
      fromOpId: link.source.operatorID,
      fromPortId: {
        id: getOutputPortOrdinal(link.source.operatorID, link.source.portID),
        internal: false,
      },
      toOpId: link.target.operatorID,
      toPortId: {
        id: getInputPortOrdinal(link.target.operatorID, link.target.portID),
        internal: false,
      },
    }));
  } else {
    // Full DAG execution
    operatorsList = workflowState.getAllEnabledOperators().map(op => ({
      ...op.operatorProperties,
      operatorID: op.operatorID,
      operatorType: op.operatorType,
      inputPorts: op.inputPorts,
      outputPorts: op.outputPorts,
    }));

    linksList = workflowState.getAllLinks().map(link => ({
      fromOpId: link.source.operatorID,
      fromPortId: {
        id: getOutputPortOrdinal(link.source.operatorID, link.source.portID),
        internal: false,
      },
      toOpId: link.target.operatorID,
      toPortId: {
        id: getInputPortOrdinal(link.target.operatorID, link.target.portID),
        internal: false,
      },
    }));
  }

  // Determine which operators to collect results from
  let allOpsToView: string[];
  if (opsToViewResult && opsToViewResult.length > 0) {
    // Use the specified operators (filter to only those in our operator list)
    const operatorIds = new Set(operatorsList.map(op => op.operatorID));
    allOpsToView = opsToViewResult.filter(id => operatorIds.has(id));
  } else {
    // Find sink operators (no outgoing links)
    allOpsToView = operatorsList
      .filter(op => !linksList.some(link => link.fromOpId === op.operatorID))
      .map(op => op.operatorID);
  }

  return {
    operators: operatorsList,
    links: linksList,
    opsToViewResult: allOpsToView,
  };
}

// ============================================================================
// HTTP Execution Function
// ============================================================================

/**
 * Execute a workflow via HTTP REST API.
 * This is a stateless call that blocks until execution completes.
 * Supports abort signal for immediate cancellation.
 */
async function executeWorkflowHttp(
  config: ExecutionConfig,
  logicalPlan: LogicalPlan,
  options: {
    executionName?: string;
    timeoutSeconds?: number;
    maxResultRows?: number;
    maxCellTokens?: number;
    serializationMode?: "json" | "table";
    restrictOperatorResultToken?: boolean;
    disablePrint?: boolean;
    abortSignal?: AbortSignal;
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
    maxCellTokens: options.maxCellTokens ?? DEFAULT_MAX_CELL_TOKENS,
    serializationMode: options.serializationMode ?? "json",
    restrictOperatorResultToken: options.restrictOperatorResultToken ?? false,
    disablePrint: options.disablePrint ?? true,
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
      signal: options.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Execution request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result: SyncExecutionResult = await response.json();
    return result;
  } catch (error) {
    // Re-throw abort errors so they propagate up
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
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
        .describe(
          "List of operator IDs to view results for."
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
    execute: async (
      args: {
        operatorIdsToView?: string[];
        executionName?: string;
        timeoutSeconds?: number;
        maxResultRows?: number;
      },
      options: { abortSignal?: AbortSignal }
    ) => {
      try {
        // Build logical plan from current workflow state
        const logicalPlan = buildLogicalPlan(workflowState, args.operatorIdsToView);

        if (logicalPlan.operators.length === 0) {
          return createErrorResult("Cannot execute: workflow has no operators.");
        }

        // Validate workflow before execution
        const validationResult = validateWorkflow(workflowState);
        if (!validationResult.isValid) {
          const errorMessage = formatWorkflowValidationErrors(validationResult);
          return createErrorResult(errorMessage);
        }

        // Execute via HTTP with abort signal for cancellation support
        const result = await executeWorkflowHttp(executionConfig, logicalPlan, {
          executionName: args.executionName,
          timeoutSeconds: args.timeoutSeconds,
          maxResultRows: args.maxResultRows,
          maxCellTokens: executionConfig.maxCellTokens,
          serializationMode: executionConfig.serializationMode,
          restrictOperatorResultToken: executionConfig.restrictOperatorResultToken,
          disablePrint: executionConfig.disablePrint,
          abortSignal: options.abortSignal,
        });

        // Format operator info for readability
        const formattedOperators = formatOperatorInfo(result.operators);

        // Determine execution status message
        let statusMessage: string;
        if (result.success) {
          statusMessage = "Workflow execution completed successfully.";
        } else if (result.state === "Failed") {
          // Try to get error from result.errors first, then from operator console logs
          let errorMsgs = result.errors?.join("; ");
          if (!errorMsgs) {
            // Extract error from operator console logs
            const operatorErrors = Object.entries(result.operators)
              .filter(([_, op]) => op.error)
              .map(([opId, op]) => `${opId}: ${op.error}`);
            errorMsgs = operatorErrors.length > 0 ? operatorErrors.join("; ") : "Unknown error";
          }
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
        // Re-throw abort errors so they propagate up to the agent
        if (error.name === "AbortError") {
          throw error;
        }
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
  result?: any; // JSON array or Table structure
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
      const displayedRows = opInfo.displayedRows ?? 0;
      const totalRows = opInfo.totalRowCount ?? displayedRows;
      const truncatedStr = opInfo.truncated ? " (only partial data is displayed due to token limit)" : "";
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
