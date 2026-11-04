// The workflow spec as the catalog stores it (a version's content is a WorkflowSpec),
// unchanged from what the engine compiles, so a workflow edited here runs there as it is.
// Positions are the app's: derived from the graph, never written into the spec.

import type { Attribute, WorkflowLink, WorkflowOperator, WorkflowPort, WorkflowSpec } from "@texera/catalog-client/types";

export type { Attribute, WorkflowLink, WorkflowOperator, WorkflowPort, WorkflowSpec };

export interface Point {
  x: number;
  y: number;
}

/** Where each operator sits on the canvas, by operator id. */
export type Positions = Record<string, Point>;

export interface LogicalPort {
  operatorID: string;
  /** `input-<n>` or `output-<n>`. */
  portID: string;
}

/**
 * The JSON Schema subset operators publish (draft-07 from the engine's generator),
 * plus Texera's own keywords the property editor acts on.
 */
export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  /** `credential`: the field takes a credential URI; the catalog substitutes the secret at run time. */
  format?: string;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  definitions?: Record<string, JsonSchema>;
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  const?: unknown;
  propertyOrder?: number;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  uniqueItems?: boolean;
  readOnly?: boolean;
  additionalProperties?: boolean | JsonSchema;
  options?: { hidden?: boolean };
  /** Column pickers: one column, or several, from the operator's input on `autofillAttributeOnPort`. */
  autofill?: "attributeName" | "attributeNameList";
  autofillAttributeOnPort?: number;
  additionalEnumValue?: string;
  /** Hide this field depending on a sibling's value. */
  hideTarget?: string;
  hideType?: "equals" | "regex";
  hideExpectedValue?: string;
  hideOnNull?: boolean;
  /** On a boolean: siblings shown only while it is true. */
  toggleHidden?: string[];
  widget?: {
    formlyConfig?: { type?: string; props?: Record<string, unknown>; templateOptions?: Record<string, unknown> };
  };
}

export interface PortSchema {
  displayName?: string;
  allowMultiLinks?: boolean;
}

/** One operator type, as the editor needs it: its schema and how to build an instance of it. */
export interface OperatorSchema {
  /** A built-in type name, or a custom operator's URI with `@vno`. */
  operatorType: string;
  userFriendlyName: string;
  operatorDescription?: string;
  operatorGroupName: string;
  jsonSchema: JsonSchema;
  inputPorts: PortSchema[];
  outputPorts: PortSchema[];
  /** The custom operator resource this type comes from, when it is one. */
  custom?: { rid: string; vno: number };
}
