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
import type { OperatorInfo, SyncExecutionResult } from "../types/execution";
import { OperatorMetadataStore } from "./metadata-tools";
import { OperatorResultSerializationMode, ExecutionBackend, DEFAULT_AGENT_SETTINGS } from "../types/agent";

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_EXECUTE_OPERATOR = "executeOperator";

// Section separators used in execution results.
// These are also used by context-optimization.ts to selectively trim sections.
export const SECTION_EXECUTION_METADATA = "--- Execution Metadata ---";
export const SECTION_EXECUTION_RESULT = "--- Execution Result ---";

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
  /** Whether to enable operator result caching */
  cacheEnabled?: boolean;
  /** Execution backend: texera (default) or hamilton */
  executionBackend?: ExecutionBackend;
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
    cacheEnabled: config.cacheEnabled ?? DEFAULT_AGENT_SETTINGS.cacheEnabled,
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
// Hamilton Execution Function
// ============================================================================

/**
 * Execute a workflow via the Hamilton sidecar.
 * Sends WorkflowContent format (operators with operatorProperties.code,
 * links with source/target) rather than the Texera LogicalPlan format.
 * The sidecar is stateless — it translates to Hamilton and executes.
 */
async function executeWorkflowHamilton(
  config: ExecutionConfig,
  workflowState: WorkflowState,
  operatorId: string,
  options: { abortSignal?: AbortSignal } = {}
): Promise<SyncExecutionResult> {
  const backendConfig = getBackendConfig();
  const hamiltonEndpoint = backendConfig.hamiltonEndpoint || "http://localhost:8111";

  const url = `${hamiltonEndpoint}/execute`;

  const timeoutSeconds = config.executionTimeoutMs
    ? Math.ceil(config.executionTimeoutMs / 1000)
    : Math.ceil(DEFAULT_AGENT_SETTINGS.executionTimeoutMs / 1000);

  // Get the sub-DAG up to the target operator, in WorkflowContent format
  const subDAG = workflowState.getSubDAG(operatorId);

  const request = {
    operators: subDAG.operators,
    links: subDAG.links,
    targetOperatorIds: [operatorId],
    timeoutSeconds,
    maxResultRows: config.maxOperatorResultCharLimit
      ? Math.floor(config.maxOperatorResultCharLimit / 200)
      : 200,
  };

  console.log(
    `[ExecutionTools] Executing workflow via Hamilton: ${url} ` +
      `(operators: ${subDAG.operators.length}, links: ${subDAG.links.length}, target: ${operatorId})`
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: options.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Hamilton execution failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    console.error("[ExecutionTools] Hamilton execution failed:", error);
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
 * For table/toon: only shows truncation notice if truncated, empty otherwise
 * (shape arrow already conveys row/column counts).
 * For json: "json (items: 10/100 truncated due to token limit)"
 */
function formatResultMeta(meta: ResultMeta): string {
  if (meta.mode === "json") {
    const itemInfo = meta.truncated
      ? `${meta.displayedRows}/${meta.totalRows} truncated due to token limit`
      : `${meta.displayedRows}`;
    return `${meta.mode} (items: ${itemInfo})`;
  }

  // For table/toon: only show truncation notice
  if (meta.truncated) {
    return `${meta.displayedRows}/${meta.totalRows} rows are displayed due to the token limit`;
  }
  return "";
}

/**
 * Extract input parameter names from a Python UDF operator's code.
 * Matches `def process(param1, param2)` or `def load()` signatures.
 * Port index 0 corresponds to the first parameter, index 1 to the second, etc.
 */
function getInputParamNames(workflowState: WorkflowState, operatorId: string): string[] {
  const op = workflowState.getOperator(operatorId);
  if (!op) return [];
  const code: string = op.operatorProperties?.code ?? "";
  const match = code.match(/def\s+(?:process|load)\s*\(([^)]*)\)/);
  if (!match || !match[1].trim()) return [];
  // Extract just the parameter name (before any type annotation or default value)
  return match[1]
    .split(",")
    .map(p => p.trim().split(/[:\s=]/)[0])
    .filter(Boolean);
}

/**
 * Format the input/output shape arrow notation for an operator.
 * Example: "Shape: customers(100, 3), orders(200, 5) -> (150, 6)"
 */
function formatShapeArrow(
  opInfo: OperatorInfo,
  outputColumns: number,
  paramNames: string[],
  operatorId: string
): string {
  const outputRows = opInfo.totalRowCount ?? opInfo.outputTuples;
  const outputPart = `${operatorId}(${outputRows}, ${outputColumns})`;

  const inputShapes = opInfo.inputPortShapes;
  if (!inputShapes || inputShapes.length === 0) {
    return `Shape: ${outputPart}`;
  }

  const inputPart = inputShapes
    .sort((a, b) => a.portIndex - b.portIndex)
    .map(p => {
      const name = paramNames[p.portIndex] ?? `input${p.portIndex}`;
      return `${name}(${p.rows}, ${p.columns})`;
    })
    .join(", ");

  return `Shape: ${inputPart} -> ${outputPart}`;
}

/**
 * Format the upstream sub-DAG from source operators to the target operator.
 * Shows all source-to-target paths so the agent understands the data lineage.
 * Node format: "operatorID: displayName" (or just "operatorID" if no custom name).
 * Example: "Dataflow: CSVFileScan-operator-1: load_csv -> PythonUDFV2-operator-2: wollaston_tidy"
 */
function formatDataflow(workflowState: WorkflowState, targetOperatorId: string): string {
  const subDAG = workflowState.getSubDAG(targetOperatorId);
  if (subDAG.operators.length <= 1) return "";

  // Build label map: operatorId -> "operatorID: displayName" or just "operatorID"
  const labelMap = new Map(
    subDAG.operators.map(op => [
      op.operatorID,
      op.customDisplayName ? `${op.operatorID}: ${op.customDisplayName}` : op.operatorID,
    ])
  );

  // Build adjacency lists within the sub-DAG
  const children = new Map<string, string[]>();
  const parentCount = new Map<string, number>();
  for (const op of subDAG.operators) {
    children.set(op.operatorID, []);
    parentCount.set(op.operatorID, 0);
  }
  for (const link of subDAG.links) {
    children.get(link.source.operatorID)?.push(link.target.operatorID);
    parentCount.set(link.target.operatorID, (parentCount.get(link.target.operatorID) ?? 0) + 1);
  }

  // Find source nodes (no incoming edges in sub-DAG)
  const sources = subDAG.operators
    .filter(op => (parentCount.get(op.operatorID) ?? 0) === 0)
    .map(op => op.operatorID);

  // Enumerate all source-to-target paths via DFS (capped for safety)
  const MAX_PATHS = 20;
  const paths: string[][] = [];
  const dfs = (nodeId: string, path: string[]) => {
    if (paths.length >= MAX_PATHS) return;
    path.push(labelMap.get(nodeId) ?? nodeId);
    if (nodeId === targetOperatorId) {
      paths.push([...path]);
    } else {
      for (const child of children.get(nodeId) ?? []) {
        dfs(child, path);
      }
    }
    path.pop();
  };
  for (const source of sources) {
    dfs(source, []);
  }

  if (paths.length === 0) return "";
  const padding = "          "; // align with "Dataflow: "
  return "Dataflow: " + paths.map(p => p.join(" -> ")).join("\n" + padding);
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
 * Convert JSON result to pandas DataFrame-style table format (tab-separated).
 * Includes row indices (0, 1, 2, ...) and a leading tab on the header row
 * to align with the index column, matching pandas `__repr__` output.
 * Uses tab (\t) as column separator for readability.
 */
function jsonToTableFormat(jsonResult: Record<string, any>[]): string {
  if (!jsonResult || jsonResult.length === 0) return "";

  const headers = Object.keys(jsonResult[0]);
  // Leading tab aligns headers with the index column (pandas style)
  const headerLine = "\t" + headers.join("\t");

  const rows = jsonResult.map((row, idx) => {
    const cells = headers.map(h => {
      const val = row[h];
      if (val === null) return "null";
      if (val === undefined) return "";
      if (typeof val === "number" || typeof val === "boolean") return String(val);
      if (typeof val === "string") return val.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
      return JSON.stringify(val);
    });
    return `${idx}\t${cells.join("\t")}`;
  });

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

    const result =
      config.executionBackend === ExecutionBackend.HAMILTON
        ? await executeWorkflowHamilton(config, workflowState, operatorId, {
            abortSignal: options.abortSignal,
          })
        : await executeWorkflowHttp(config, logicalPlan, {
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

    const displayedRows = opInfo.displayedRows ?? 0;
    const totalRows = opInfo.totalRowCount ?? displayedRows;
    const truncated = opInfo.truncated ?? displayedRows < totalRows;

    // Build dataflow: show upstream sub-DAG so the agent understands data lineage
    const dataflowLine = formatDataflow(workflowState, operatorId);

    // Build shape arrow notation: e.g. "Shape: input0(100, 3) -> opId(150, 6)"
    const paramNames = getInputParamNames(workflowState, operatorId);
    const shapeLine = formatShapeArrow(opInfo, columns, paramNames, operatorId);

    // Build columns line: e.g. "Columns: ['a', 'b', 'c']"
    const columnNames = jsonArray.length > 0 ? Object.keys(jsonArray[0]) : [];
    const columnsLine = columnNames.length > 0
      ? `Columns: [${columnNames.map(c => `'${c}'`).join(", ")}]`
      : "";

    const meta = formatResultMeta({ mode: modeLabel, displayedRows, totalRows, columns, truncated });

    // Surface warnings (e.g., duplicate column renames) so the agent can adjust its code
    const warningLines = opInfo.warnings?.map(w => w) ?? [];

    // Build structured result with separate metadata and result sections.
    // Context optimization can trim the result section while preserving metadata.
    const metadataLines = [dataflowLine, shapeLine, columnsLine, meta, ...warningLines].filter(Boolean);
    const metadataSection = metadataLines.length > 0
      ? `${SECTION_EXECUTION_METADATA}\n${metadataLines.join("\n")}`
      : "";
    const resultSection = `${SECTION_EXECUTION_RESULT}\n${dataString}`;

    return [metadataSection, resultSection].filter(Boolean).join("\n\n");
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
 * Create the executeOperator tool.
 * @param workflowState - The workflow state
 * @param getConfig - Function that returns the current execution config (called at execution time)
 */
export function createExecuteOperatorTool(workflowState: WorkflowState, getConfig: () => ExecutionConfig) {
  return tool({
    description: "Execute the workflow and get the specified operator's result. The execution result(if succeeded) includes the data flow of the execution path, the shape of the input tables(if any) and output table, and the records in the output table",
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
