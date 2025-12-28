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
import { createToolResult, createErrorResult } from "./tools-utility";
import type { WorkflowState } from "../workflow/workflow-state";
import { getBackendConfig } from "../api/backend-api";
import type { LogicalPlan, LogicalLink } from "../api/execution-api";
import type { SyncExecutionResult, OperatorInfo } from "../types/execution";
import { OperatorMetadataStore } from "./metadata-tools";
import { OperatorResultSerializationMode } from "../types/agent";

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_EXECUTE_WORKFLOW = "executeWorkflow";

// ============================================================================
// Execution Configuration
// ============================================================================

export interface ExecutionConfig {
  userToken: string;
  workflowId: number;
  computingUnitId?: number;
  /** Serialization mode for operator results: "json" or "table" */
  serializationMode?: OperatorResultSerializationMode;
  /** Whether to restrict operator result token limits */
  restrictOperatorResultToken?: boolean;
  /** Maximum tokens for operator results (total) - only used if restrictOperatorResultToken is true */
  maxOperatorResultTokenLimit?: number;
  /** Maximum tokens per cell - only used if restrictOperatorResultToken is true */
  maxOperatorResultCellTokenLimit?: number;
  /** Execution timeout in milliseconds */
  executionTimeoutMs?: number;
  /** Whether to disable print statements in Python UDFs */
  disablePrint?: boolean;
}

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT = 2000;
const DEFAULT_MAX_CELL_TOKEN_LIMIT = 10000;

// ============================================================================
// Workflow Validation
// ============================================================================

export interface WorkflowValidationResult {
  isValid: boolean;
  errors: Record<string, Record<string, string>>;
}

interface OperatorValidation {
  isValid: boolean;
  messages: Record<string, string>;
}

function validateOperatorSchema(operatorType: string, operatorProperties: Record<string, any>): OperatorValidation {
  const metadataStore = OperatorMetadataStore.getInstance();
  const validation = metadataStore.validateOperatorProperties(operatorType, operatorProperties);
  return validation.isValid ? { isValid: true, messages: {} } : { isValid: false, messages: validation.messages };
}

function validateOperatorConnection(operatorId: string, workflowState: WorkflowState): OperatorValidation {
  const operator = workflowState.getOperator(operatorId);
  if (!operator) {
    return { isValid: false, messages: { error: `Operator ${operatorId} not found` } };
  }

  const numInputLinksByPort = new Map<string, number>();
  const allLinks = workflowState.getAllLinks();

  for (const link of allLinks) {
    if (link.target.operatorID === operatorId) {
      const portID = link.target.portID;
      numInputLinksByPort.set(portID, (numInputLinksByPort.get(portID) ?? 0) + 1);
    }
  }

  let satisfyInput = true;
  let violationMessage = "";

  for (const port of operator.inputPorts) {
    const portNumInputs = numInputLinksByPort.get(port.portID) ?? 0;

    if (port.allowMultiInputs) {
      if (portNumInputs < 1) {
        satisfyInput = false;
        violationMessage += `${port.displayName ?? port.portID} requires at least 1 input, has ${portNumInputs}. `;
      }
    } else {
      if (portNumInputs !== 1) {
        satisfyInput = false;
        violationMessage += `${port.displayName ?? port.portID} requires 1 input, has ${portNumInputs}. `;
      }
    }
  }

  return satisfyInput
    ? { isValid: true, messages: {} }
    : { isValid: false, messages: { inputs: violationMessage.trim() } };
}

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

