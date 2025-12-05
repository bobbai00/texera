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

import { z } from "zod";
import { tool } from "ai";
import { WorkflowActionService } from "../../workflow-graph/model/workflow-action.service";
import { AgentActionService } from "../../agent-action/agent-action.service";
import { OperatorMetadataService } from "../../operator-metadata/operator-metadata.service";
import { WorkflowCompilingService } from "../../compile-workflow/workflow-compiling.service";
import { createSuccessResult, createErrorResult, OperatorDetail } from "./tools-utility";
import { validateOperatorProperties } from "./workflow-metadata-tools";
import { Validation } from "../../validation/validation-workflow.service";

// Tool name constants for operator-specific tools
export const TOOL_NAME_ADD_OPERATOR = "addOperator";
export const TOOL_NAME_ADD_PYTHON_UDF_V2 = "addPythonUDFV2";
export const TOOL_NAME_ADD_AGGREGATE = "addAggregate";
export const TOOL_NAME_ADD_PROJECTION = "addProjection";
export const TOOL_NAME_ADD_HASH_JOIN = "addHashJoin";
export const TOOL_NAME_ADD_SORT = "addSort";
export const TOOL_NAME_ADD_UNION = "addUnion";
export const TOOL_NAME_ADD_INTERSECT = "addIntersect";
export const TOOL_NAME_ADD_CARTESIAN_PRODUCT = "addCartesianProduct";
export const TOOL_NAME_ADD_CSV_FILE_SCAN = "addCSVFileScan";
export const TOOL_NAME_ADD_LINK = "addLink";
export const TOOL_NAME_MODIFY_OPERATOR = "modifyOperator";
export const TOOL_NAME_DELETE_FROM_WORKFLOW = "deleteFromWorkflow";
export const TOOL_NAME_GET_CURRENT_WORKFLOW = "getCurrentWorkflow";

/**
 * Helper to create agent action and return its ID
 */
function createAndRecordAgentAction(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string,
  agentName: string,
  summary: string,
  operations: {
    add?: { operatorIds: string[]; linkIds: string[] };
    modify?: { operatorIds: string[] };
    delete?: { operatorIds: string[]; linkIds: string[] };
  },
  beforeWorkflowContent: any,
  afterWorkflowContent: any
) {
  const allOperatorIds = [...(operations.add?.operatorIds || []), ...(operations.modify?.operatorIds || [])];
  const allLinkIds = operations.add?.linkIds || [];

  return agentActionService.createAgentAction(
    agentId,
    agentName || "AI Agent",
    summary,
    {
      add: operations.add || { operatorIds: [], linkIds: [] },
      modify: operations.modify || { operatorIds: [] },
      delete: operations.delete || { operatorIds: [], linkIds: [] },
    },
    allOperatorIds,
    allLinkIds,
    workflowActionService.getWorkflowMetadata(),
    beforeWorkflowContent,
    afterWorkflowContent
  );
}

/**
 * Format validation result into a readable message for the agent.
 */
function formatValidationErrors(validation: Validation): string {
  if (validation.isValid) return "";
  const errorMessages = Object.entries(validation.messages).map(([key, msg]) => `  - ${key}: ${msg}`);
  return `Schema validation errors:\n${errorMessages.join("\n")}`;
}

/**
 * Helper function to add an operator and return the result
 */
