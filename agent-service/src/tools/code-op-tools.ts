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
 * Code operator tools for Texera Agent Service (CODE mode).
 * These tools work with Python code operators (DataLoading, DataProcessing).
 */

import { z } from "zod";
import { tool } from "ai";
import type { WorkflowState } from "../workflow/workflow-state";
import { WorkflowUtilService } from "../workflow/workflow-util";
import {
  createToolResult,
  createErrorResult,
  formatAddOperatorResult,
  formatModifyOperatorResult,
  formatOperatorError,
} from "./tools-utility";
import type { ToolContext } from "./workflow-tools";

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_ADD_CODE_OPERATOR = "addOperator";
export const TOOL_NAME_MODIFY_CODE_OPERATOR = "modifyOperator";

// ============================================================================
// Operator Types for Code Blocks
// ============================================================================

const DATA_PROCESSING_OPERATOR_TYPE = "DataProcessing";
const DATA_LOADING_OPERATOR_TYPE = "DataLoading";

// ============================================================================
// Code Block Parsing and Validation
// ============================================================================

/**
 * Result of parsing a Python code block.
 */
interface CodeBlockParseResult {
  type: "DataLoading" | "DataProcessing";
  functionName: string;
  parameters: string[];
  numInputPorts: number;
}

/**
 * Parses a Python code block to determine its type and extract function info.
 *
 * DataLoading: def load() or def load_data() - no parameters, source operator
 * DataProcessing: def process(table1, table2) - parameters become input ports
 */
function parseCodeBlock(code: string): CodeBlockParseResult | { error: string } {
  // Match function definition: def func_name(params) or def func_name(params) -> ReturnType:
  const funcPattern = /def\s+(\w+)\s*\(([^)]*)\)/;
  const match = funcPattern.exec(code);

  if (!match) {
    return { error: "No valid Python function definition found. Expected: def function_name(parameters):" };
  }

  const functionName = match[1];
  const paramsStr = match[2].trim();

  // Parse parameters (handle type annotations like "table1: pd.DataFrame")
  const parameters: string[] = paramsStr
    ? paramsStr
        .split(",")
        .map(p => p.trim())
        .map(p => p.split(":")[0].trim()) // Remove type annotations
        .filter(p => p.length > 0)
    : [];

  // Determine type based on function name and parameters
  // DataLoading: typically "load" function with no parameters
  // DataProcessing: "process" function with parameters
  const isLoadingFunction =
    (functionName.toLowerCase().includes("load") || functionName.toLowerCase() === "generate") &&
    parameters.length === 0;

  if (isLoadingFunction) {
    return {
      type: "DataLoading",
      functionName,
      parameters: [],
      numInputPorts: 0,
    };
  }

  // DataProcessing requires at least one input
  if (parameters.length === 0) {
    return {
      error: `Function "${functionName}" has no parameters. For DataProcessing, parameters define input ports. For DataLoading, use a function like "load()" with no parameters.`,
    };
  }

  return {
    type: "DataProcessing",
    functionName,
    parameters,
    numInputPorts: parameters.length,
  };
}

/**
 * Validates Python syntax using the Python interpreter.
 * Returns null if valid, error message if invalid.
 */
async function validatePythonSyntax(code: string): Promise<string | null> {
  const { spawn } = await import("child_process");

  return new Promise(resolve => {
    // Use Python's ast module to check syntax
    const pythonCode = `
import ast
import sys
try:
    ast.parse('''${code.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}''')
    sys.exit(0)
except SyntaxError as e:
    print(f"Line {e.lineno}: {e.msg}", file=sys.stderr)
    sys.exit(1)
`;

    const process = spawn("python3", ["-c", pythonCode]);
    let stderr = "";

    process.stderr.on("data", data => {
      stderr += data.toString();
    });

    process.on("close", exitCode => {
      if (exitCode === 0) {
        resolve(null);
      } else {
        resolve(stderr.trim() || "Python syntax error");
      }
    });

    process.on("error", err => {
      // If Python is not available, skip syntax validation
      console.warn("[addCodeBlock] Python not available for syntax validation:", err.message);
      resolve(null);
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      process.kill();
      resolve(null); // Don't fail if timeout
    }, 5000);
  });
}

