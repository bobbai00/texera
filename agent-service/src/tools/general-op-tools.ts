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
 * General operator tools for Texera Agent Service (GENERAL mode).
 * These tools work with any operator type using operator schemas.
 */

import { z } from "zod";
import { tool } from "ai";
import { WorkflowState } from "../workflow/workflow-state";
import { WorkflowUtilService } from "../workflow/workflow-util";
import {
  createToolResult,
  createErrorResult,
  formatAddOperatorResult,
  formatModifyOperatorResult,
  formatOperatorError,
} from "./tools-utility";
import { formatValidationErrors } from "./metadata-tools";
import type { ToolContext } from "./workflow-tools";

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_ADD_OPERATOR = "addOperator";
export const TOOL_NAME_MODIFY_OPERATOR = "modifyOperator";

// Operator type that supports dynamic input ports
const MULTI_INPUT_OPERATOR_TYPE = "DataProcessing";

// ============================================================================
// Port Validation
// ============================================================================

function validateNumInputPorts(numPorts: number): string | null {
  if (numPorts < 1) return "At least 1 input port is required";
  if (numPorts > 10) return "Maximum 10 input ports allowed";
  return null;
}

// ============================================================================
// Add Operator Tool
// ============================================================================

export function createAddOperatorTool(
  workflowState: WorkflowState,
  operatorSchemas: Map<string, any>,
  context?: ToolContext
) {
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore) : null;

  return tool({
    description:
      "Add a new operator to the workflow. Use getOperatorSchema first to understand required properties. " +
      `For ${MULTI_INPUT_OPERATOR_TYPE}, specify numInputPorts to create multiple input ports.`,
    inputSchema: z.object({
      operatorType: z.string().describe(`The operator type (e.g., '${MULTI_INPUT_OPERATOR_TYPE}', 'Aggregate')`),
      properties: z.record(z.any()).describe("Properties to set on the operator"),
      customDisplayName: z.string().describe("Optional display name for the operator"),
      numInputPorts: z
        .number()
        .optional()
        .describe(`Number of input ports for ${MULTI_INPUT_OPERATOR_TYPE} (default: 1).`),
    }),
    execute: async (args: {
      operatorType: string;
      properties?: Record<string, any>;
      customDisplayName?: string;
      numInputPorts?: number;
    }) => {
      try {
        const schemaEntry = operatorSchemas.get(args.operatorType);
        if (!schemaEntry) {
          return createErrorResult(
            `Unknown operator type: ${args.operatorType}. Use listAllAvailableOperatorTypes to see available operators.`
          );
        }

        // Validate numInputPorts if provided
        if (args.numInputPorts !== undefined) {
          if (args.operatorType !== MULTI_INPUT_OPERATOR_TYPE) {
            return createErrorResult(
              `numInputPorts is only supported for ${MULTI_INPUT_OPERATOR_TYPE}. ` +
                `Operator type "${args.operatorType}" does not support dynamic input ports.`
            );
          }
          const portError = validateNumInputPorts(args.numInputPorts);
          if (portError) return createErrorResult(portError);
        }

        // Validate properties
        if (context?.metadataStore && args.properties) {
          const validation = context.metadataStore.validateOperatorProperties(args.operatorType, args.properties);
          if (!validation.isValid) {
            return createErrorResult(
              `Invalid operator properties for "${args.operatorType}". ${formatValidationErrors(validation)}\n` +
                `Use getOperatorSchema("${args.operatorType}") to see the required property format.`
            );
          }
        }

        if (!workflowUtil) {
          return createErrorResult("Metadata store not available for operator creation");
        }

        const beforeContent = workflowState.getWorkflowContent();

        let operator = workflowUtil.getNewOperatorPredicate(args.operatorType, args.customDisplayName);
        if (args.properties) {
          operator = {
            ...operator,
            operatorProperties: { ...operator.operatorProperties, ...args.properties },
          };
        }

        workflowState.addOperator(operator);

        // Set up input ports for PythonTableUDF
        if (args.numInputPorts !== undefined && args.numInputPorts > 1) {
          workflowState.updateOperatorInputPorts(operator.operatorID, args.numInputPorts);
        }

        const updatedOperator = workflowState.getOperator(operator.operatorID);
        const afterContent = workflowState.getWorkflowContent();

        // Create agent action for tracking
        if (context?.agentActionManager && context.agentId) {
          context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            args.customDisplayName || `Added ${args.operatorType}`,
            { add: { operatorIds: [operator.operatorID], linkIds: [] } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
        }

        const finalOperator = updatedOperator || operator;
        const numInputPorts = finalOperator.inputPorts.length;
        const numOutputPorts = finalOperator.outputPorts.length;

        return createToolResult(formatAddOperatorResult(operator.operatorID, numInputPorts, numOutputPorts));
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}

// ============================================================================
// Modify Operator Tool
// ============================================================================

export function createModifyOperatorTool(workflowState: WorkflowState, context?: ToolContext) {
  return tool({
    description:
      "Modify properties of an existing operator. Use this to fix errors or change operator logic. " +
      `For ${MULTI_INPUT_OPERATOR_TYPE}, you can also update the number of input ports.`,
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to modify"),
      properties: z.record(z.any()).describe("Properties to update (merged with existing)"),
      summary: z.string().optional().describe("Brief summary of what this modification accomplishes"),
      numInputPorts: z.number().optional().describe(`New number of input ports for ${MULTI_INPUT_OPERATOR_TYPE}.`),
    }),
    execute: async (args: {
      operatorId: string;
      properties: Record<string, any>;
      summary?: string;
      numInputPorts?: number;
    }) => {
      try {
        const operator = workflowState.getOperator(args.operatorId);
        if (!operator) return createErrorResult(`Operator ${args.operatorId} not found`);

        const mergedProperties = { ...operator.operatorProperties, ...args.properties };

        // Validate properties
        if (context?.metadataStore) {
          const validation = context.metadataStore.validateOperatorProperties(operator.operatorType, mergedProperties);
          if (!validation.isValid) {
            return createErrorResult(
              `Invalid operator properties for "${operator.operatorType}". ${formatValidationErrors(validation)}\n` +
                `Use getOperatorSchema("${operator.operatorType}") to see the required property format.`
            );
          }
        }

        // Validate numInputPorts if provided
        if (args.numInputPorts !== undefined) {
          if (operator.operatorType !== MULTI_INPUT_OPERATOR_TYPE) {
            return createErrorResult(
              `numInputPorts is only supported for ${MULTI_INPUT_OPERATOR_TYPE}. ` +
                `Operator "${args.operatorId}" is of type "${operator.operatorType}".`
            );
          }
          const portError = validateNumInputPorts(args.numInputPorts);
          if (portError) return createErrorResult(portError);
        }

        const beforeContent = workflowState.getWorkflowContent();

        workflowState.updateOperatorProperties(args.operatorId, args.properties);

        if (args.numInputPorts !== undefined && args.numInputPorts > 0) {
          workflowState.updateOperatorInputPorts(args.operatorId, args.numInputPorts);
        }

        const afterContent = workflowState.getWorkflowContent();

        // Create agent action for tracking
        if (context?.agentActionManager && context.agentId) {
          context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            args.summary || `Modified ${operator.customDisplayName || operator.operatorType}`,
            { modify: { operatorIds: [args.operatorId] } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
        }

        return createToolResult(formatModifyOperatorResult(args.operatorId));
      } catch (error: any) {
        return createErrorResult(formatOperatorError(args.operatorId, error.message || String(error)));
      }
    },
  });
}
