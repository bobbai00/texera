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
import { generateLinkId } from "../workflow/workflow-state";
import { WorkflowUtilService } from "../workflow/workflow-util";
import type { OperatorLink, OperatorDetail, OperatorPredicate } from "../types/workflow";
import { createSuccessResult, createErrorResult } from "./tools-utility";
import { type OperatorMetadataStore, formatValidationErrors } from "./metadata-tools";
import type { AgentActionManager } from "../agent/agent-action-manager";

// ============================================================================
// Types for tool context
// ============================================================================

export interface ToolContext {
  metadataStore?: OperatorMetadataStore;
  agentActionManager?: AgentActionManager;
  agentId?: string;
  agentName?: string;
  workflowMetadata?: { wid?: number; name?: string };
  /** Agent settings for tool execution */
  settings?: {
    /** Maximum token limit for operator results */
    maxOperatorResultTokenLimit?: number;
    /** Tool execution timeout in milliseconds */
    toolTimeoutMs?: number;
    /** Workflow execution timeout in milliseconds */
    executionTimeoutMs?: number;
  };
}

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_GET_CURRENT_WORKFLOW = "getCurrentWorkflow";
export const TOOL_NAME_ADD_OPERATOR = "addOperator";
export const TOOL_NAME_ADD_LINK = "addLink";
export const TOOL_NAME_MODIFY_OPERATOR = "modifyOperator";
export const TOOL_NAME_DELETE_FROM_WORKFLOW = "deleteFromWorkflow";

// Operator type that supports dynamic input ports
const MULTI_INPUT_OPERATOR_TYPE = "PythonTableUDF";

// ============================================================================
// Port Validation
// ============================================================================

/**
 * Validate number of input ports.
 * Returns error message if invalid, null if valid.
 */
function validateNumInputPorts(numPorts: number): string | null {
  if (numPorts < 1) {
    return "At least 1 input port is required";
  }
  if (numPorts > 10) {
    return "Maximum 10 input ports allowed";
  }
  return null;
}

// ============================================================================
// Get Current Workflow Tool
// ============================================================================