function addOperatorHelper(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string,
  agentName: string,
  operatorType: string,
  customDisplayName: string,
  operatorProperties: Record<string, any>
) {
  try {
    const beforeContent = workflowActionService.getWorkflowContent();
    const results = workflowActionService.applyAgentAction({
      add: {
        operators: [
          {
            operatorType,
            customDisplayName,
            operatorProperties,
          },
        ],
      },
    });

    if (!results.success) {
      return createErrorResult(results.error || "Failed to add operator");
    }

    // Auto layout the workflow after adding operator
    workflowActionService.autoLayoutWorkflow();

    const afterContent = workflowActionService.getWorkflowContent();

    // Create agent action
    const agentAction = createAndRecordAgentAction(
      workflowActionService,
      agentActionService,
      agentId,
      agentName,
      customDisplayName,
      { add: { operatorIds: results.addedOperatorIds, linkIds: [] } },
      beforeContent,
      afterContent
    );

    // Return success with the added operator marked as added (not modified)
    return createSuccessResult(
      {
        operatorId: results.addedOperatorIds[0],
        agentActionId: agentAction.id,
      },
      [], // viewedOperatorIds - none for add
      results.addedOperatorIds, // addedOperatorIds - the newly added operator
      [] // modifiedOperatorIds - none for add (it's a new operator)
    );
  } catch (error: any) {
    return createErrorResult(error.message);
  }
}

/**
 * Create a generic addOperator tool that can add any available operator type.
 * Use listAllAvailableOperatorTypes to discover available operators and
 * getOperatorSchema to understand the required properties.
 */
export function createAddOperatorTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  operatorMetadataService: OperatorMetadataService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_ADD_OPERATOR,
    description:
      "Add any available operator type to the workflow. " +
      "First use listAllAvailableOperatorTypes to discover operators, " +
      "then use getOperatorSchema to understand required properties. " +
      "Pass the operatorType, customDisplayName, and operatorProperties.",
    inputSchema: z.object({
      operatorType: z
        .string()
        .describe("The type of operator to add (e.g., 'PythonUDFV2', 'Aggregate', 'CSVFileScan')"),
      customDisplayName: z.string().describe("Brief custom name summarizing what this operator does"),
      operatorProperties: z
        .record(z.any())
        .default({})
        .describe("Properties for the operator based on its schema (use getOperatorSchema to see required properties)"),
    }),
    execute: async (args: {
      operatorType: string;
      customDisplayName: string;
      operatorProperties: Record<string, any>;
    }) => {
      // Validate operator type exists
      if (!operatorMetadataService.operatorTypeExists(args.operatorType)) {
        return createErrorResult(
          `Operator type "${args.operatorType}" not found. Use listAllAvailableOperatorTypes to see available operators.`
        );
      }

      // Validate properties against schema
      const validation = validateOperatorProperties(
        operatorMetadataService,
        args.operatorType,
        args.operatorProperties
      );
      if (!validation.isValid) {
        return createErrorResult(
          `Invalid operator properties for "${args.operatorType}". ${formatValidationErrors(validation)}\n` +
            `Use getOperatorSchema("${args.operatorType}") to see the required property format.`
        );
      }

      return addOperatorHelper(
        workflowActionService,
        agentActionService,
        agentId,
        agentName,
        args.operatorType,
        args.customDisplayName,
        args.operatorProperties
      );
    },
  });
}

/**
 * Create addPythonUDFV2 tool for adding Python UDF operator
 */
export function createAddPythonUDFV2Tool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_ADD_PYTHON_UDF_V2,
    description: "Add a PythonUDFV2 operator to the workflow for custom Python data processing",
    inputSchema: z.object({
      customDisplayName: z.string().describe("Brief custom name summarizing what this operator does"),
      code: z
        .string()
        .describe(
          "Python code for the UDF. Use pytexera library with ProcessTupleOperator, ProcessBatchOperator, or ProcessTableOperator"
        ),
      retainInputColumns: z
        .boolean()
        .default(true)
        .describe("Whether to keep the original input columns in the output"),
      outputColumns: z
        .array(
          z.object({
            attributeName: z.string().describe("Name of the output column"),
            attributeType: z
              .enum(["string", "integer", "long", "double", "boolean", "timestamp", "binary", "big_object"])
              .describe("Type of the output column"),
          })
        )
        .optional()
        .describe("List of new output columns that the UDF will produce"),
    }),
    execute: async (args: {
      customDisplayName: string;
      code: string;
      retainInputColumns: boolean;
      outputColumns?: Array<{ attributeName: string; attributeType: string }>;
    }) => {
      const operatorProperties: Record<string, any> = {
        code: args.code,
        retainInputColumns: args.retainInputColumns,
        workers: 1,
      };
      if (args.outputColumns) {
        operatorProperties.outputColumns = args.outputColumns;
      }
      return addOperatorHelper(
        workflowActionService,
        agentActionService,
        agentId,
        agentName,
        "PythonUDFV2",
        args.customDisplayName,
        operatorProperties
      );
    },
  });
}

