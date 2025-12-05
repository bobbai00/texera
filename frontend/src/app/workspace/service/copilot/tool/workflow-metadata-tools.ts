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
import Ajv from "ajv";
import { OperatorMetadataService } from "../../operator-metadata/operator-metadata.service";
import { createSuccessResult, createErrorResult } from "./tools-utility";
import { Validation, ValidationError } from "../../validation/validation-workflow.service";

// Tool name constants
export const TOOL_NAME_LIST_ALL_AVAILABLE_OPERATOR_TYPES = "listAllAvailableOperatorTypes";
export const TOOL_NAME_GET_OPERATOR_SCHEMA = "getOperatorSchema";

// Legacy constants (kept for backward compatibility)
export const TOOL_NAME_LIST_ALL_OPERATOR_TYPES_AND_SCHEMAS = "listAllOperatorTypesAndSchemas";
export const TOOL_NAME_GET_OPERATOR_PORTS_INFO = "getOperatorPortsInfo";
export const TOOL_NAME_GET_OPERATOR_METADATA = "getOperatorMetadata";

// Whitelist of allowed operator types for the copilot (used for system prompt embedding)
export const ALLOWED_OPERATOR_TYPES = [
  "PythonUDFV2",
  "Aggregate",
  "Projection",
  "HashJoin",
  "Sort",
  "Union",
  "Intersect",
  "CartesianProduct",
  "CSVFileScan",
] as const;

/**
 * Operator schema info structure (raw format with separate definitions)
 */
export interface OperatorSchemaInfo {
  properties: any;
  required: any;
  definitions: any;
}

/**
 * Compact operator schema with inlined definitions (no $ref)
 */
export interface CompactOperatorSchema {
  properties: Record<string, any>;
  required: string[];
}

/**
 * Result of gathering all allowed operator schemas
 */
export interface AllowedOperatorSchemasResult {
  operators: Record<string, OperatorSchemaInfo>;
  operatorTypes: string[];
  count: number;
}

// Keys to filter out from properties
const FILTERED_PROPERTY_KEYS = ["dummyPropertyList"];

// Keys to filter out from definitions
const FILTERED_DEFINITION_KEYS = [
  "DummyProperties",
  "PortDescription",
  "HashPartition",
  "RangePartition",
  "SinglePartition",
  "BroadcastPartition",
  "UnknownPartition",
];

/**
 * Filter an object by excluding specified keys.
 */
function filterObjectKeys(obj: any, keysToExclude: string[]): any {
  if (!obj || typeof obj !== "object") {
    return obj;
  }
  const filtered: any = {};
  for (const key of Object.keys(obj)) {
    if (!keysToExclude.includes(key)) {
      filtered[key] = obj[key];
    }
  }
  return filtered;
}

// Keys to exclude from compact schema (UI-specific, not needed for agent)
const COMPACT_SCHEMA_EXCLUDED_KEYS = ["propertyOrder", "autofill", "autofillAttributeOnPort", "attributeTypeRules"];

/**
 * Recursively inline $ref references and clean up schema for compact representation.
 */
