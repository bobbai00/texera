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
import type { OperatorPredicate, OperatorLink } from "../types/workflow";
import { autoLayoutWorkflow } from "../workflow/auto-layout";
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
 * Python reserved keywords that cannot be used as variable names.
 */
const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await",
  "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
  "while", "with", "yield"
]);

/**
 * Validates if a string is a valid Python variable name.
 * Returns null if valid, error message if invalid.
 */
function validatePythonVariableName(name: string): string | null {
  if (!name || name.length === 0) {
    return "Variable name cannot be empty";
  }

  // Check if it matches Python identifier pattern: starts with letter or underscore,
  // followed by letters, digits, or underscores
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  if (!validPattern.test(name)) {
    return `'${name}' is not a valid Python variable name. ` +
      `Must start with a letter or underscore, followed by letters, digits, or underscores.`;
  }

  // Check if it's a Python keyword
  if (PYTHON_KEYWORDS.has(name)) {
    return `'${name}' is a Python reserved keyword and cannot be used as a variable name.`;
  }

  return null; // Valid
}

/**
 * Parses a Python code block to determine its type and extract function info.
 *
 * DataLoading: def load() - EXACTLY "load", no parameters, source operator
 * DataProcessing: def process(table1, table2) - EXACTLY "process", parameters become input ports
 */
function parseCodeBlock(code: string): CodeBlockParseResult | { error: string } {
  // Match function definition: def func_name(params) or def func_name(params) -> ReturnType:
  const funcPattern = /def\s+(\w+)\s*\(([^)]*)\)/;
  const match = funcPattern.exec(code);

  if (!match) {
    return { error: "No valid Python function definition found. Expected: def load() or def process(...):" };
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

  // Strict function name validation
  // DataLoading: MUST be exactly "load" with no parameters
  // DataProcessing: MUST be exactly "process" with at least one parameter
  if (functionName === "load") {
    if (parameters.length > 0) {
      return {
        error: `Function "load" must have no parameters. Found parameters: [${parameters.join(", ")}]. ` +
          `For data processing with inputs, use "def process(${parameters.join(", ")})".`,
      };
    }
    return {
      type: "DataLoading",
      functionName,
      parameters: [],
      numInputPorts: 0,
    };
  }

  if (functionName === "process") {
    if (parameters.length === 0) {
      return {
        error: `Function "process" must have at least one parameter representing input data. ` +
          `Example: def process(data) -> pd.DataFrame: ...`,
      };
    }
    return {
      type: "DataProcessing",
      functionName,
      parameters,
      numInputPorts: parameters.length,
    };
  }

  // Invalid function name
  return {
    error: `Invalid function name "${functionName}". Function name must be exactly "load" or "process".\n` +
      `- Use "def load() -> pd.DataFrame:" for data loading (no input ports)\n` +
      `- Use "def process(input1, input2, ...) -> pd.DataFrame:" for data processing (with input ports)`,
  };
}

/**
 * Find an operator by its ID (variable name) in the workflow.
 * Returns the operator if found, undefined otherwise.
 */
function findOperatorByName(workflowState: WorkflowState, operatorName: string): OperatorPredicate | undefined {
  return workflowState.getOperator(operatorName);
}

/**
 * Format operator content for error messages.
 */