/**
 * Create addAggregate tool for adding Aggregate operator
 */
export function createAddAggregateTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_ADD_AGGREGATE,
    description:
      "Add an Aggregate operator to the workflow for computing aggregate functions (sum, count, average, min, max, concat) on data",
    inputSchema: z.object({
      customDisplayName: z.string().describe("Brief custom name summarizing what this operator does"),
      aggregations: z
        .array(
          z.object({
            aggFunction: z
              .enum(["sum", "count", "average", "min", "max", "concat"])
              .describe("Aggregation function to apply"),
            attribute: z.string().describe("Column name to aggregate on"),
            "result attribute": z.string().describe("Name of the result column"),
          })
        )
        .min(1)
        .describe("List of aggregation operations to perform"),
      groupByKeys: z.array(z.string()).optional().describe("Column names to group by before aggregating"),
    }),
    execute: async (args: {
      customDisplayName: string;
      aggregations: Array<{ aggFunction: string; attribute: string; "result attribute": string }>;
      groupByKeys?: string[];
    }) => {
      const operatorProperties: Record<string, any> = {
        aggregations: args.aggregations,
      };
      if (args.groupByKeys) {
        operatorProperties.groupByKeys = args.groupByKeys;
      }
      return addOperatorHelper(
        workflowActionService,
        agentActionService,
        agentId,
        agentName,
        "Aggregate",
        args.customDisplayName,
        operatorProperties
      );
    },
  });
}

/**
 * Create addProjection tool for adding Projection operator
 */
export function createAddProjectionTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_ADD_PROJECTION,
    description:
      "Add a Projection operator to the workflow for selecting or dropping specific columns, optionally with aliases",
    inputSchema: z.object({
      customDisplayName: z.string().describe("Brief custom name summarizing what this operator does"),
      isDrop: z
        .boolean()
        .default(false)
        .describe("If true, drop the selected attributes; if false, keep only the selected attributes"),
      attributes: z
        .array(
          z.object({
            originalAttribute: z.string().describe("Name of the attribute to select or drop"),
            alias: z.string().optional().describe("Optional new name for the attribute"),
          })
        )
        .optional()
        .describe("List of attributes to select or drop"),
    }),
    execute: async (args: {
      customDisplayName: string;
      isDrop: boolean;
      attributes?: Array<{ originalAttribute: string; alias?: string }>;
    }) => {
      const operatorProperties: Record<string, any> = {
        isDrop: args.isDrop,
      };
      if (args.attributes) {
        operatorProperties.attributes = args.attributes;
      }
      return addOperatorHelper(
        workflowActionService,
        agentActionService,
        agentId,
        agentName,
        "Projection",
        args.customDisplayName,
        operatorProperties
      );
    },
  });
}

/**
 * Create addHashJoin tool for adding HashJoin operator
 */
