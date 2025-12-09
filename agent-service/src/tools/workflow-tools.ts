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
 * Workflow manipulation tools for Texera Agent Service.
 */

import { z } from "zod";
import { tool } from "ai";
import type { WorkflowState } from "../workflow/workflow-state";
import { generateOperatorId, generateLinkId } from "../workflow/workflow-state";
import type { OperatorPredicate, OperatorLink, OperatorDetail } from "../types/workflow";
import { createSuccessResult, createErrorResult } from "./tools-utility";

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_GET_CURRENT_WORKFLOW = "getCurrentWorkflow";
export const TOOL_NAME_ADD_OPERATOR = "addOperator";
export const TOOL_NAME_ADD_LINK = "addLink";
export const TOOL_NAME_MODIFY_OPERATOR = "modifyOperator";
export const TOOL_NAME_DELETE_FROM_WORKFLOW = "deleteFromWorkflow";

// ============================================================================
// Get Current Workflow Tool
// ============================================================================

/**
 * Create tool to get the current workflow structure.
 */
export function createGetCurrentWorkflowTool(workflowState: WorkflowState) {
  return tool({
    description:
      "Get the current workflow structure including operators and links. " +
      "Returns a list of operators (with id, type, name, properties, input/output schemas) and a list of links. " +
      "Optionally filter to specific operator IDs. If no operatorIds provided, returns all enabled operators.",
    inputSchema: z.object({
      operatorIds: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of operator IDs to retrieve. If empty or not provided, returns all enabled operators."
        ),
    }),
    execute: async (args: { operatorIds?: string[] }) => {
      try {
        const links = workflowState.getAllLinks();
        let operatorsToReturn: OperatorDetail[];

        if (args.operatorIds && args.operatorIds.length > 0) {
          operatorsToReturn = args.operatorIds
            .map((operatorId) => {
              const operator = workflowState.getOperator(operatorId);
              if (!operator) return null;

              const detail: OperatorDetail = {
                operatorId: operator.operatorID,
                operatorType: operator.operatorType,
                operatorProperties: operator.operatorProperties,
                inputSchema: workflowState.getOperatorInputSchema(operatorId) || {},
                outputSchema: workflowState.getOperatorOutputSchema(operatorId) || {},
              };
              if (operator.customDisplayName) {
                detail.customDisplayName = operator.customDisplayName;
              }
              return detail;
            })
            .filter((op): op is OperatorDetail => op !== null);
        } else {
          operatorsToReturn = workflowState.getAllEnabledOperators().map((operator) => {
            const detail: OperatorDetail = {
              operatorId: operator.operatorID,
              operatorType: operator.operatorType,
              operatorProperties: operator.operatorProperties,
              inputSchema: workflowState.getOperatorInputSchema(operator.operatorID) || {},
              outputSchema: workflowState.getOperatorOutputSchema(operator.operatorID) || {},
            };
            if (operator.customDisplayName) {
              detail.customDisplayName = operator.customDisplayName;
            }
            return detail;
          });
        }

        const operatorIds = operatorsToReturn.map((op) => op.operatorId);

        return createSuccessResult(
          {
            operators: operatorsToReturn,
            links,
            summary: {
              operatorCount: operatorsToReturn.length,
              linkCount: links.length,
            },
            message: `Retrieved ${operatorsToReturn.length} operator(s) and ${links.length} link(s).`,
          },
          operatorIds,
          [],
          []
        );
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}

// ============================================================================
// Add Operator Tool
// ============================================================================

/**
 * Create tool to add a new operator to the workflow.
 */
export function createAddOperatorTool(
  workflowState: WorkflowState,
  operatorSchemas: Map<string, any>
) {
  return tool({
    description:
      "Add a new operator to the workflow. Specify the operator type and its properties. " +
      "Use getOperatorSchema first to understand what properties are required.",
    inputSchema: z.object({
      operatorType: z.string().describe("The type of operator to add (e.g., 'PythonUDFV2', 'Aggregate')"),
      properties: z.record(z.any()).optional().describe("Properties to set on the operator"),
      customDisplayName: z.string().optional().describe("Optional custom display name for the operator"),
    }),
    execute: async (args: { operatorType: string; properties?: Record<string, any>; customDisplayName?: string }) => {
      try {
        // Get schema for this operator type
        // Schema entry contains { jsonSchema, additionalMetadata }
        const schemaEntry = operatorSchemas.get(args.operatorType);
        if (!schemaEntry) {
          return createErrorResult(`Unknown operator type: ${args.operatorType}`);
        }

        const operatorId = generateOperatorId();
        const { additionalMetadata } = schemaEntry;

        // Build input/output ports from additionalMetadata
        const inputPorts = additionalMetadata?.inputPorts?.map((port: any, idx: number) => ({
          portID: `input${idx}`,
          displayName: port.displayName || `Input ${idx}`,
          allowMultiInputs: port.allowMultiInputs || false,
        })) || [];

        const outputPorts = additionalMetadata?.outputPorts?.map((port: any, idx: number) => ({
          portID: `output${idx}`,
          displayName: port.displayName || `Output ${idx}`,
        })) || [];

        const operator: OperatorPredicate = {
          operatorID: operatorId,
          operatorType: args.operatorType,
          operatorVersion: "1",
          operatorProperties: args.properties || {},
          inputPorts,
          outputPorts,
          showAdvanced: false,
          isDisabled: false,
          customDisplayName: args.customDisplayName,
        };

        workflowState.addOperator(operator);

        return createSuccessResult(
          {
            operatorId,
            operatorType: args.operatorType,
            message: `Added operator ${operatorId} of type ${args.operatorType}`,
          },
          [],
          [operatorId],
          []
        );
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}

// ============================================================================
// Add Link Tool
// ============================================================================

/**
 * Create tool to add a link between two operators.
 */
export function createAddLinkTool(workflowState: WorkflowState) {
  return tool({
    description:
      "Add a link connecting two operators in the workflow. " +
      "Specify source operator/port and target operator/port.",
    inputSchema: z.object({
      sourceOperatorId: z.string().describe("ID of the source operator"),
      sourcePortId: z.string().optional().describe("ID of the source port (default: 'output0')"),
      targetOperatorId: z.string().describe("ID of the target operator"),
      targetPortId: z.string().optional().describe("ID of the target port (default: 'input0')"),
    }),
    execute: async (args: {
      sourceOperatorId: string;
      sourcePortId?: string;
      targetOperatorId: string;
      targetPortId?: string;
    }) => {
      try {
        // Validate operators exist
        const sourceOp = workflowState.getOperator(args.sourceOperatorId);
        const targetOp = workflowState.getOperator(args.targetOperatorId);

        if (!sourceOp) {
          return createErrorResult(`Source operator ${args.sourceOperatorId} not found`);
        }
        if (!targetOp) {
          return createErrorResult(`Target operator ${args.targetOperatorId} not found`);
        }

        const linkId = generateLinkId();
        const link: OperatorLink = {
          linkID: linkId,
          source: {
            operatorID: args.sourceOperatorId,
            portID: args.sourcePortId || "output0",
          },
          target: {
            operatorID: args.targetOperatorId,
            portID: args.targetPortId || "input0",
          },
        };

        workflowState.addLink(link);

        return createSuccessResult(
          {
            linkId,
            source: link.source,
            target: link.target,
            message: `Added link from ${args.sourceOperatorId} to ${args.targetOperatorId}`,
          },
          [],
          [],
          []
        );
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}

// ============================================================================
// Modify Operator Tool
// ============================================================================

/**
 * Create tool to modify an existing operator's properties.
 */
export function createModifyOperatorTool(workflowState: WorkflowState) {
  return tool({
    description:
      "Modify properties of an existing operator in the workflow. " +
      "Use getCurrentWorkflow first to see current operator properties.",
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to modify"),
      properties: z.record(z.any()).describe("Properties to update (merged with existing)"),
    }),
    execute: async (args: { operatorId: string; properties: Record<string, any> }) => {
      try {
        const operator = workflowState.getOperator(args.operatorId);
        if (!operator) {
          return createErrorResult(`Operator ${args.operatorId} not found`);
        }

        workflowState.updateOperatorProperties(args.operatorId, args.properties);

        return createSuccessResult(
          {
            operatorId: args.operatorId,
            updatedProperties: args.properties,
            message: `Modified operator ${args.operatorId}`,
          },
          [],
          [],
          [args.operatorId]
        );
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}

// ============================================================================
// Delete From Workflow Tool
// ============================================================================

/**
 * Create tool to delete operators and/or links from the workflow.
 */
export function createDeleteFromWorkflowTool(workflowState: WorkflowState) {
  return tool({
    description: "Delete operators and/or links from the workflow.",
    inputSchema: z.object({
      operatorIds: z.array(z.string()).optional().describe("List of operator IDs to delete"),
      linkIds: z.array(z.string()).optional().describe("List of link IDs to delete"),
    }),
    execute: async (args: { operatorIds?: string[]; linkIds?: string[] }) => {
      try {
        const deletedOperatorIds: string[] = [];
        const deletedLinkIds: string[] = [];

        // Delete operators (this also deletes connected links)
        if (args.operatorIds) {
          for (const operatorId of args.operatorIds) {
            if (workflowState.deleteOperator(operatorId)) {
              deletedOperatorIds.push(operatorId);
            }
          }
        }

        // Delete specific links
        if (args.linkIds) {
          for (const linkId of args.linkIds) {
            if (workflowState.deleteLink(linkId)) {
              deletedLinkIds.push(linkId);
            }
          }
        }

        return createSuccessResult(
          {
            deletedOperatorIds,
            deletedLinkIds,
            message: `Deleted ${deletedOperatorIds.length} operator(s) and ${deletedLinkIds.length} link(s)`,
          },
          [],
          [],
          []
        );
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}
