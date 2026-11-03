// The engine's workflow JSON (what a workflow version's content holds), unchanged
// from what the engine compiles, so workflows edited here run there as they are.

export type { Attribute } from "@texera/catalog-client/types";

export interface Point {
  x: number;
  y: number;
}

export interface PortDescription {
  portID: string;
  displayName?: string;
  disallowMultiInputs?: boolean;
  isDynamicPort?: boolean;
  partitionRequirement?: unknown;
  dependencies?: { id: number; internal: boolean }[];
}

export interface OperatorPredicate {
  operatorID: string;
  operatorType: string;
  operatorVersion: string;
  operatorProperties: Record<string, unknown>;
  inputPorts: PortDescription[];
  outputPorts: PortDescription[];
  dynamicInputPorts?: boolean;
  dynamicOutputPorts?: boolean;
  showAdvanced: boolean;
  isDisabled?: boolean;
  viewResult?: boolean;
  markedForReuse?: boolean;
  customDisplayName?: string;
}

export interface LogicalPort {
  operatorID: string;
  /** `input-<n>` or `output-<n>`. */
  portID: string;
}

export interface OperatorLink {
  linkID: string;
  source: LogicalPort;
  target: LogicalPort;
}

export interface WorkflowSettings {
  dataTransferBatchSize: number;
  executionMode?: "PIPELINED" | "MATERIALIZED";
}

export interface WorkflowContent {
  operators: OperatorPredicate[];
  operatorPositions: Record<string, Point>;
  links: OperatorLink[];
  commentBoxes: unknown[];
  settings: WorkflowSettings;
  /** The Form View definition; kept when saving, never edited here. */
  formBinding?: unknown;
}

/**
 * The JSON Schema subset operators publish (draft-07 from the engine's generator),
 * plus Texera's own keywords the property editor acts on.
 */
export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  definitions?: Record<string, JsonSchema>;
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
  dependencies?: { id: number; internal: boolean }[];
}

/** One operator type, as the editor needs it: its schema and how to build an instance of it. */
export interface OperatorSchema {
  operatorType: string;
  operatorVersion: string;
  userFriendlyName: string;
  operatorDescription?: string;
  operatorGroupName: string;
  jsonSchema: JsonSchema;
  inputPorts: PortSchema[];
  outputPorts: PortSchema[];
  dynamicInputPorts?: boolean;
  dynamicOutputPorts?: boolean;
}

export interface OperatorGroup {
  groupName: string;
  children?: OperatorGroup[] | null;
}

export interface OperatorMetadata {
  operators: OperatorSchema[];
  groups: OperatorGroup[];
}