export function createAddHashJoinTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_ADD_HASH_JOIN,
    description:
      "Add a HashJoin operator to the workflow for joining two data streams based on matching attribute values",
    inputSchema: z.object({
      customDisplayName: z.string().describe("Brief custom name summarizing what this operator does"),
      buildAttributeName: z.string().describe("Attribute name from the left input to join on"),
      probeAttributeName: z.string().describe("Attribute name from the right input to join on"),
      joinType: z
        .enum(["inner", "left outer", "right outer", "full outer"])
        .default("inner")
        .describe("Type of join to perform"),
    }),
    execute: async (args: {
      customDisplayName: string;
      buildAttributeName: string;
      probeAttributeName: string;
      joinType: string;
    }) => {
      const operatorProperties: Record<string, any> = {
        buildAttributeName: args.buildAttributeName,
        probeAttributeName: args.probeAttributeName,
        joinType: args.joinType,
      };
      return addOperatorHelper(
        workflowActionService,
        agentActionService,
        agentId,
        agentName,
        "HashJoin",
        args.customDisplayName,
        operatorProperties
      );
    },
  });
}

/**
 * Create addSort tool for adding Sort operator
 */
export function createAddSortTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_ADD_SORT,
    description: "Add a Sort operator to the workflow for sorting data by one or more attributes",
    inputSchema: z.object({
      customDisplayName: z.string().describe("Brief custom name summarizing what this operator does"),
      attributes: z
        .array(
          z.object({
            attribute: z.string().describe("Attribute name to sort by"),
            sortPreference: z.enum(["ASC", "DESC"]).describe("Sort order: ASC (ascending) or DESC (descending)"),
          })
        )
        .min(1)
        .describe("List of attributes to sort by, in order of priority"),
    }),
    execute: async (args: {
      customDisplayName: string;
      attributes: Array<{ attribute: string; sortPreference: string }>;
    }) => {
      const operatorProperties: Record<string, any> = {
        attributes: args.attributes,
      };
      return addOperatorHelper(
        workflowActionService,
        agentActionService,
        agentId,
        agentName,
        "Sort",
        args.customDisplayName,
        operatorProperties
      );
    },
  });
}

/**
 * Create addUnion tool for adding Union operator
 */
export function createAddUnionTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_ADD_UNION,
    description:
      "Add a Union operator to the workflow for combining rows from multiple input streams into a single output",
    inputSchema: z.object({
      customDisplayName: z.string().describe("Brief custom name summarizing what this operator does"),
    }),
    execute: async (args: { customDisplayName: string }) => {
      return addOperatorHelper(
        workflowActionService,
        agentActionService,
        agentId,
        agentName,
        "Union",
        args.customDisplayName,
        {}
      );
    },
  });
}

/**
 * Create addIntersect tool for adding Intersect operator
 */
export function createAddIntersectTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_ADD_INTERSECT,
    description: "Add an Intersect operator to the workflow for returning only rows that appear in all input streams",
    inputSchema: z.object({
      customDisplayName: z.string().describe("Brief custom name summarizing what this operator does"),
    }),
    execute: async (args: { customDisplayName: string }) => {
      return addOperatorHelper(
        workflowActionService,
        agentActionService,
        agentId,
        agentName,
        "Intersect",
        args.customDisplayName,
        {}
      );
    },
  });
}

/**
 * Create addCartesianProduct tool for adding CartesianProduct operator
 */
export function createAddCartesianProductTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_ADD_CARTESIAN_PRODUCT,
    description:
      "Add a CartesianProduct operator to the workflow for creating all possible combinations of rows from two input streams",
    inputSchema: z.object({
      customDisplayName: z.string().describe("Brief custom name summarizing what this operator does"),
    }),
    execute: async (args: { customDisplayName: string }) => {
      return addOperatorHelper(
        workflowActionService,
        agentActionService,
        agentId,
        agentName,
        "CartesianProduct",
        args.customDisplayName,
        {}
      );
    },
  });
}

/**
 * Create addCSVFileScan tool for adding CSVFileScan operator
 */
