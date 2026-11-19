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

// The operator types the backend offers, as GET /resources/operator-metadata describes them
// (OperatorMetadataGenerator.scala). Each type comes with the JSON schema of its properties (draft-07, with a few
// keywords of Texera's own that the property form reads) and with what the canvas needs to draw it.

import Ajv from "ajv";
import type { Operator, PortDescription } from "./model";

/** An input port as the type defines it (InputPort in workflow.proto). */
export interface InputPortInfo {
  displayName?: string;
  /** The port takes one link only. */
  disallowMultiLinks?: boolean;
  [key: string]: unknown;
}

export interface OutputPortInfo {
  displayName?: string;
  [key: string]: unknown;
}

/** What the backend says about a type besides its properties (OperatorInfo). */
export interface OperatorInfo {
  userFriendlyName: string;
  operatorDescription?: string;
  /** The group of the operator menu the type is listed in. */
  operatorGroupName: string;
  inputPorts: InputPortInfo[];
  outputPorts: OutputPortInfo[];
  /** Whether the user may add and remove ports on that side. */
  dynamicInputPorts?: boolean;
  dynamicOutputPorts?: boolean;
  supportReconfiguration?: boolean;
  allowPortCustomization?: boolean;
}

/** A JSON schema as the backend writes it. Only what the app reads is typed; the rest passes through. */
export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  $ref?: string;
  definitions?: Record<string, JsonSchema>;
  [keyword: string]: unknown;
}

/** One operator type. */
export interface OperatorSchema {
  operatorType: string;
  jsonSchema: JsonSchema;
  additionalMetadata: OperatorInfo;
  operatorVersion: string;
}

/** A group of the operator menu, and the groups inside it. */
export interface OperatorGroup {
  groupName: string;
  children?: OperatorGroup[] | null;
}

export interface OperatorMetadata {
  operators: OperatorSchema[];
  groups: OperatorGroup[];
}

// The schemas carry keywords of Texera's own, which a strict validator would refuse.
const defaults = new Ajv({ useDefaults: true, strict: false });

/** The values a new operator of the type starts with: every default its schema names. */
export function defaultProperties(schema: OperatorSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  // Validating fills the defaults in; whether the empty operator is valid yet does not matter here.
  defaults.validate(schema.jsonSchema, properties);
  return properties;
}

/** A new operator of the type, not yet on any canvas. */
export function newOperator(schema: OperatorSchema, operatorID = newOperatorId(schema.operatorType)): Operator {
  const { inputPorts, outputPorts, dynamicInputPorts, dynamicOutputPorts, userFriendlyName } =
    schema.additionalMetadata;
  const port = (side: "input" | "output", index: number, info: InputPortInfo | OutputPortInfo): PortDescription => ({
    portID: `${side}-${index}`,
    displayName: info.displayName ?? "",
    disallowMultiInputs: "disallowMultiLinks" in info ? Boolean(info.disallowMultiLinks) : false,
    isDynamicPort: false,
  });
  return {
    operatorID,
    operatorType: schema.operatorType,
    operatorVersion: schema.operatorVersion,
    operatorProperties: defaultProperties(schema),
    inputPorts: inputPorts.map((info, index) => port("input", index, info)),
    outputPorts: outputPorts.map((info, index) => port("output", index, info)),
    dynamicInputPorts: Boolean(dynamicInputPorts),
    dynamicOutputPorts: Boolean(dynamicOutputPorts),
    showAdvanced: false,
    isDisabled: false,
    customDisplayName: userFriendlyName,
  };
}

/** Ids as the current frontend makes them, which the engine's messages then name operators by. */
export function newOperatorId(operatorType: string): string {
  return `${operatorType}-operator-${crypto.randomUUID()}`;
}

export function newLinkId(): string {
  return `link-${crypto.randomUUID()}`;
}
