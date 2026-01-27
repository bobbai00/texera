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
import { encode as toonEncode } from "@toon-format/toon";
import { createErrorResult } from "./tools-utility";
import type { WorkflowState } from "../workflow/workflow-state";
import { getBackendConfig } from "../api/backend-api";
import type { LogicalPlan, LogicalLink } from "../api/execution-api";
import type { SyncExecutionResult } from "../types/execution";
import { OperatorMetadataStore } from "./metadata-tools";
import { OperatorResultSerializationMode, DEFAULT_AGENT_SETTINGS } from "../types/agent";

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
  /** Maximum characters for operator results (uses symmetric truncation) */
  maxOperatorResultCharLimit?: number;
  /** Maximum characters per cell */
  maxOperatorResultCellCharLimit?: number;
  /** Execution timeout in milliseconds */
  executionTimeoutMs?: number;
}

// ============================================================================
// Execution Mutex
// ============================================================================

/**
 * Simple async mutex for serializing execution requests per workflow.
 * Ensures concurrent requests wait in queue and execute one at a time.
 */
class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release: () => void;
    const currentQueue = this.queue;

    // Chain a new promise that will resolve when the caller releases
    this.queue = new Promise<void>(resolve => {
      release = resolve;
    });

    // Wait for all previous operations to complete
    await currentQueue;

    return release!;
  }
}

/** Map of workflow ID to its mutex */
const workflowMutexes = new Map<number, AsyncMutex>();

function getWorkflowMutex(workflowId: number): AsyncMutex {
  let mutex = workflowMutexes.get(workflowId);
  if (!mutex) {
    mutex = new AsyncMutex();
    workflowMutexes.set(workflowId, mutex);
  }
  return mutex;
}

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
    : Math.ceil(DEFAULT_AGENT_SETTINGS.executionTimeoutMs / 1000);

  // Backend returns JSON - agent-service handles serialization to table/toon format
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
    maxOperatorResultCharLimit: config.maxOperatorResultCharLimit ?? DEFAULT_AGENT_SETTINGS.maxOperatorResultCharLimit,
    maxOperatorResultCellCharLimit:
      config.maxOperatorResultCellCharLimit ?? DEFAULT_AGENT_SETTINGS.maxOperatorResultCellCharLimit,
  };

  console.log(
    `[ExecutionTools] Executing workflow via HTTP: ${url} ` +
      `(maxOperatorResultCharLimit: ${request.maxOperatorResultCharLimit}, ` +
      `maxOperatorResultCellCharLimit: ${request.maxOperatorResultCellCharLimit})`
  );

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

/**
 * Meta info for execution result formatting.
 */
interface ResultMeta {
  mode: string;
  displayedRows: number;
  totalRows: number;
  columns: number;
  truncated: boolean;
}

/**
 * Formats the meta info line for execution results.
 * For table/toon: "table (rows: 10/100 truncated due to character limit, columns: 5)"
 * For json: "json (items: 10/100 truncated due to character limit)"
 */
function formatResultMeta(meta: ResultMeta): string {
  if (meta.mode === "json") {
    const itemInfo = meta.truncated
      ? `${meta.displayedRows}/${meta.totalRows} truncated due to character limit`
      : `${meta.displayedRows}`;
    return `${meta.mode} (items: ${itemInfo})`;
  }

  const rowInfo = meta.truncated
    ? `${meta.displayedRows}/${meta.totalRows} truncated due to character limit`
    : `${meta.displayedRows}`;
  return `${meta.mode} (rows: ${rowInfo}, columns: ${meta.columns})`;
}

/**
 * Formats execution error with structured sections.
 */