export function createAddCSVFileScanTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_ADD_CSV_FILE_SCAN,
    description: "Add a CSVFileScan operator to the workflow for reading data from a CSV file",
    inputSchema: z.object({
      customDisplayName: z.string().describe("Brief custom name summarizing what this operator does"),
      fileName: z.string().describe("Path to the CSV file to read"),
      fileEncoding: z.enum(["UTF_8", "UTF_16", "US_ASCII"]).default("UTF_8").describe("Character encoding of the file"),
      hasHeader: z.boolean().default(true).describe("Whether the CSV file has a header row"),
      customDelimiter: z.string().default(",").optional().describe("Delimiter character used to separate fields"),
      limit: z.number().int().optional().describe("Maximum number of rows to read"),
      offset: z.number().int().optional().describe("Number of rows to skip from the beginning"),
    }),
    execute: async (args: {
      customDisplayName: string;
      fileName: string;
      fileEncoding: string;
      hasHeader: boolean;
      customDelimiter?: string;
      limit?: number;
      offset?: number;
    }) => {
      const operatorProperties: Record<string, any> = {
        fileName: args.fileName,
        fileEncoding: args.fileEncoding,
        hasHeader: args.hasHeader,
      };
      if (args.customDelimiter !== undefined) {
        operatorProperties.customDelimiter = args.customDelimiter;
      }
      if (args.limit !== undefined) {
        operatorProperties.limit = args.limit;
      }
      if (args.offset !== undefined) {
        operatorProperties.offset = args.offset;
      }
      return addOperatorHelper(
        workflowActionService,
        agentActionService,
        agentId,
        agentName,
        "CSVFileScan",
        args.customDisplayName,
        operatorProperties
      );
    },
  });
}

/**
 * Create addLink tool for adding a single link between operators
 */
export function createAddLinkTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_ADD_LINK,
    description: "Add a link (connection) between two operators in the workflow to define data flow",
    inputSchema: z.object({
      sourceOperatorId: z.string().describe("ID of the source operator"),
      targetOperatorId: z.string().describe("ID of the target operator"),
      sourcePortId: z.string().default("output-0").describe("Port ID on source operator (default: 'output-0')"),
      targetPortId: z.string().default("input-0").describe("Port ID on target operator (default: 'input-0')"),
    }),
    execute: async (args: {
      sourceOperatorId: string;
      targetOperatorId: string;
      sourcePortId: string;
      targetPortId: string;
    }) => {
      try {
        const beforeContent = workflowActionService.getWorkflowContent();
        const results = workflowActionService.applyAgentAction({
          add: {
            links: [
              {
                sourceOperatorId: args.sourceOperatorId,
                targetOperatorId: args.targetOperatorId,
                sourcePortId: args.sourcePortId,
                targetPortId: args.targetPortId,
              },
            ],
          },
        });

        if (!results.success) {
          return createErrorResult(results.error || "Failed to add link");
        }

        // Auto layout the workflow after adding link
        workflowActionService.autoLayoutWorkflow();

        const afterContent = workflowActionService.getWorkflowContent();

        // Create agent action
        const agentAction = createAndRecordAgentAction(
          workflowActionService,
          agentActionService,
          agentId,
          agentName,
          `Link ${args.sourceOperatorId} to ${args.targetOperatorId}`,
          { add: { operatorIds: [], linkIds: results.addedLinkIds } },
          beforeContent,
          afterContent
        );

        // Return success with source and target operators as viewed
        return createSuccessResult(
          {
            linkId: results.addedLinkIds[0],
            agentActionId: agentAction.id,
            message: "Added link successfully",
          },
          [args.sourceOperatorId, args.targetOperatorId], // viewedOperatorIds - both ends of the link
          [], // addedOperatorIds - adding a link doesn't add operators
          [] // modifiedOperatorIds - adding a link doesn't modify operators
        );
      } catch (error: any) {
        return createErrorResult(error.message);
      }
    },
  });
}

/**
 * Create modifyOperator tool for modifying a single operator's properties
 */