function formatOperatorContent(operator: OperatorPredicate): string {
  const props = operator.operatorProperties || {};
  const code = props.code ? `\n  code: ${props.code.substring(0, 100)}...` : "";
  return `{type: ${operator.operatorType}, displayName: "${operator.customDisplayName || operator.operatorID}"${code}}`;
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
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore, workflowState) : null;

  return tool({
    description: `Add a Python function as an operator to the dataflow.

IMPORTANT RULES:
1. operatorId is REQUIRED - this becomes the operator's unique ID
2. Function name MUST be exactly "load" or "process"
3. For process(): each parameter MUST match an existing operator's operatorId - links are auto-created

## def load() -> pd.DataFrame
Purpose: Load data from files or external sources. No input ports.
- File I/O is allowed
- Do NOT do data processing, ONLY data loading

Example: operatorId="roman_cities"
  def load() -> pd.DataFrame:
      return pd.read_csv('/path/to/roman_cities.csv')

Example: operatorId="world_cities"
  def load() -> pd.DataFrame:
      return pd.read_csv('/path/to/worldcities.csv')

## def process(input1, input2, ...) -> pd.DataFrame
Purpose: Transform input data. Each parameter references an existing operator by its operatorId.
- CRITICAL: Each parameter name MUST match an existing operator's operatorId
- Links from input operators to this operator are AUTO-CREATED
- File IO is FORBIDDEN

Example: operatorId="filtered_users" (requires operator "users" to exist)
  def process(users) -> pd.DataFrame:
      return users[users['age'] > 18]
  # Creates link: users-->filtered_users

Example: operatorId="nearby_cities" (requires "roman_cities" AND "world_cities")
  def process(roman_cities, world_cities) -> pd.DataFrame:
      return world_cities[world_cities['population'] > 100000]
  # Creates links: roman_cities-->nearby_cities, world_cities-->nearby_cities

ERROR CONDITIONS:
- If operatorId is not a valid Python variable name: error with details
- If operatorId already exists as an operator: error with existing operator details
- If any process() parameter doesn't match an existing operator: error listing missing operators`,
    inputSchema: z.object({
      operatorId: z.string().describe(
        "The unique name for this operator (must be a valid Python variable name). You can use this name to uniquely describe the operator's output" +
        "Other operators will reference this ID as an input parameter."
      ),
      code: z.string().describe("Python function code defining either a load() or process(...) function"),
      summary: z.string().optional().describe("Brief summary of the behavior of this operator"),
    }),
    execute: async (args: { operatorId: string; code: string; summary?: string }) => {
      try {
        const { operatorId, code, summary } = args;

        // Validate operatorId is a valid Python variable name
        const nameValidationError = validatePythonVariableName(operatorId);
        if (nameValidationError) {
          return createErrorResult(`Invalid operatorId: ${nameValidationError}`);
        }

        // Check if operator with this name already exists
        const existingOperator = findOperatorByName(workflowState, operatorId);
        if (existingOperator) {
          return createErrorResult(
            `'${operatorId}' already exists: ${formatOperatorContent(existingOperator)}`
          );
        }

        // Parse the code block to determine type and parameters
        const parseResult = parseCodeBlock(code);
        if ("error" in parseResult) {
          return createErrorResult(parseResult.error);
        }

        const { type, functionName, numInputPorts, parameters } = parseResult;
        const operatorType = type === "DataLoading" ? DATA_LOADING_OPERATOR_TYPE : DATA_PROCESSING_OPERATOR_TYPE;

        // For process() functions: validate that all input parameters exist as operators
        const inputOperators: OperatorPredicate[] = [];
        if (type === "DataProcessing" && parameters.length > 0) {
          const missingParams: string[] = [];
          for (const param of parameters) {
            const inputOp = findOperatorByName(workflowState, param);
            if (!inputOp) {
              missingParams.push(param);
            } else {
              inputOperators.push(inputOp);
            }
          }

          if (missingParams.length > 0) {
            return createErrorResult(
              `Input parameter(s) not found as operators: [${missingParams.join(", ")}]. ` +
              `Each parameter in def process(${parameters.join(", ")}) must reference an existing operator by its variable name.`
            );
          }
        }

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

        // Use summary as display name if provided, otherwise use operatorId
        const displayName = summary || operatorId;

        // Create the operator with the code property and custom operator ID
        let operator = workflowUtil.getNewOperatorPredicate(operatorType, displayName);
        const operatorProps: Record<string, any> = {
          ...operator.operatorProperties,
          code: code,
        };

        operator = {
          ...operator,
          operatorID: operatorId, // Use variable name as operator ID
          operatorProperties: operatorProps,
        };

        workflowState.addOperator(operator);

        // Set up input ports for DataProcessing operators
        if (type === "DataProcessing" && numInputPorts > 1) {
          workflowState.updateOperatorInputPorts(operatorId, numInputPorts);
        }

        // Auto-create links from input operators to this new operator
        const createdLinkIds: string[] = [];
        if (type === "DataProcessing" && inputOperators.length > 0) {
          for (let i = 0; i < inputOperators.length; i++) {
            const sourceOp = inputOperators[i];
            const linkId = `${sourceOp.operatorID}-->${operatorId}`;

            const link: OperatorLink = {
              linkID: linkId,
              source: {
                operatorID: sourceOp.operatorID,
                portID: sourceOp.outputPorts[0]?.portID || "output-0",
              },
              target: {
                operatorID: operatorId,
                portID: `input-${i}`,
              },
            };

            workflowState.addLink(link);
            createdLinkIds.push(linkId);
          }
        }

        // Auto-layout the workflow after adding the operator and links
        autoLayoutWorkflow(workflowState);

        const updatedOperator = workflowState.getOperator(operatorId);
        const afterContent = workflowState.getWorkflowContent();

        // Create agent action for tracking
        if (context?.agentActionManager && context.agentId) {
          context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            summary || `Added ${type} code operator: ${operatorId}`,
            { add: { operatorIds: [operatorId], linkIds: createdLinkIds } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
        }

        const finalOperator = updatedOperator || operator;

        // Build result message
        let resultMsg = formatAddOperatorResult(operatorId, finalOperator.inputPorts.length, finalOperator.outputPorts.length);
        if (createdLinkIds.length > 0) {
          resultMsg += `\nAuto-created links: [${createdLinkIds.join(", ")}]`;
        }

        return createToolResult(resultMsg);
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
      "The function name MUST be exactly 'load' or 'process'. " +
      "The new code must be of the same type as the existing operator. " +
      "For def process(): each parameter MUST match an existing operator's ID. " +
      "Links are automatically updated based on parameters.",
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to modify"),
      code: z.string().describe("New Python function code (must match the operator type - load() or process(...))"),
      summary: z.string().optional().describe("Brief summary of the behavior of this operator"),
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

        const { type: newType, numInputPorts, parameters } = parseResult;

        // Check type consistency
        const expectedType = isDataLoading ? "DataLoading" : "DataProcessing";
        if (newType !== expectedType) {
          return createErrorResult(
            `Code type mismatch. Operator ${operatorId} is a ${expectedType} operator, ` +
              `but the provided code is for ${newType}. ` +
              `Use a ${expectedType === "DataLoading" ? "load()" : "process(...)"} function.`
          );
        }

        // For process() functions: validate that all input parameters exist as operators
        const inputOperators: OperatorPredicate[] = [];
        if (isDataProcessing && parameters.length > 0) {
          const missingParams: string[] = [];
          for (const param of parameters) {
            const inputOp = findOperatorByName(workflowState, param);
            if (!inputOp) {
              missingParams.push(param);
            } else {
              inputOperators.push(inputOp);
            }
          }

          if (missingParams.length > 0) {
            return createErrorResult(
              `Input parameter(s) not found as operators: [${missingParams.join(", ")}]. ` +
              `Each parameter in def process(${parameters.join(", ")}) must reference an existing operator by its ID.`
            );
          }
        }

        // Validate Python syntax
        const syntaxError = await validatePythonSyntax(code);
        if (syntaxError) {
          return createErrorResult(`Python syntax error: ${syntaxError}`);
        }

        const beforeContent = workflowState.getWorkflowContent();

        // Update the code property
        workflowState.updateOperatorProperties(operatorId, { code });

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

        // Handle link updates for DataProcessing operators
        const deletedLinkIds: string[] = [];
        const createdLinkIds: string[] = [];

        if (isDataProcessing) {
          // Get current incoming links to this operator
          const currentLinks = workflowState.getLinksConnectedToOperator(operatorId)
            .filter(link => link.target.operatorID === operatorId);

          // Delete all existing incoming links
          for (const link of currentLinks) {
            workflowState.deleteLink(link.linkID);
            deletedLinkIds.push(link.linkID);
          }

          // Create new links based on parameters
          for (let i = 0; i < inputOperators.length; i++) {
            const sourceOp = inputOperators[i];
            const linkId = `${sourceOp.operatorID}-->${operatorId}`;

            const link: OperatorLink = {
              linkID: linkId,
              source: {
                operatorID: sourceOp.operatorID,
                portID: sourceOp.outputPorts[0]?.portID || "output-0",
              },
              target: {
                operatorID: operatorId,
                portID: `input-${i}`,
              },
            };

            workflowState.addLink(link);
            createdLinkIds.push(linkId);
          }
        }

        const afterContent = workflowState.getWorkflowContent();

        // Create agent action for tracking
        if (context?.agentActionManager && context.agentId) {
          context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            summary || `Modified code operator: ${operatorId}`,
            {
              modify: { operatorIds: [operatorId] },
              add: { operatorIds: [], linkIds: createdLinkIds },
              delete: { operatorIds: [], linkIds: deletedLinkIds },
            },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
        }

        // Build result message
        let resultMsg = formatModifyOperatorResult(operatorId);
        if (deletedLinkIds.length > 0) {
          resultMsg += `\nDeleted links: [${deletedLinkIds.join(", ")}]`;
        }
        if (createdLinkIds.length > 0) {
          resultMsg += `\nCreated links: [${createdLinkIds.join(", ")}]`;
        }

        return createToolResult(resultMsg);
      } catch (error: any) {
        return createErrorResult(formatOperatorError(args.operatorId, error.message || String(error)));
      }
    },
  });
}
