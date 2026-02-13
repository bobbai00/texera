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
import { autoLayoutWorkflow } from "../workflow/auto-layout";
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

// ============================================================================
// Add Operator Tool
// ============================================================================

export function createAddOperatorTool(
  workflowState: WorkflowState,
  operatorSchemas: Map<string, any>,
  context?: ToolContext
) {
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore, workflowState) : null;

  return tool({
    description:
      "Add a new operator to the workflow. Use getOperatorSchema first to understand required properties.",
    inputSchema: z.object({
      operatorId: z.string().describe("Unique operator ID"),
      operatorType: z.string().describe("The operator type (e.g., 'DataProcessing', 'Aggregate')"),
      properties: z.record(z.any()).describe("Properties to set on the operator"),
      summary: z.string().optional().describe("Brief summary of operator behavior"),
    }),
    execute: async (args: {
      operatorId: string;
      operatorType: string;
      properties?: Record<string, any>;
      summary?: string;
    }) => {
      try {
        const schemaEntry = operatorSchemas.get(args.operatorType);
        if (!schemaEntry) {
          return createErrorResult(
            `Unknown operator type: ${args.operatorType}. Use listAllAvailableOperatorTypes to see available operators.`
          );
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

        // Check for duplicate operatorId
        const existing = workflowState.getOperator(args.operatorId);
        if (existing) {
          return createErrorResult(
            `Operator with ID "${args.operatorId}" already exists. Use modifyOperator to update it, or choose a different ID.`
          );
        }

        const beforeContent = workflowState.getWorkflowContent();

        let operator = workflowUtil.getNewOperatorPredicate(args.operatorType, args.summary);
        operator = {
          ...operator,
          operatorID: args.operatorId,
          operatorProperties: { ...operator.operatorProperties, ...args.properties },
        };

        workflowState.addOperator(operator);

        // Auto-layout the workflow after adding the operator
        autoLayoutWorkflow(workflowState);

        const updatedOperator = workflowState.getOperator(operator.operatorID);
        const afterContent = workflowState.getWorkflowContent();

        // Create agent action for tracking
        if (context?.agentActionManager && context.agentId) {
          context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            args.summary || `Added ${args.operatorType}`,
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
      "Modify properties of an existing operator. Use this to fix errors or change operator logic.",
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to modify"),
      properties: z.record(z.any()).describe("Properties to update (merged with existing)"),
      summary: z.string().optional().describe("Brief summary of operator behavior"),
    }),
    execute: async (args: {
      operatorId: string;
      properties: Record<string, any>;
      summary?: string;
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

        const beforeContent = workflowState.getWorkflowContent();

        workflowState.updateOperatorProperties(args.operatorId, args.properties);

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