export function createModifyOperatorTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  operatorMetadataService: OperatorMetadataService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_MODIFY_OPERATOR,
    description: "Modify properties of an existing operator in the workflow",
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to modify"),
      operatorProperties: z.record(z.any()).describe("Map of operator properties to update"),
      summary: z.string().describe("A brief summary of what this modification accomplishes"),
    }),
    execute: async (args: { operatorId: string; operatorProperties: Record<string, any>; summary: string }) => {
      try {
        // Get the operator to find its type and current properties
        const operator = workflowActionService.getTexeraGraph().getOperator(args.operatorId);
        if (!operator) {
          return createErrorResult(`Operator with ID "${args.operatorId}" not found in the workflow.`);
        }

        // Merge current properties with new properties for validation
        const mergedProperties = { ...operator.operatorProperties, ...args.operatorProperties };

        // Validate merged properties against schema
        const validation = validateOperatorProperties(operatorMetadataService, operator.operatorType, mergedProperties);
        if (!validation.isValid) {
          return createErrorResult(
            `Invalid operator properties for "${operator.operatorType}". ${formatValidationErrors(validation)}\n` +
              `Use getOperatorSchema("${operator.operatorType}") to see the required property format.`
          );
        }

        const beforeContent = workflowActionService.getWorkflowContent();
        const results = workflowActionService.applyAgentAction({
          modify: {
            operators: [
              {
                operatorId: args.operatorId,
                operatorProperties: args.operatorProperties,
              },
            ],
          },
        });

        if (!results.success) {
          return createErrorResult(results.error || "Failed to modify operator");
        }

        // Auto layout the workflow after modifying operator
        workflowActionService.autoLayoutWorkflow();

        const afterContent = workflowActionService.getWorkflowContent();

        // Create agent action
        const agentAction = createAndRecordAgentAction(
          workflowActionService,
          agentActionService,
          agentId,
          agentName,
          args.summary,
          { modify: { operatorIds: results.modifiedOperatorIds } },
          beforeContent,
          afterContent
        );

        // Return success with the modified operator marked as modified
        return createSuccessResult(
          {
            operatorId: args.operatorId,
            agentActionId: agentAction.id,
            message: `Modified operator ${args.operatorId}`,
          },
          [], // viewedOperatorIds - none for modify
          [], // addedOperatorIds - none for modify
          results.modifiedOperatorIds // modifiedOperatorIds - the operators that were modified
        );
      } catch (error: any) {
        return createErrorResult(error.message);
      }
    },
  });
}

/**
 * Create deleteFromWorkflow tool for deleting operators and links
 */
export function createDeleteFromWorkflowTool(
  workflowActionService: WorkflowActionService,
  agentActionService: AgentActionService,
  agentId: string = "",
  agentName: string = ""
) {
  return tool({
    name: TOOL_NAME_DELETE_FROM_WORKFLOW,
    description: "Delete operators and/or links from the workflow.",
    inputSchema: z.object({
      summary: z.string().describe("A summary of what this delete operation accomplishes"),
      operatorIds: z.array(z.string()).optional().describe("List of operator IDs to delete"),
      linkIds: z.array(z.string()).optional().describe("List of link IDs to delete"),
    }),
    execute: async (args: { summary: string; operatorIds?: string[]; linkIds?: string[] }) => {
      try {
        const beforeContent = workflowActionService.getWorkflowContent();
        const results = workflowActionService.applyAgentAction({ delete: args });

        if (!results.success) {
          return createErrorResult(results.error || "Failed to delete operators/links");
        }

        // Auto layout the workflow after deleting operators/links
        workflowActionService.autoLayoutWorkflow();

        const afterContent = workflowActionService.getWorkflowContent();

        const agentAction = createAndRecordAgentAction(
          workflowActionService,
          agentActionService,
          agentId,
          agentName,
          args.summary,
          { delete: { operatorIds: results.deletedOperatorIds, linkIds: results.deletedLinkIds } },
          beforeContent,
          afterContent
        );

        // Return success - deleted operators are not in any category since they no longer exist
        return createSuccessResult(
          {
            agentActionId: agentAction.id,
            deletedOperatorIds: results.deletedOperatorIds,
            deletedLinkIds: results.deletedLinkIds,
            message: `Deleted ${results.deletedOperatorIds.length} operator(s) and ${results.deletedLinkIds.length} link(s)`,
          },
          [], // viewedOperatorIds - none for delete
          [], // addedOperatorIds - none for delete
          [] // modifiedOperatorIds - none for delete (deleted operators no longer exist)
        );
      } catch (error: any) {
        return createErrorResult(error.message);
      }
    },
  });
}

