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
 * Common workflow tools for Texera Agent Service.
 * These tools are shared across both CODE and GENERAL agent modes.
 */

import { z } from "zod";
import { tool } from "ai";
import type { WorkflowState } from "../workflow/workflow-state";
import { autoLayoutWorkflow } from "../workflow/auto-layout";
import type { OperatorLink } from "../types/workflow";
import {
  createToolResult,
  createErrorResult,
  formatOperator,
  formatLink,
  formatAddLinkResult,
} from "./tools-utility";
import type { OperatorMetadataStore } from "./metadata-tools";
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
    maxOperatorResultCharLimit?: number;
    toolTimeoutMs?: number;
    executionTimeoutMs?: number;
    autoExecuteOnChange?: boolean;
  };
  /**
   * Execute a specific operator and return formatted result.
   * Available when execution is configured for the agent.
   * @param operatorId - The operator to execute
   * @returns Formatted result string or null if execution is not available
   */
  executeOperator?: (operatorId: string) => Promise<string>;
}

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_GET_CURRENT_WORKFLOW = "getCurrentWorkflow";
export const TOOL_NAME_ADD_LINK = "addLink";
export const TOOL_NAME_DELETE_LINK = "deleteLink";
export const TOOL_NAME_DELETE_OPERATOR = "deleteOperator";

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

        const sections: string[] = [];

        // Format operators section
        if (operators.length > 0) {
          const operatorLines = ["Operators:"];
          for (const op of operators) {
            operatorLines.push(formatOperator(op));
          }
          sections.push(operatorLines.join("\n"));
        }

        // Format links section
        if (links.length > 0) {
          const linkLines = ["Links:"];
          for (const link of links) {
            linkLines.push(formatLink(link));
          }
          sections.push(linkLines.join("\n"));
        }

        if (sections.length === 0) {
          return createToolResult("Workflow is empty");
        }

        return createToolResult(sections.join("\n\n"));
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
    description: "Add a link connecting two operators's ports",
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

        const linkId = workflowState.generateLinkId();
        const link: OperatorLink = {
          linkID: linkId,
          source: { operatorID: args.sourceOperatorId, portID: sourcePortId },
          target: { operatorID: args.targetOperatorId, portID: targetPortId },
        };

        workflowState.addLink(link);

        // Auto-layout the workflow after adding the link
        autoLayoutWorkflow(workflowState);

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

        return createToolResult(formatAddLinkResult(linkId));
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}

// ============================================================================
// Delete Link Tool
// ============================================================================

export function createDeleteLinkTool(workflowState: WorkflowState, context?: ToolContext) {
  return tool({
    description: "Delete a link from the workflow.",
    inputSchema: z.object({
      linkId: z.string().describe("ID of the link to delete"),
      summary: z.string().optional().describe("Brief summary of what this deletion accomplishes"),
    }),
    execute: async (args: { linkId: string; summary?: string }) => {
      try {
        const beforeContent = workflowState.getWorkflowContent();

        const deleted = workflowState.deleteLink(args.linkId);
        if (!deleted) {
          return createErrorResult(`Link ${args.linkId} not found`);
        }

        const afterContent = workflowState.getWorkflowContent();

        // Create agent action for tracking
        if (context?.agentActionManager && context.agentId) {
          context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            args.summary || `Deleted link ${args.linkId}`,
            { delete: { operatorIds: [], linkIds: [args.linkId] } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
        }

        return createToolResult(`Deleted link: ${args.linkId}`);
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}

// ============================================================================
// Delete Operator Tool
// ============================================================================

export function createDeleteOperatorTool(workflowState: WorkflowState, context?: ToolContext) {
  return tool({
    description: "Delete an operator from the workflow. This also deletes all connected links.",
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to delete"),
      summary: z.string().optional().describe("Brief summary of what this deletion accomplishes"),
    }),
    execute: async (args: { operatorId: string; summary?: string }) => {
      try {
        const beforeContent = workflowState.getWorkflowContent();

        const deleted = workflowState.deleteOperator(args.operatorId);
        if (!deleted) {
          return createErrorResult(`Operator ${args.operatorId} not found`);
        }

        const afterContent = workflowState.getWorkflowContent();

        // Create agent action for tracking
        if (context?.agentActionManager && context.agentId) {
          context.agentActionManager.createAgentAction(
            context.agentId,
            context.agentName || `Agent-${context.agentId}`,
            args.summary || `Deleted operator ${args.operatorId}`,
            { delete: { operatorIds: [args.operatorId], linkIds: [] } },
            context.workflowMetadata || {},
            beforeContent,
            afterContent
          );
        }

        return createToolResult(`Deleted operator: ${args.operatorId}`);
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}