/**
 * Create tool to get the current workflow structure.
 * Compiles the workflow to get fresh schema information.
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
            .map(operatorId => {
              const operator = workflowState.getOperator(operatorId);
              if (!operator) return null;

              const detail: OperatorDetail = {
                operatorId: operator.operatorID,
                operatorType: operator.operatorType,
                operatorProperties: operator.operatorProperties,
                inputPorts: operator.inputPorts,
                outputPorts: operator.outputPorts,
              };
              if (operator.customDisplayName) {
                detail.customDisplayName = operator.customDisplayName;
              }
              return detail;
            })
            .filter((op): op is OperatorDetail => op !== null);
        } else {
          operatorsToReturn = workflowState.getAllEnabledOperators().map(operator => {
            const detail: OperatorDetail = {
              operatorId: operator.operatorID,
              operatorType: operator.operatorType,
              operatorProperties: operator.operatorProperties,
              inputPorts: operator.inputPorts,
              outputPorts: operator.outputPorts,
            };
            if (operator.customDisplayName) {
              detail.customDisplayName = operator.customDisplayName;
            }
            return detail;
          });
        }

        const operatorIds = operatorsToReturn.map(op => op.operatorId);

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
        .describe(
          `Number of input ports for ${MULTI_INPUT_OPERATOR_TYPE} (default: 1). `
        ),
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
          if (portError) {
            return createErrorResult(portError);
          }
        }

        if (context?.metadataStore && args.properties) {
          const validation = context.metadataStore.validateOperatorProperties(args.operatorType, args.properties);
          if (!validation.isValid) {
            return createErrorResult(
              `Invalid operator properties for "${args.operatorType}". ${formatValidationErrors(validation)}\n` +
                `Use getOperatorSchema("${args.operatorType}") to see the required property format.`
            );
          }
        }

        const beforeContent = workflowState.getWorkflowContent();

        if (!workflowUtil) {
          return createErrorResult("Metadata store not available for operator creation");
        }

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

        // Get the updated operator (may have modified ports)
        const updatedOperator = workflowState.getOperator(operator.operatorID);

        const afterContent = workflowState.getWorkflowContent();
        let agentActionId: string | undefined;

        if (context?.agentActionManager && context.agentId) {
          const agentAction = context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            args.customDisplayName || `Added ${args.operatorType}`,
            { add: { operatorIds: [operator.operatorID], linkIds: [] } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
          agentActionId = agentAction.id;
        }

        return createSuccessResult(
          {
            operatorId: operator.operatorID,
            operatorType: args.operatorType,
            inputPorts: updatedOperator?.inputPorts || operator.inputPorts,
            outputPorts: updatedOperator?.outputPorts || operator.outputPorts,
            agentActionId,
            message: `Added operator ${operator.operatorID} of type ${args.operatorType}`,
          },
          [],
          [operator.operatorID],
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
export function createAddLinkTool(workflowState: WorkflowState, context?: ToolContext) {
  return tool({
    description:
      "Add a link connecting two operators. Use targetPortIndex for PythonTableUDF with multiple input ports.",
    inputSchema: z.object({
      sourceOperatorId: z.string().describe("ID of the source operator"),
      sourcePortId: z.string().optional().describe("Source port ID (default: 'output-0')"),
      targetOperatorId: z.string().describe("ID of the target operator"),
      targetPortIndex: z
        .number()
        .optional()
        .describe(
          "Target port index (0-based). For PythonTableUDF with multiple inputs, specify which port to connect to. " +
            "The index corresponds to INPUT_PORTS order in Python code. Defaults to 0."
        ),
    }),
    execute: async (args: {
      sourceOperatorId: string;
      sourcePortId?: string;
      targetOperatorId: string;
      targetPortIndex?: number;
    }) => {
      try {
        const sourceOp = workflowState.getOperator(args.sourceOperatorId);
        const targetOp = workflowState.getOperator(args.targetOperatorId);

        if (!sourceOp) {
          return createErrorResult(`Source operator ${args.sourceOperatorId} not found`);
        }
        if (!targetOp) {
          return createErrorResult(`Target operator ${args.targetOperatorId} not found`);
        }

        // Resolve target port ID from index or default
        const portIndex = args.targetPortIndex ?? 0;
        let targetPortId: string;
        if (portIndex >= 0 && portIndex < targetOp.inputPorts.length) {
          targetPortId = targetOp.inputPorts[portIndex].portID;
        } else if (portIndex === 0) {
          // Default to input-0 if no ports defined yet
          targetPortId = "input-0";
        } else {
          return createErrorResult(
            `Port index ${portIndex} out of range. Target operator has ${targetOp.inputPorts.length} input port(s).`
          );
        }

        const beforeContent = workflowState.getWorkflowContent();

        const linkId = generateLinkId();
        const link: OperatorLink = {
          linkID: linkId,
          source: { operatorID: args.sourceOperatorId, portID: args.sourcePortId || "output-0" },
          target: { operatorID: args.targetOperatorId, portID: targetPortId },
        };

        workflowState.addLink(link);

        const afterContent = workflowState.getWorkflowContent();
        let agentActionId: string | undefined;

        if (context?.agentActionManager && context.agentId) {
          const agentAction = context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            `Link ${args.sourceOperatorId} to ${args.targetOperatorId}`,
            { add: { operatorIds: [], linkIds: [linkId] } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
          agentActionId = agentAction.id;
        }

        return createSuccessResult(
          {
            linkId,
            agentActionId,
            source: link.source,
            target: link.target,
            message: `Added link from ${args.sourceOperatorId} to ${args.targetOperatorId} (port: ${targetPortId})`,
          },
          [args.sourceOperatorId, args.targetOperatorId],
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
export function createModifyOperatorTool(workflowState: WorkflowState, context?: ToolContext) {
  return tool({
    description:
      "Modify properties of an existing operator. If operator has error during its execution or needs logic change, please use this method to modify the operator" +
      `For ${MULTI_INPUT_OPERATOR_TYPE}, you can also update the number of input ports.`,
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to modify"),
      properties: z.record(z.any()).describe("Properties to update (merged with existing)"),
      summary: z.string().optional().describe("Brief summary of what this modification accomplishes"),
      numInputPorts: z
        .number()
        .optional()
        .describe(
          `New number of input ports for ${MULTI_INPUT_OPERATOR_TYPE}. `
        ),
    }),
    execute: async (args: {
      operatorId: string;
      properties: Record<string, any>;
      summary?: string;
      numInputPorts?: number;
    }) => {
      try {
        const operator = workflowState.getOperator(args.operatorId);
        if (!operator) {
          return createErrorResult(`Operator ${args.operatorId} not found`);
        }

        const mergedProperties = { ...operator.operatorProperties, ...args.properties };

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
          if (portError) {
            return createErrorResult(portError);
          }
        }

        const beforeContent = workflowState.getWorkflowContent();

        workflowState.updateOperatorProperties(args.operatorId, args.properties);

        if (args.numInputPorts !== undefined && args.numInputPorts > 0) {
          workflowState.updateOperatorInputPorts(args.operatorId, args.numInputPorts);
        }

        // Get the updated operator (may have modified ports)
        const updatedOperator = workflowState.getOperator(args.operatorId);

        const afterContent = workflowState.getWorkflowContent();
        let agentActionId: string | undefined;

        if (context?.agentActionManager && context.agentId) {
          const agentAction = context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            args.summary || `Modified ${operator.customDisplayName || operator.operatorType}`,
            { modify: { operatorIds: [args.operatorId] } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
          agentActionId = agentAction.id;
        }

        return createSuccessResult(
          {
            operatorId: args.operatorId,
            inputPorts: updatedOperator?.inputPorts || operator.inputPorts,
            outputPorts: updatedOperator?.outputPorts || operator.outputPorts,
            agentActionId,
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
export function createDeleteFromWorkflowTool(workflowState: WorkflowState, context?: ToolContext) {
  return tool({
    description: "Delete operators and/or links from the workflow.",
    inputSchema: z.object({
      operatorIds: z.array(z.string()).optional().describe("List of operator IDs to delete"),
      linkIds: z.array(z.string()).optional().describe("List of link IDs to delete"),
      summary: z.string().optional().describe("Optional brief summary of what this deletion accomplishes"),
    }),
    execute: async (args: { operatorIds?: string[]; linkIds?: string[]; summary?: string }) => {
      try {
        // Capture before state
        const beforeContent = workflowState.getWorkflowContent();

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

        // Capture after state and create agent action if manager is provided
        const afterContent = workflowState.getWorkflowContent();
        let agentActionId: string | undefined;

        if (
          context?.agentActionManager &&
          context.agentId &&
          (deletedOperatorIds.length > 0 || deletedLinkIds.length > 0)
        ) {
          const agentAction = context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            args.summary || `Deleted ${deletedOperatorIds.length} operator(s) and ${deletedLinkIds.length} link(s)`,
            { delete: { operatorIds: deletedOperatorIds, linkIds: deletedLinkIds } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
          agentActionId = agentAction.id;
        }

        return createSuccessResult(
          {
            deletedOperatorIds,
            deletedLinkIds,
            agentActionId,
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
