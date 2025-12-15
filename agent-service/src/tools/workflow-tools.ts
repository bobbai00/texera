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
import { WorkflowUtilService, extractOperatorInputPortSchemaMap } from "../workflow/workflow-util";
import type { OperatorLink, OperatorDetail, OperatorPortSchemaMap } from "../types/workflow";
import { createSuccessResult, createErrorResult } from "./tools-utility";
import { type OperatorMetadataStore, formatValidationErrors } from "./metadata-tools";
import type { AgentActionManager } from "../agent/agent-action-manager";
import { compileWorkflowAsync, type WorkflowCompilationResponse } from "../api/compile-api";

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
// Helper: Compile workflow and extract schemas
// ============================================================================

/**
 * Compile the workflow and return operator schemas.
 * Returns maps of operatorId -> inputSchema and operatorId -> outputSchema.
 */
async function compileAndGetSchemas(workflowState: WorkflowState): Promise<{
  inputSchemas: Map<string, OperatorPortSchemaMap>;
  outputSchemas: Map<string, OperatorPortSchemaMap>;
  compilationResponse: WorkflowCompilationResponse | null;
}> {
  const inputSchemas = new Map<string, OperatorPortSchemaMap>();
  const outputSchemas = new Map<string, OperatorPortSchemaMap>();

  const logicalPlan = workflowState.toLogicalPlan();
  if (logicalPlan.operators.length === 0) {
    return { inputSchemas, outputSchemas, compilationResponse: null };
  }

  const response = await compileWorkflowAsync(logicalPlan);
  if (!response || !response.operatorOutputSchemas) {
    return { inputSchemas, outputSchemas, compilationResponse: response };
  }

  // Store output schemas
  for (const [operatorId, portSchemaMap] of Object.entries(response.operatorOutputSchemas)) {
    outputSchemas.set(operatorId, portSchemaMap);
  }

  // Derive input schemas from output schemas based on links
  const links = workflowState.getAllLinks();
  for (const operator of workflowState.getAllOperators()) {
    const inputSchema = extractOperatorInputPortSchemaMap(
      operator.operatorID,
      operator,
      response.operatorOutputSchemas,
      links
    );
    if (inputSchema) {
      inputSchemas.set(operator.operatorID, inputSchema);
    }
  }

  return { inputSchemas, outputSchemas, compilationResponse: response };
}

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
        // Compile workflow to get fresh schemas
        const { inputSchemas, outputSchemas } = await compileAndGetSchemas(workflowState);

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
                inputSchema: inputSchemas.get(operatorId) || {},
                outputSchema: outputSchemas.get(operatorId) || {},
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
              inputSchema: inputSchemas.get(operator.operatorID) || {},
              outputSchema: outputSchemas.get(operator.operatorID) || {},
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
  // Create WorkflowUtilService if metadataStore is available
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore) : null;

  return tool({
    description:
      "Add a new operator to the workflow. Specify the operator type and its properties. " +
      "Use getOperatorSchema first to understand what properties are required. " +
      "For PythonUDFV2 operators, you can specify numInputPorts to create multiple input ports (default is 1).",
    inputSchema: z.object({
      operatorType: z.string().describe("The type of operator to add (e.g., 'PythonUDFV2', 'Aggregate')"),
      properties: z.record(z.any()).optional().describe("Properties to set on the operator"),
      customDisplayName: z.string().optional().describe("Optional custom display name for the operator"),
      numInputPorts: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe(
          "Number of input ports for PythonUDFV2 operators (0-10). Only applicable to PythonUDFV2. " +
            "Use multiple input ports when you need to combine data from multiple sources in Python code."
        ),
      inputPortNames: z
        .array(z.string())
        .optional()
        .describe(
          "Optional display names for each input port (e.g., ['model', 'data']). Only applicable to PythonUDFV2."
        ),
    }),
    execute: async (args: {
      operatorType: string;
      properties?: Record<string, any>;
      customDisplayName?: string;
      numInputPorts?: number;
      inputPortNames?: string[];
    }) => {
      try {
        // Check if operator type exists
        const schemaEntry = operatorSchemas.get(args.operatorType);
        if (!schemaEntry) {
          return createErrorResult(
            `Unknown operator type: ${args.operatorType}. Use listAllAvailableOperatorTypes to see available operators.`
          );
        }

        // Validate properties against schema if metadataStore is provided
        if (context?.metadataStore && args.properties) {
          const validation = context.metadataStore.validateOperatorProperties(args.operatorType, args.properties);
          if (!validation.isValid) {
            return createErrorResult(
              `Invalid operator properties for "${args.operatorType}". ${formatValidationErrors(validation)}\n` +
                `Use getOperatorSchema("${args.operatorType}") to see the required property format.`
            );
          }
        }

        // Capture before state for agent action
        const beforeContent = workflowState.getWorkflowContent();

        // Use WorkflowUtilService to create operator with proper format (matching frontend exactly)
        if (!workflowUtil) {
          return createErrorResult("Metadata store not available for operator creation");
        }

        let operator = workflowUtil.getNewOperatorPredicate(args.operatorType, args.customDisplayName);

        // Merge provided properties with default properties
        if (args.properties) {
          operator = {
            ...operator,
            operatorProperties: {
              ...operator.operatorProperties,
              ...args.properties,
            },
          };
        }

        workflowState.addOperator(operator);

        // Handle numInputPorts for PythonUDFV2
        if (args.numInputPorts !== undefined) {
          if (args.operatorType !== "PythonUDFV2") {
            return createErrorResult(
              `numInputPorts is only supported for PythonUDFV2 operators. ` +
                `Operator type "${args.operatorType}" does not support dynamic input ports.`
            );
          }
          if (args.numInputPorts < 0 || args.numInputPorts > 10) {
            return createErrorResult(`numInputPorts must be between 0 and 10, got ${args.numInputPorts}`);
          }
          workflowState.updateOperatorInputPorts(operator.operatorID, args.numInputPorts, args.inputPortNames);
        }

        // Compile workflow to get the new operator's schemas
        const { inputSchemas, outputSchemas } = await compileAndGetSchemas(workflowState);
        const inputSchema = inputSchemas.get(operator.operatorID) || {};
        const outputSchema = outputSchemas.get(operator.operatorID) || {};

        // Capture after state and create agent action if manager is provided
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
            inputSchema,
            outputSchema,
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
      "Add a link connecting two operators in the workflow. " +
      "Specify source operator/port and target operator/port.",
    inputSchema: z.object({
      sourceOperatorId: z.string().describe("ID of the source operator"),
      sourcePortId: z.string().optional().describe("ID of the source port (default: 'output-0')"),
      targetOperatorId: z.string().describe("ID of the target operator"),
      targetPortId: z.string().optional().describe("ID of the target port (default: 'input-0')"),
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

        // Capture before state
        const beforeContent = workflowState.getWorkflowContent();

        const linkId = generateLinkId();
        const link: OperatorLink = {
          linkID: linkId,
          source: {
            operatorID: args.sourceOperatorId,
            portID: args.sourcePortId || "output-0",
          },
          target: {
            operatorID: args.targetOperatorId,
            portID: args.targetPortId || "input-0",
          },
        };

        workflowState.addLink(link);

        // Compile workflow to get updated schemas (links affect input schemas)
        const { inputSchemas, outputSchemas } = await compileAndGetSchemas(workflowState);
        const targetInputSchema = inputSchemas.get(args.targetOperatorId) || {};
        const targetOutputSchema = outputSchemas.get(args.targetOperatorId) || {};

        // Capture after state and create agent action if manager is provided
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
            targetOperatorSchema: {
              inputSchema: targetInputSchema,
              outputSchema: targetOutputSchema,
            },
            message: `Added link from ${args.sourceOperatorId} to ${args.targetOperatorId}`,
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
      "Modify properties of an existing operator in the workflow. " +
      "Use getCurrentWorkflow first to see current operator properties. " +
      "For PythonUDFV2 operators, you can also change the number of input ports.",
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to modify"),
      properties: z.record(z.any()).describe("Properties to update (merged with existing)"),
      summary: z.string().optional().describe("Optional brief summary of what this modification accomplishes"),
      numInputPorts: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe(
          "Number of input ports for PythonUDFV2 operators (0-10). Only applicable to PythonUDFV2. " +
            "Use this to add or remove input ports for combining multiple data sources."
        ),
      inputPortNames: z
        .array(z.string())
        .optional()
        .describe(
          "Optional display names for each input port (e.g., ['model', 'data']). Only applicable to PythonUDFV2."
        ),
    }),
    execute: async (args: {
      operatorId: string;
      properties: Record<string, any>;
      summary?: string;
      numInputPorts?: number;
      inputPortNames?: string[];
    }) => {
      try {
        const operator = workflowState.getOperator(args.operatorId);
        if (!operator) {
          return createErrorResult(`Operator ${args.operatorId} not found`);
        }

        // Merge current properties with new properties for validation
        const mergedProperties = { ...operator.operatorProperties, ...args.properties };

        // Validate merged properties against schema if metadataStore is provided
        if (context?.metadataStore) {
          const validation = context.metadataStore.validateOperatorProperties(operator.operatorType, mergedProperties);
          if (!validation.isValid) {
            return createErrorResult(
              `Invalid operator properties for "${operator.operatorType}". ${formatValidationErrors(validation)}\n` +
                `Use getOperatorSchema("${operator.operatorType}") to see the required property format.`
            );
          }
        }

        // Handle numInputPorts for PythonUDFV2
        if (args.numInputPorts !== undefined) {
          if (operator.operatorType !== "PythonUDFV2") {
            return createErrorResult(
              `numInputPorts is only supported for PythonUDFV2 operators. ` +
                `Operator "${args.operatorId}" is of type "${operator.operatorType}" which does not support dynamic input ports.`
            );
          }
          if (args.numInputPorts < 0 || args.numInputPorts > 10) {
            return createErrorResult(`numInputPorts must be between 0 and 10, got ${args.numInputPorts}`);
          }
        }

        // Capture before state
        const beforeContent = workflowState.getWorkflowContent();

        workflowState.updateOperatorProperties(args.operatorId, args.properties);

        // Update input ports if specified (only for PythonUDFV2)
        if (args.numInputPorts !== undefined) {
          workflowState.updateOperatorInputPorts(args.operatorId, args.numInputPorts, args.inputPortNames);
        }

        // Compile workflow to get the updated operator's schemas
        const { inputSchemas, outputSchemas } = await compileAndGetSchemas(workflowState);
        const inputSchema = inputSchemas.get(args.operatorId) || {};
        const outputSchema = outputSchemas.get(args.operatorId) || {};

        // Capture after state and create agent action if manager is provided
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
            inputSchema,
            outputSchema,
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