// ============================================================================
// Add Code Operator Tool
// ============================================================================

export function createAddCodeOperatorTool(
  workflowState: WorkflowState,
  operatorSchemas: Map<string, any>,
  context?: ToolContext
) {
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore) : null;

  return tool({
    description: `Add a Python function as an operator to the dataflow.

IMPORTANT: The function name MUST be exactly "load" or "process" following the below signatures.

## def load() -> pd.DataFrame
Purpose: Load data from files or external sources. No input ports.
- Use when: Reading the metadata of the files from the disk
- File I/O is allowed
- Do NOT do data processing in this operator, ONLY do data loading
- Do NOT use print statements
- Do NOT load the entire large data files directly, load its metadata and samples for understanding; Only load the entire file during processing time
Examples:
  # Load entire CSV file for downstream processing
  def load() -> pd.DataFrame:
      return pd.read_csv('/path/to/data.csv')
  
  # Load md file and emit the dataframe
  def load() -> pd.DataFrame:
      with open('/path/to/readme.md', 'r') as f:
          content = f.read()
      return pd.DataFrame([{'filename': 'readme.md', 'content': content}])

  # Load sample and metadata for a large CSV file
  def load() -> pd.DataFrame:
      import os
      path = '/path/to/large_data.csv'
      file_size = os.path.getsize(path)
      sample = pd.read_csv(path, nrows=5)
      return pd.DataFrame([{
          'file': path,
          'size_bytes': file_size,
          'columns': list(sample.columns),
          'sample_rows': sample.to_dict()
      }])

## def process(input1, input2, ...) -> pd.DataFrame
Purpose: Transform input data. Each parameter becomes an input port and represents the dataframe from that input port.
- Use when: Filtering, joining, aggregating, or transforming data from upstream operators
- File IO is FORBIDDEN
- Do NOT do File IO in this function, ONLY focus on data processing
- Do NOT use print statements

Examples:
  # process a single input dataframe
  def process(users) -> pd.DataFrame:
      filtered = users[users['age'] > 18]
      return filtered[['name', 'age', 'city']]
  
  # process two input dataframes from two input ports
  def process(orders, customers) -> pd.DataFrame:
      return orders.merge(customers, on='customer_id')`,
    inputSchema: z.object({
      code: z.string().describe("Python function code defining either a load() or process(...) function"),
      summary: z.string().optional().describe("Brief summary that becomes the operator's display name"),
    }),
    execute: async (args: { code: string; summary?: string }) => {
      try {
        const { code, summary } = args;

        // Parse the code block to determine type and parameters
        const parseResult = parseCodeBlock(code);
        if ("error" in parseResult) {
          return createErrorResult(parseResult.error);
        }

        const { type, functionName, numInputPorts } = parseResult;
        const operatorType = type === "DataLoading" ? DATA_LOADING_OPERATOR_TYPE : DATA_PROCESSING_OPERATOR_TYPE;

        // Check if operator type is available
        const schemaEntry = operatorSchemas.get(operatorType);
        if (!schemaEntry) {
          return createErrorResult(
            `Operator type "${operatorType}" is not available. Please ensure the operator is registered.`
          );
        }

        // Validate Python syntax
        const syntaxError = await validatePythonSyntax(code);
        if (syntaxError) {
          return createErrorResult(`Python syntax error: ${syntaxError}`);
        }

        if (!workflowUtil) {
          return createErrorResult("Metadata store not available for operator creation");
        }

        const beforeContent = workflowState.getWorkflowContent();

        // Use summary as display name if provided, otherwise use function name
        const displayName = summary || functionName;

        // Create the operator with the code property
        let operator = workflowUtil.getNewOperatorPredicate(operatorType, displayName);
        operator = {
          ...operator,
          operatorProperties: {
            ...operator.operatorProperties,
            code: code,
          },
        };

        workflowState.addOperator(operator);

        // Set up input ports for DataProcessing operators
        if (type === "DataProcessing" && numInputPorts > 1) {
          workflowState.updateOperatorInputPorts(operator.operatorID, numInputPorts);
        }

        const updatedOperator = workflowState.getOperator(operator.operatorID);
        const afterContent = workflowState.getWorkflowContent();

        // Create agent action for tracking
        if (context?.agentActionManager && context.agentId) {
          context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            summary || `Added ${type} code operator: ${functionName}`,
            { add: { operatorIds: [operator.operatorID], linkIds: [] } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
        }

        const finalOperator = updatedOperator || operator;

        return createToolResult(
          formatAddOperatorResult(operator.operatorID, finalOperator.inputPorts.length, finalOperator.outputPorts.length)
        );
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}

// ============================================================================
// Modify Code Operator Tool
// ============================================================================

export function createModifyCodeOperatorTool(workflowState: WorkflowState, context?: ToolContext) {
  return tool({
    description:
      "Modify the Python code of an existing DataProcessing or DataLoading operator. " +
      "The new code must be of the same type as the existing operator. " +
      "For def process function, the number of input ports will be updated based on function parameters.",
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to modify"),
      code: z.string().describe("New Python function code (must match the operator type - load() or process(...))"),
      summary: z.string().optional().describe("Brief summary that becomes the operator's display name"),
    }),
    execute: async (args: { operatorId: string; code: string; summary?: string }) => {
      try {
        const { operatorId, code, summary } = args;

        // Get the existing operator
        const operator = workflowState.getOperator(operatorId);
        if (!operator) {
          return createErrorResult(`Operator ${operatorId} not found`);
        }

        // Check if operator is a code block type
        const isDataLoading = operator.operatorType === DATA_LOADING_OPERATOR_TYPE;
        const isDataProcessing = operator.operatorType === DATA_PROCESSING_OPERATOR_TYPE;

        if (!isDataLoading && !isDataProcessing) {
          return createErrorResult(
            `Operator ${operatorId} is not a code operator. ` +
              `Expected type: ${DATA_LOADING_OPERATOR_TYPE} or ${DATA_PROCESSING_OPERATOR_TYPE}, ` +
              `got: ${operator.operatorType}`
          );
        }

        // Parse the new code block
        const parseResult = parseCodeBlock(code);
        if ("error" in parseResult) {
          return createErrorResult(parseResult.error);
        }

        const { type: newType, numInputPorts } = parseResult;

        // Check type consistency
        const expectedType = isDataLoading ? "DataLoading" : "DataProcessing";
        if (newType !== expectedType) {
          return createErrorResult(
            `Code type mismatch. Operator ${operatorId} is a ${expectedType} operator, ` +
              `but the provided code is for ${newType}. ` +
              `Use a ${expectedType === "DataLoading" ? "load()" : "process(...)"} function.`
          );
        }

        // Validate Python syntax
        const syntaxError = await validatePythonSyntax(code);
        if (syntaxError) {
          return createErrorResult(`Python syntax error: ${syntaxError}`);
        }

        const beforeContent = workflowState.getWorkflowContent();

        // Update the code property and optionally the display name
        const propertiesToUpdate: Record<string, any> = { code };
        workflowState.updateOperatorProperties(operatorId, propertiesToUpdate);

        // Update display name if summary is provided
        if (summary) {
          workflowState.updateOperatorDisplayName(operatorId, summary);
        }

        // Update input ports for DataProcessing if needed
        if (isDataProcessing) {
          const currentInputPorts = operator.inputPorts.length;
          if (numInputPorts !== currentInputPorts) {
            workflowState.updateOperatorInputPorts(operatorId, numInputPorts);
          }
        }

        const afterContent = workflowState.getWorkflowContent();

        // Create agent action for tracking
        if (context?.agentActionManager && context.agentId) {
          context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            summary || `Modified code operator: ${operatorId}`,
            { modify: { operatorIds: [operatorId] } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
        }

        return createToolResult(formatModifyOperatorResult(operatorId));
      } catch (error: any) {
        return createErrorResult(formatOperatorError(args.operatorId, error.message || String(error)));
      }
    },
  });
}