function inlineRefs(schema: any, definitions: Record<string, any>): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  // Handle $ref
  if (schema.$ref && typeof schema.$ref === "string") {
    const refPath = schema.$ref.replace("#/definitions/", "");
    const refDef = definitions[refPath];
    if (refDef) {
      // Inline the referenced definition (recursively process it too)
      return inlineRefs(refDef, definitions);
    }
    return schema;
  }

  // Handle arrays
  if (Array.isArray(schema)) {
    return schema.map(item => inlineRefs(item, definitions));
  }

  // Handle objects - recursively process and filter keys
  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (COMPACT_SCHEMA_EXCLUDED_KEYS.includes(key)) {
      continue; // Skip UI-specific keys
    }
    if (key === "items" && value && typeof value === "object") {
      result[key] = inlineRefs(value, definitions);
    } else if (key === "properties" && value && typeof value === "object") {
      result[key] = {};
      for (const [propName, propValue] of Object.entries(value)) {
        result[key][propName] = inlineRefs(propValue, definitions);
      }
    } else if (typeof value === "object" && value !== null) {
      result[key] = inlineRefs(value, definitions);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Get compact schema with inlined definitions for an operator type.
 * This is more readable for the agent as it doesn't require looking up $ref.
 */
export function getCompactOperatorSchema(
  operatorMetadataService: OperatorMetadataService,
  operatorType: string
): CompactOperatorSchema | null {
  try {
    const schema = operatorMetadataService.getOperatorSchema(operatorType);
    const properties = filterObjectKeys(schema.jsonSchema.properties, FILTERED_PROPERTY_KEYS);
    const definitions = filterObjectKeys(schema.jsonSchema.definitions, FILTERED_DEFINITION_KEYS) || {};

    // Inline all $ref and clean up each property
    const compactProperties: Record<string, any> = {};
    for (const [propName, propSchema] of Object.entries(properties || {})) {
      compactProperties[propName] = inlineRefs(propSchema, definitions);
    }

    return {
      properties: compactProperties,
      required: schema.jsonSchema.required || [],
    };
  } catch {
    return null;
  }
}

// Shared Ajv instance - same configuration as ValidationWorkflowService
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Validate operator properties against its schema using Ajv.
 * Returns the same Validation type as ValidationWorkflowService for consistency.
 */
export function validateOperatorProperties(
  operatorMetadataService: OperatorMetadataService,
  operatorType: string,
  properties: Record<string, any>
): Validation {
  try {
    const schema = operatorMetadataService.getOperatorSchema(operatorType);
    const isValid = ajv.validate(schema.jsonSchema, properties);

    if (isValid) {
      return { isValid: true };
    }

    // Convert Ajv errors to messages format (same as ValidationWorkflowService)
    const messages: Record<string, string> = {};
    if (ajv.errors) {
      ajv.errors.forEach(error => {
        const key = error.instancePath
          ? error.instancePath.replace(/^\//, "").replace(/\//g, ".")
          : error.params?.missingProperty || error.keyword;
        messages[key] = error.message || "Validation failed";
      });
    }
    return { isValid: false, messages };
  } catch (e) {
    return { isValid: false, messages: { error: `Unknown operator type: ${operatorType}` } };
  }
}

/**
 * Gather all allowed operator types with their properties schemas.
 * This is a pure function that can be called directly to get schema info.
 * Filters out internal properties (dummyPropertyList) and definitions (DummyProperties, PortDescription).
 */
export function getAllowedOperatorSchemas(
  operatorMetadataService: OperatorMetadataService
): AllowedOperatorSchemasResult {
  const operatorsWithSchemas: Record<string, OperatorSchemaInfo> = {};

  for (const operatorType of ALLOWED_OPERATOR_TYPES) {
    try {
      const schema = operatorMetadataService.getOperatorSchema(operatorType);
      operatorsWithSchemas[operatorType] = {
        properties: filterObjectKeys(schema.jsonSchema.properties, FILTERED_PROPERTY_KEYS),
        required: schema.jsonSchema.required,
        definitions: filterObjectKeys(schema.jsonSchema.definitions, FILTERED_DEFINITION_KEYS),
      };
    } catch {
      // Skip operators that don't exist in this installation
    }
  }

  const availableTypes = Object.keys(operatorsWithSchemas);

  return {
    operators: operatorsWithSchemas,
    operatorTypes: availableTypes,
    count: availableTypes.length,
  };
}

/**
 * Generate a JSON string representation of allowed operator schemas for embedding in prompts.
 */
export function getAllowedOperatorSchemasAsJson(operatorMetadataService: OperatorMetadataService): string {
  const result = getAllowedOperatorSchemas(operatorMetadataService);
  return JSON.stringify(result.operators, null, 2);
}

/**
 * Get all available operator types with their descriptions.
 */
export function getAllAvailableOperatorTypes(operatorMetadataService: OperatorMetadataService): Record<string, string> {
  const metadata = (operatorMetadataService as any).currentOperatorMetadata;
  if (!metadata) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const schema of metadata.operators) {
    result[schema.operatorType] = schema.additionalMetadata.operatorDescription || "";
  }
  return result;
}

/**
 * Get the schema for a specific operator type.
 * Returns filtered schema info (properties, required, definitions).
 */
export function getOperatorSchemaInfo(
  operatorMetadataService: OperatorMetadataService,
  operatorType: string
): OperatorSchemaInfo | null {
  try {
    const schema = operatorMetadataService.getOperatorSchema(operatorType);
    return {
      properties: filterObjectKeys(schema.jsonSchema.properties, FILTERED_PROPERTY_KEYS),
      required: schema.jsonSchema.required,
      definitions: filterObjectKeys(schema.jsonSchema.definitions, FILTERED_DEFINITION_KEYS),
    };
  } catch {
    return null;
  }
}

/**
 * Create a tool to list all available operator types with descriptions.
 */
export function createListAllAvailableOperatorTypesTool(operatorMetadataService: OperatorMetadataService) {
  return tool({
    name: TOOL_NAME_LIST_ALL_AVAILABLE_OPERATOR_TYPES,
    description:
      "List all available operator types in Texera with their descriptions. " +
      "Use this to discover what operators are available before adding them to a workflow.",
    inputSchema: z.object({}),
    execute: async () => {
      const operators = getAllAvailableOperatorTypes(operatorMetadataService);
      const count = Object.keys(operators).length;
      if (count === 0) {
        return createErrorResult("Operator metadata not yet loaded. Please try again.");
      }
      return createSuccessResult({ operators, count }, [], [], []);
    },
  });
}

/**
 * Create a tool to get the schema of a specific operator type.
 * Returns a compact schema with inlined definitions for easier reading.
 */
export function createGetOperatorSchemaTool(operatorMetadataService: OperatorMetadataService) {
  return tool({
    name: TOOL_NAME_GET_OPERATOR_SCHEMA,
    description:
      "Get the JSON schema for a specific operator type. " +
      "Returns a compact schema with inlined definitions. " +
      "Use this to understand what properties an operator requires before adding it to a workflow.",
    inputSchema: z.object({
      operatorType: z.string().describe("The operator type to get the schema for (e.g., 'PythonUDFV2', 'Aggregate')"),
    }),
    execute: async (args: { operatorType: string }) => {
      const compactSchema = getCompactOperatorSchema(operatorMetadataService, args.operatorType);
      if (!compactSchema) {
        return createErrorResult(`Operator type "${args.operatorType}" not found.`);
      }
      return createSuccessResult({ operatorType: args.operatorType, schema: compactSchema }, [], [], []);
    },
  });
}