function formatExecutionError(
  compilationErrors?: Record<string, string>,
  operatorErrors?: Array<{ operatorId: string; error: string }>,
  generalErrors?: string[]
): string {
  const lines: string[] = ["Execution failed due to the following error:"];

  if (compilationErrors && Object.keys(compilationErrors).length > 0) {
    lines.push("Compilation error:");
    for (const [key, value] of Object.entries(compilationErrors)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  if (operatorErrors && operatorErrors.length > 0) {
    lines.push("Execution error:");
    for (const { operatorId, error } of operatorErrors) {
      lines.push(`  ${operatorId}: ${error}`);
    }
  }

  if (generalErrors && generalErrors.length > 0) {
    lines.push("Error:");
    for (const error of generalErrors) {
      lines.push(`  ${error}`);
    }
  }

  return lines.join("\n");
}

/**
 * Convert JSON result to table format (pandas DataFrame-like, tab-separated).
 * Respects original types: numbers/booleans are not quoted, only complex types use JSON.
 * Uses tab (\t) as column separator for readability.
 */
function jsonToTableFormat(jsonResult: Record<string, any>[]): string {
  if (!jsonResult || jsonResult.length === 0) return "";

  const headers = Object.keys(jsonResult[0]);
  const headerLine = headers.join("\t");

  const rows = jsonResult.map(row =>
    headers
      .map(h => {
        const val = row[h];
        // Handle null/undefined
        if (val === null) return "null";
        if (val === undefined) return "";
        // Preserve primitive types without quotes
        if (typeof val === "number" || typeof val === "boolean") {
          return String(val);
        }
        // Strings: escape tabs and newlines for table format
        if (typeof val === "string") {
          return val.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
        }
        // Complex types (arrays, objects): use JSON representation
        return JSON.stringify(val);
      })
      .join("\t")
  );

  return [headerLine, ...rows].join("\n");
}

/**
 * Convert JSON result to TOON format (Token-Oriented Object Notation).
 * Uses the official @toon-format/toon library.
 * TOON is a compact format designed for LLMs that reduces token usage by 30-60%.
 *
 * Example output:
 *   data[3]{ID,card_scheme,account_type,aci}:
 *   1,TransactPlus,[],["C","B"]
 *   2,GlobalCard,["R"],["A"]
 *   3,NexPay,[],[]
 */
function jsonToToonFormat(jsonResult: Record<string, any>[]): string {
  if (!jsonResult || jsonResult.length === 0) return "";

  // Wrap the array in an object with "data" key for TOON encoding
  // This produces: data[n]{col1,col2,...}: followed by rows
  return toonEncode({ data: jsonResult });
}

// ============================================================================
// Common Execution Function
// ============================================================================

/**
 * Execute a workflow for a specific operator and return the formatted result.
 * This is the core execution logic shared by the executeWorkflow tool and auto-execute feature.
 *
 * @param workflowState - The workflow state
 * @param config - Execution configuration
 * @param operatorId - The operator to execute and get results for
 * @param options - Optional abort signal
 * @returns Formatted result string or error message
 */
export async function executeOperatorAndFormat(
  workflowState: WorkflowState,
  config: ExecutionConfig,
  operatorId: string,
  options: { abortSignal?: AbortSignal } = {}
): Promise<string> {
  // Acquire mutex to serialize executions for this workflow
  // This prevents ConcurrentModificationException on the backend
  const release = await getWorkflowMutex(config.workflowId).acquire();

  try {
    // Build logical plan for the single operator (sub-DAG up to this operator)
    const logicalPlan = buildLogicalPlan(workflowState, [operatorId]);

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

    // Handle execution failure
    if (!result.success) {
      const compilationErrors =
        result.state === "CompilationFailed" || result.state === "ValidationFailed"
          ? result.compilationErrors
          : undefined;

      const operatorErrors =
        result.state === "Failed"
          ? Object.entries(result.operators)
              .filter(([_, op]) => op.error)
              .map(([opId, op]) => ({ operatorId: opId, error: op.error! }))
          : undefined;

      const generalErrors =
        result.state === "Killed" ? ["Workflow execution was killed (timeout)."] : result.errors;

      return createErrorResult(formatExecutionError(compilationErrors, operatorErrors, generalErrors));
    }

    // Check operator result
    const opInfo = result.operators[operatorId];
    if (!opInfo) {
      return createErrorResult(
        formatExecutionError(undefined, undefined, [`No result found for operator: ${operatorId}`])
      );
    }

    if (opInfo.error) {
      return createErrorResult(formatExecutionError(undefined, [{ operatorId, error: opInfo.error }]));
    }

    // Get result info - backend always returns JSON array, agent-service serializes
    const serializationMode = config.serializationMode ?? OperatorResultSerializationMode.TABLE;

    if (!opInfo.result || !Array.isArray(opInfo.result)) {
      return "(no result data)";
    }

    // Backend returns JSON array - serialize based on configured mode
    const jsonArray = opInfo.result as Record<string, any>[];
    const columns = jsonArray.length > 0 ? Object.keys(jsonArray[0]).length : 0;

    let dataString: string;
    let modeLabel: string;

    switch (serializationMode) {
      case OperatorResultSerializationMode.TABLE:
        dataString = jsonToTableFormat(jsonArray);
        modeLabel = "table";
        break;
      case OperatorResultSerializationMode.TOON:
        dataString = jsonToToonFormat(jsonArray);
        modeLabel = "toon";
        break;
      case OperatorResultSerializationMode.JSON:
      default:
        dataString = JSON.stringify(jsonArray);
        modeLabel = "json";
        break;
    }

    // Backend returns data row counts. For tabular formats (table/toon),
    // add 1 for the header row since the displayed output includes it.
    const headerOffset = (modeLabel === "table" || modeLabel === "toon") ? 1 : 0;
    const rawDisplayedRows = opInfo.displayedRows ?? 0;
    const rawTotalRows = opInfo.totalRowCount ?? rawDisplayedRows;
    const displayedRows = rawDisplayedRows + headerOffset;
    const totalRows = rawTotalRows + headerOffset;
    const truncated = opInfo.truncated ?? rawDisplayedRows < rawTotalRows;

    const meta = formatResultMeta({ mode: modeLabel, displayedRows, totalRows, columns, truncated });
    return `${meta}\n${dataString}`;
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw error;
    }
    return createErrorResult(`Execution failed: ${error.message || String(error)}`);
  } finally {
    release();
  }
}

// ============================================================================
// Tool Creator
// ============================================================================

/**
 * Create the executeWorkflow tool.
 * @param workflowState - The workflow state
 * @param getConfig - Function that returns the current execution config (called at execution time)
 */
export function createExecuteWorkflowTool(workflowState: WorkflowState, getConfig: () => ExecutionConfig) {
  return tool({
    description: "Execute the current workflow and get the specified operator's result.",
    inputSchema: z.object({
      operatorId: z.string().describe("The operator ID to view result for."),
    }),
    execute: async (args: { operatorId: string }, options: { abortSignal?: AbortSignal }) => {
      // Get current config at execution time (allows settings updates to take effect)
      const config = getConfig();
      return executeOperatorAndFormat(workflowState, config, args.operatorId, options);
    },
  });
}