export function validateWorkflow(workflowState: WorkflowState): WorkflowValidationResult {
  const errors: Record<string, Record<string, string>> = {};

  for (const operator of workflowState.getAllEnabledOperators()) {
    const schemaValidation = validateOperatorSchema(operator.operatorType, operator.operatorProperties);
    const connectionValidation = validateOperatorConnection(operator.operatorID, workflowState);
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

export function buildLogicalPlan(workflowState: WorkflowState, opsToViewResult?: string[]): LogicalPlan {
  const useSubDAG = opsToViewResult && opsToViewResult.length === 1;
  const targetOperatorId = useSubDAG ? opsToViewResult[0] : undefined;

  let operatorsList: { operatorID: string; operatorType: string; [key: string]: any }[];
  let linksList: LogicalLink[];

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
      fromPortId: { id: getOutputPortOrdinal(link.source.operatorID, link.source.portID), internal: false },
      toOpId: link.target.operatorID,
      toPortId: { id: getInputPortOrdinal(link.target.operatorID, link.target.portID), internal: false },
    }));
  } else {
    operatorsList = workflowState.getAllEnabledOperators().map(op => ({
      ...op.operatorProperties,
      operatorID: op.operatorID,
      operatorType: op.operatorType,
      inputPorts: op.inputPorts,
      outputPorts: op.outputPorts,
    }));

    linksList = workflowState.getAllLinks().map(link => ({
      fromOpId: link.source.operatorID,
      fromPortId: { id: getOutputPortOrdinal(link.source.operatorID, link.source.portID), internal: false },
      toOpId: link.target.operatorID,
      toPortId: { id: getInputPortOrdinal(link.target.operatorID, link.target.portID), internal: false },
    }));
  }

  let allOpsToView: string[];
  if (opsToViewResult && opsToViewResult.length > 0) {
    const operatorIds = new Set(operatorsList.map(op => op.operatorID));
    allOpsToView = opsToViewResult.filter(id => operatorIds.has(id));
  } else {
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

async function executeWorkflowHttp(
  config: ExecutionConfig,
  logicalPlan: LogicalPlan,
  options: { abortSignal?: AbortSignal } = {}
): Promise<SyncExecutionResult> {
  const backendConfig = getBackendConfig();
  const executionEndpoint = backendConfig.executionEndpoint || "http://localhost:8085";

  const workflowId = config.workflowId;
  const computingUnitId = config.computingUnitId ?? 0;

  const url = `${executionEndpoint}/api/execution/${workflowId}/${computingUnitId}/run`;

  const timeoutSeconds = config.executionTimeoutMs
    ? Math.ceil(config.executionTimeoutMs / 1000)
    : DEFAULT_TIMEOUT_SECONDS;

  // Always request JSON format from backend - we'll convert in agent-service if needed
  const request = {
    executionName: "agent-execution",
    logicalPlan: {
      operators: logicalPlan.operators,
      links: logicalPlan.links,
      opsToViewResult: logicalPlan.opsToViewResult || [],
      opsToReuseResult: [],
    },
    targetOperatorIds: logicalPlan.opsToViewResult || [],
    timeoutSeconds,
    serializationMode: "json", // Always request JSON from backend
    restrictOperatorResultToken: config.restrictOperatorResultToken ?? false,
    maxOperatorResultTokenLimit: config.maxOperatorResultTokenLimit ?? DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT,
    maxCellTokens: config.maxOperatorResultCellTokenLimit ?? DEFAULT_MAX_CELL_TOKEN_LIMIT,
    disablePrint: config.disablePrint ?? true,
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

    return await response.json();
  } catch (error) {
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
// Result Formatting (agent-service side)
// ============================================================================

interface FormattedOperatorResult {
  state: string;
  rows: string; // e.g., "10/100 rows (truncated)"
  result?: any;
  error?: string;
}

/**
 * Convert JSON result to table format (CSV-like string).
 * This is done in agent-service rather than backend.
 */
function jsonToTableFormat(jsonResult: Record<string, any>[]): string {
  if (!jsonResult || jsonResult.length === 0) return "";

  const headers = Object.keys(jsonResult[0]);
  const headerLine = headers.join(",");

  const rows = jsonResult.map(row =>
    headers
      .map(h => {
        const val = row[h];
        if (val === null || val === undefined) return "";
        const str = typeof val === "string" ? val : JSON.stringify(val);
        // Escape CSV: wrap in quotes if contains comma, quote, or newline
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(",")
  );

  return [headerLine, ...rows].join("\n");
}

/**
 * Format operator results for agent consumption.
 * Simplifies the response and applies serialization mode.
 */
function formatOperatorResults(
  operators: Record<string, OperatorInfo>,
  serializationMode: OperatorResultSerializationMode
): Record<string, FormattedOperatorResult> {
  const formatted: Record<string, FormattedOperatorResult> = {};

  for (const [operatorId, opInfo] of Object.entries(operators)) {
    const displayedRows = opInfo.displayedRows ?? 0;
    const totalRows = opInfo.totalRowCount ?? displayedRows;
    const truncatedStr = opInfo.truncated ? " (truncated)" : "";
    const rowsSummary = `${displayedRows}/${totalRows} rows${truncatedStr}`;

    let result: any = undefined;
    if (opInfo.result) {
      if (serializationMode === OperatorResultSerializationMode.TABLE && Array.isArray(opInfo.result)) {
        result = jsonToTableFormat(opInfo.result as Record<string, any>[]);
      } else {
        result = opInfo.result;
      }
    }

    formatted[operatorId] = {
      state: opInfo.state,
      rows: rowsSummary,
      ...(result !== undefined ? { result } : {}),
      ...(opInfo.error ? { error: opInfo.error } : {}),
    };
  }

  return formatted;
}

// ============================================================================
// Tool Creator
// ============================================================================

export function createExecuteWorkflowTool(workflowState: WorkflowState, config: ExecutionConfig) {
  return tool({
    description:
      "Execute the current workflow and retrieve results. " +
      "Runs all operators and collects output from sink operators. " +
      "Optionally specify which operator IDs to view results for.",
    inputSchema: z.object({
      operatorIdsToView: z.array(z.string()).describe("List of operator IDs to view results for."),
    }),
    execute: async (args: { operatorIdsToView?: string[] }, options: { abortSignal?: AbortSignal }) => {
      try {
        const logicalPlan = buildLogicalPlan(workflowState, args.operatorIdsToView);

        if (logicalPlan.operators.length === 0) {
          return createErrorResult("Cannot execute: workflow has no operators.");
        }

        const validationResult = validateWorkflow(workflowState);
        if (!validationResult.isValid) {
          return createErrorResult(formatWorkflowValidationErrors(validationResult));
        }

        const result = await executeWorkflowHttp(config, logicalPlan, {
          abortSignal: options.abortSignal,
        });

        // Format results using configured serialization mode
        const serializationMode = config.serializationMode ?? OperatorResultSerializationMode.TABLE;
        const formattedResults = formatOperatorResults(result.operators, serializationMode);

        // Build simplified response
        const response: Record<string, any> = { results: formattedResults };

        // Only include errors if present
        if (result.compilationErrors && Object.keys(result.compilationErrors).length > 0) {
          response.compilationErrors = result.compilationErrors;
        }
        if (result.errors && result.errors.length > 0) {
          response.errors = result.errors;
        }

        // Build status message
        let statusMessage: string;
        if (result.success) {
          statusMessage = "Workflow execution completed successfully.";
        } else if (result.state === "Failed") {
          const errorMsgs =
            result.errors?.join("; ") ||
            Object.entries(result.operators)
              .filter(([_, op]) => op.error)
              .map(([opId, op]) => `${opId}: ${op.error}`)
              .join("; ") ||
            "Unknown error";
          statusMessage = `Workflow execution failed: ${errorMsgs}`;
        } else if (result.state === "Killed") {
          statusMessage = "Workflow execution was killed (timeout).";
        } else if (result.state === "CompilationFailed" || result.state === "ValidationFailed") {
          const compilationMsgs = result.compilationErrors
            ? Object.entries(result.compilationErrors)
                .map(([k, v]) => `${k}: ${v}`)
                .join("; ")
            : "Unknown compilation error";
          statusMessage = `Workflow compilation failed: ${compilationMsgs}`;
        } else {
          statusMessage = `Workflow execution ended with state: ${result.state}`;
        }

        return createToolResult(statusMessage, response);
      } catch (error: any) {
        if (error.name === "AbortError") {
          throw error;
        }
        return createErrorResult(`Execution failed: ${error.message || String(error)}`);
      }
    },
  });
}