/**
 * Create unified getCurrentWorkflow tool that returns both operators and links
 * This merges the functionality of listCurrentLinks and listCurrentRelevantOperatorIds
 */
export function createGetCurrentWorkflowTool(
  workflowActionService: WorkflowActionService,
  workflowCompilingService: WorkflowCompilingService
) {
  return tool({
    name: TOOL_NAME_GET_CURRENT_WORKFLOW,
    description:
      "Get the current workflow structure including operators and links. " +
      "Returns a list of operators (with id, type, name, properties, input/output schemas) and a list of links. " +
      "Optionally filter to specific operator IDs. If no operatorIds provided, returns all enabled operators.",
    inputSchema: z.object({
      operatorIds: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of operator IDs to retrieve. If empty or not provided, returns all enabled operators in the workflow."
        ),
    }),
    execute: async (args: { operatorIds?: string[] }) => {
      try {
        const texeraGraph = workflowActionService.getTexeraGraph();

        // Get all links
        const links = texeraGraph.getAllLinks();

        // Determine which operators to return
        let operatorsToReturn: OperatorDetail[];

        if (args.operatorIds && args.operatorIds.length > 0) {
          // Filter to specific operator IDs
          const mappedOperators = args.operatorIds.map(operatorId => {
            try {
              const operator = texeraGraph.getOperator(operatorId);
              if (!operator) return null;

              const inputSchemaMap = workflowCompilingService.getOperatorInputSchemaMap(operatorId);
              const outputSchemaMap = workflowCompilingService.getOperatorOutputSchemaMap(operatorId);

              return {
                operatorId: operator.operatorID,
                operatorType: operator.operatorType,
                customDisplayName: operator.customDisplayName,
                operatorProperties: operator.operatorProperties,
                inputSchema: inputSchemaMap || {},
                outputSchema: outputSchemaMap || {},
              } as OperatorDetail;
            } catch {
              return null;
            }
          });
          operatorsToReturn = mappedOperators.filter(
            (op): op is NonNullable<typeof op> => op !== null
          ) as OperatorDetail[];
        } else {
          // Return all enabled operators
          const enabledOperators = texeraGraph.getAllEnabledOperators();
          operatorsToReturn = enabledOperators.map(operator => {
            const operatorId = operator.operatorID;
            const inputSchemaMap = workflowCompilingService.getOperatorInputSchemaMap(operatorId);
            const outputSchemaMap = workflowCompilingService.getOperatorOutputSchemaMap(operatorId);

            return {
              operatorId: operator.operatorID,
              operatorType: operator.operatorType,
              customDisplayName: operator.customDisplayName,
              operatorProperties: operator.operatorProperties,
              inputSchema: inputSchemaMap || {},
              outputSchema: outputSchemaMap || {},
            };
          });
        }

        const operatorIds = operatorsToReturn.map(op => op.operatorId);

        return createSuccessResult(
          {
            operators: operatorsToReturn,
            links: links,
            summary: {
              operatorCount: operatorsToReturn.length,
              linkCount: links.length,
            },
            message: `Retrieved ${operatorsToReturn.length} operator(s) and ${links.length} link(s) from the workflow.`,
          },
          operatorIds, // viewedOperatorIds - all operators that were retrieved
          [], // addedOperatorIds
          [] // modifiedOperatorIds
        );
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}
