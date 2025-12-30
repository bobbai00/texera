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
import type { OperatorLink } from "../types/workflow";
import { createToolResult, createErrorResult } from "./tools-utility";
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
  settings?: {
    maxOperatorResultTokenLimit?: number;
    toolTimeoutMs?: number;
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
// Helper: Extract port IDs from port objects
// ============================================================================

function extractPortIds(ports: Array<{ portID: string; [key: string]: any }>): string[] {
  return ports.map(p => p.portID);
}

// ============================================================================
// Get Current Workflow Tool
// ============================================================================

export function createGetCurrentWorkflowTool(workflowState: WorkflowState) {
  return tool({
    description:
      "Get the current workflow structure including operators and links. " +
      "Returns a list of operators (with id, type, name, properties, input/output ports) and links.",
    inputSchema: z.object({
      operatorIds: z
        .array(z.string())
        .optional()
        .describe("Optional list of operator IDs to retrieve. If empty, returns all enabled operators."),
    }),
    execute: async (args: { operatorIds?: string[] }) => {
      try {
        const links = workflowState.getAllLinks();
        const allOperators = workflowState.getAllEnabledOperators();

        // Filter operators if specific IDs requested
        const operators =
          args.operatorIds && args.operatorIds.length > 0
            ? allOperators.filter(op => args.operatorIds!.includes(op.operatorID))
            : allOperators;

        // Format as a readable string
        const lines: string[] = [`Retrieved ${operators.length} operator(s) and ${links.length} link(s).`];
        lines.push("");

        if (operators.length > 0) {
          lines.push("Operators:");
          for (const op of operators) {
            const name = op.customDisplayName ? ` (${op.customDisplayName})` : "";
            lines.push(`  - ${op.operatorID}${name}: ${op.operatorType}`);
            lines.push(`    inputPorts: [${extractPortIds(op.inputPorts).join(", ")}]`);
            lines.push(`    outputPorts: [${extractPortIds(op.outputPorts).join(", ")}]`);
            lines.push(`    properties: ${JSON.stringify(op.operatorProperties)}`);
          }
        }

        if (links.length > 0) {
          lines.push("");
          lines.push("Links:");
          for (const link of links) {
            lines.push(`  - ${link.linkID}: ${link.source.operatorID}:${link.source.portID} -> ${link.target.operatorID}:${link.target.portID}`);
          }
        }

        return createToolResult(lines.join("\n"));
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
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

        const inputPorts = extractPortIds(updatedOperator?.inputPorts || operator.inputPorts);
        const outputPorts = extractPortIds(updatedOperator?.outputPorts || operator.outputPorts);

        const lines = [
          `Added operator ${operator.operatorID} of type ${args.operatorType}`,
          `  inputPorts: [${inputPorts.join(", ")}]`,
          `  outputPorts: [${outputPorts.join(", ")}]`,
        ];

        return createToolResult(lines.join("\n"));
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}

// ============================================================================
// Add Link Tool
// ============================================================================

export function createAddLinkTool(workflowState: WorkflowState, context?: ToolContext) {
  return tool({
    description:
      "Add a link connecting two operators's ports",
    inputSchema: z.object({
      sourceOperatorId: z.string().describe("ID of the source operator"),
      sourcePortIndex: z.number().default(0).describe("Source port index (0-based). Defaults to 0."),
      targetOperatorId: z.string().describe("ID of the target operator"),
      targetPortIndex: z.number().default(0).describe("Target port index (0-based). Defaults to 0."),
    }),
    execute: async (args: {
      sourceOperatorId: string;
      sourcePortIndex?: number;
      targetOperatorId: string;
      targetPortIndex?: number;
    }) => {
      try {
        const sourceOp = workflowState.getOperator(args.sourceOperatorId);
        const targetOp = workflowState.getOperator(args.targetOperatorId);

        if (!sourceOp) return createErrorResult(`Source operator ${args.sourceOperatorId} not found`);
        if (!targetOp) return createErrorResult(`Target operator ${args.targetOperatorId} not found`);

        // Resolve source port ID from index
        const sourcePortIdx = args.sourcePortIndex ?? 0;
        let sourcePortId: string;
        if (sourcePortIdx >= 0 && sourcePortIdx < sourceOp.outputPorts.length) {
          sourcePortId = sourceOp.outputPorts[sourcePortIdx].portID;
        } else if (sourcePortIdx === 0) {
          sourcePortId = "output-0";
        } else {
          return createErrorResult(
            `Source port index ${sourcePortIdx} out of range. Source operator has ${sourceOp.outputPorts.length} output port(s).`
          );
        }

        // Resolve target port ID from index
        const targetPortIdx = args.targetPortIndex ?? 0;
        let targetPortId: string;
        if (targetPortIdx >= 0 && targetPortIdx < targetOp.inputPorts.length) {
          targetPortId = targetOp.inputPorts[targetPortIdx].portID;
        } else if (targetPortIdx === 0) {
          targetPortId = "input-0";
        } else {
          return createErrorResult(
            `Target port index ${targetPortIdx} out of range. Target operator has ${targetOp.inputPorts.length} input port(s).`
          );
        }

        const beforeContent = workflowState.getWorkflowContent();

        const linkId = generateLinkId();
        const link: OperatorLink = {
          linkID: linkId,
          source: { operatorID: args.sourceOperatorId, portID: sourcePortId },
          target: { operatorID: args.targetOperatorId, portID: targetPortId },
        };

        workflowState.addLink(link);

        const afterContent = workflowState.getWorkflowContent();

        // Create agent action for tracking
        if (context?.agentActionManager && context.agentId) {
          context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            `Link ${args.sourceOperatorId} to ${args.targetOperatorId}`,
            { add: { operatorIds: [], linkIds: [linkId] } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
        }

        return createToolResult(`Added link: ${args.sourceOperatorId}:${sourcePortId} -> ${args.targetOperatorId}:${targetPortId} (linkId: ${linkId})`);
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

        return createToolResult(`Modified operator ${args.operatorId} (${operator.operatorType})`);
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}

// ============================================================================
// Delete From Workflow Tool
// ============================================================================

export function createDeleteFromWorkflowTool(workflowState: WorkflowState, context?: ToolContext) {
  return tool({
    description: "Delete operators and/or links from the workflow.",
    inputSchema: z.object({
      operatorIds: z.array(z.string()).optional().describe("List of operator IDs to delete"),
      linkIds: z.array(z.string()).optional().describe("List of link IDs to delete"),
      summary: z.string().optional().describe("Brief summary of what this deletion accomplishes"),
    }),
    execute: async (args: { operatorIds?: string[]; linkIds?: string[]; summary?: string }) => {
      try {
        const beforeContent = workflowState.getWorkflowContent();

        const deletedOperatorIds: string[] = [];
        const deletedLinkIds: string[] = [];

        // Delete operators (also deletes connected links)
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

        const afterContent = workflowState.getWorkflowContent();

        // Create agent action for tracking
        if (
          context?.agentActionManager &&
          context.agentId &&
          (deletedOperatorIds.length > 0 || deletedLinkIds.length > 0)
        ) {
          context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            args.summary || `Deleted ${deletedOperatorIds.length} operator(s) and ${deletedLinkIds.length} link(s)`,
            { delete: { operatorIds: deletedOperatorIds, linkIds: deletedLinkIds } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
        }

        const lines = [`Deleted ${deletedOperatorIds.length} operator(s) and ${deletedLinkIds.length} link(s).`];
        if (deletedOperatorIds.length > 0) {
          lines.push(`  operators: [${deletedOperatorIds.join(", ")}]`);
        }
        if (deletedLinkIds.length > 0) {
          lines.push(`  links: [${deletedLinkIds.join(", ")}]`);
        }

        return createToolResult(lines.join("\n"));
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}
