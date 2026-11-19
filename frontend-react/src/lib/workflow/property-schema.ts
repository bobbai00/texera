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

// How an operator type's JSON schema becomes a form. The schemas are plain draft-07 (objects, arrays, strings,
// numbers, booleans, enums, $ref) with a few keywords of Texera's own, which are read here and nowhere else:
//   autofill, autofillAttributeOnPort   the value is a column of an input port, or a list of columns
//   hideTarget, hideType, hideExpectedValue, hideOnNull   a field is hidden by the value of a sibling
//   toggleHidden   a switch that hides the siblings it names while it is off
//   widget.formlyConfig   a long text, a password, or a delimiter
//   allOf, if, then, else   a property is needed only while another has some value
//   attributeTypeRules   the types that the column a property names is expected to have
//   additionalEnumValue   one more choice beside the columns, such as "Add New Column"
// A few properties are something their schema does not say, and are known by their name: see kindsByName and
// amendments.
// A hidden field's rule looks at the values beside it, so in a list of rows each row decides for itself.

import type { Attribute } from "./compilation";
import type { DelimiterMode } from "./delimiter";
import type { JsonSchema } from "./operator-schema";

/** One field of a form: a property of an object, with its schema resolved. */
export interface PropertyField {
  key: string;
  schema: JsonSchema;
  required: boolean;
}

/** The kind of control a field is edited with. */
export type FieldKind =
  | "text"
  | "longText"
  | "password"
  | "number"
  | "switch"
  | "choice"
  | "column"
  | "columns"
  | "choices"
  | "texts"
  | "rows"
  | "group"
  | "datasetFile"
  | "datasetVersion"
  | "delimiter"
  | "unknown";

/**
 * What a text property holds where its schema does not say. The backend marks these by their name alone, in
 * every operator type that has one.
 */
const kindsByName = new Map<string, FieldKind>([
  // The path of a file in a version of a dataset: what the operators that read a file read.
  ["fileName", "datasetFile"],
  // The path of a version of a dataset, as a whole.
  ["datasetVersionPath", "datasetVersion"],
]);

/** What a property's schema leaves out, by the property's name, said in the schema's own keywords. */
const amendments = new Map<string, JsonSchema>([
  // A UDF names a Python environment of its own only when it does not use the default one.
  ["envName", { hideTarget: "defaultEnv", hideType: "equals", hideExpectedValue: "true" }],
]);

/** A property that is needed only while others have certain values: {if: {properties: {x: {const}}}, then, else}. */
interface Conditional {
  if?: { properties?: Record<string, JsonSchema> };
  then?: JsonSchema;
  else?: JsonSchema;
}

/** Properties that every operator type has for the engine's own tests, not for people. */
const hiddenKeys = new Set(["dummyPropertyList"]);

/** The schema a $ref points to, among the root schema's definitions. A schema without one is itself. */
export function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.slice(schema.$ref.lastIndexOf("/") + 1);
  // What the property says beside the reference, such as its title, stays.
  const resolved = { ...root.definitions?.[name], ...schema };
  delete resolved.$ref;
  return resolved;
}

/** The fields of an object to show for its current values, in the order the backend gives them. */
export function visibleFields(schema: JsonSchema, root: JsonSchema, values: Record<string, unknown>): PropertyField[] {
  const properties = Object.entries(schema.properties ?? {})
    .filter(([key]) => !hiddenKeys.has(key))
    .map(([key, property]): [string, JsonSchema] => [key, { ...amendments.get(key), ...property }]);
  const required = requiredFor(schema, values);
  const switchedOff = new Set(
    properties.flatMap(([key, property]) =>
      values[key] ? [] : ((property.toggleHidden as string[] | undefined) ?? [])
    )
  );
  return properties
    .filter(([key, property]) => !switchedOff.has(key) && !hiddenBySibling(property, values))
    .toSorted(([, a], [, b]) => order(a) - order(b))
    .map(([key, property]) => ({
      key,
      schema: resolve(property, root),
      required: required.has(key),
    }));
}

/** The properties an object needs for the values it has: always, or because of the value of another property. */
function requiredFor(schema: JsonSchema, values: Record<string, unknown>): Set<string> {
  const required = new Set(schema.required);
  for (const { if: condition, then, else: otherwise } of (schema.allOf ?? []) as Conditional[]) {
    const expected = Object.entries(condition?.properties ?? {}).filter(([, property]) => "const" in property);
    if (expected.length === 0) continue;
    const met = expected.every(([key, property]) => values[key] === property.const);
    for (const key of (met ? then : otherwise)?.required ?? []) required.add(key);
  }
  return required;
}

function order(schema: JsonSchema): number {
  return typeof schema.propertyOrder === "number" ? schema.propertyOrder : Number.MAX_SAFE_INTEGER;
}

function hiddenBySibling(schema: JsonSchema, values: Record<string, unknown>): boolean {
  const { hideTarget, hideType, hideExpectedValue, hideOnNull } = schema;
  if (typeof hideTarget !== "string") return false;
  const sibling = values[hideTarget];
  if (sibling === null || sibling === undefined) return hideOnNull === true;
  // The rules are about text, numbers and switches, each compared as the text it reads as.
  const text = typeof sibling === "string" ? sibling : JSON.stringify(sibling);
  const expected = String(hideExpectedValue);
  return hideType === "regex" ? new RegExp(`^(${expected})$`).test(text) : text === expected;
}

/** Which control edits a field. */
export function fieldKind({ key, schema }: Pick<PropertyField, "key" | "schema">): FieldKind {
  const widget = (
    schema.widget as { formlyConfig?: { type?: string; templateOptions?: { type?: string } } } | undefined
  )?.formlyConfig;
  if (schema.type === "array") {
    if (schema.autofill === "attributeNameList") return "columns";
    const items = schema.items ?? {};
    if (items.enum) return "choices";
    if (items.type === "string") return "texts";
    return items.$ref || items.type === "object" ? "rows" : "unknown";
  }
  if (schema.autofill === "attributeName") return "column";
  if (schema.enum) return "choice";
  if (schema.type === "boolean") return "switch";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "object") return "group";
  if (schema.type === "string") {
    const named = kindsByName.get(key);
    if (named) return named;
    if (widget?.type === "delimiter") return "delimiter";
    if (widget?.type === "textarea") return "longText";
    if (widget?.templateOptions?.type === "password") return "password";
    return "text";
  }
  return "unknown";
}

/** Whether a delimiter is one character or a regular expression. */
export function delimiterMode(schema: JsonSchema): DelimiterMode {
  const widget = schema.widget as { formlyConfig?: { props?: { delimiterMode?: string } } } | undefined;
  return widget?.formlyConfig?.props?.delimiterMode === "regex" ? "regex" : "char";
}

/** The choice a field offers beside the columns of its input, such as "Add New Column". */
export function extraChoice(schema: JsonSchema): string | undefined {
  return typeof schema.additionalEnumValue === "string" ? schema.additionalEnumValue : undefined;
}

/** The columns a field can name: those arriving at the input port the schema points to. Undefined while unknown. */
export function columnChoices(schema: JsonSchema, inputSchemas: (Attribute[] | undefined)[]): Attribute[] | undefined {
  const port = typeof schema.autofillAttributeOnPort === "number" ? schema.autofillAttributeOnPort : 0;
  return inputSchemas[port];
}

/**
 * The first column that the properties name and the input does not have. Undefined when every column they name
 * arrives, and while the input's columns are not known.
 */
export function missingColumn(
  schema: JsonSchema,
  root: JsonSchema,
  values: Record<string, unknown>,
  inputSchemas: (Attribute[] | undefined)[]
): string | undefined {
  for (const { key, schema: field } of visibleFields(schema, root, values)) {
    const value = values[key];
    const kind = fieldKind({ key, schema: field });
    if (kind === "column" || kind === "columns") {
      const columns = columnChoices(field, inputSchemas)?.map(column => column.attributeName);
      const named = (kind === "column" ? [value] : Array.isArray(value) ? value : []).filter(
        (name): name is string => typeof name === "string" && name !== ""
      );
      const missing = columns && named.find(name => !columns.includes(name) && name !== extraChoice(field));
      if (missing !== undefined) return missing;
    }
    const inner =
      kind === "rows" && Array.isArray(value)
        ? { schema: resolve(field.items ?? {}, root), each: value as Record<string, unknown>[] }
        : kind === "group" && value
          ? { schema: field, each: [value as Record<string, unknown>] }
          : undefined;
    for (const values of inner?.each ?? []) {
      const missing = missingColumn(inner!.schema, root, values, inputSchemas);
      if (missing !== undefined) return missing;
    }
  }
  return undefined;
}

/** What the type of the column a property names is expected to be (attributeTypeRules). */
interface ColumnTypeRule {
  /** One of these types. */
  enum?: string[];
  /** The type of the column that another property names. */
  const?: { $data: string };
  /** One of some types, while another property has one of some values. */
  allOf?: { if: Record<string, { valEnum: unknown[] }>; then: { enum: string[] } }[];
}

/**
 * What is unexpected about the type of a column that a property names, by that property. It is a warning: the
 * operator may still be executed, and the engine says whether it takes the column.
 */
export function columnTypeWarnings(
  schema: JsonSchema,
  values: Record<string, unknown>,
  inputSchemas: (Attribute[] | undefined)[]
): Record<string, string> {
  /** The columns a property names, with the types the input gives them. */
  const named = (key: string): Attribute[] => {
    const columns = columnChoices(schema.properties?.[key] ?? {}, inputSchemas) ?? [];
    const names: unknown[] = Array.isArray(values[key]) ? (values[key] as unknown[]) : [values[key]];
    return names.flatMap(name => columns.filter(column => column.attributeName === name));
  };
  const unexpected = (rule: ColumnTypeRule, { attributeName, attributeType }: Attribute): string | undefined => {
    const is = `The type of "${attributeName}" is ${attributeType}`;
    if (rule.enum && !rule.enum.includes(attributeType)) return `${is}, but ${oneOf(rule.enum)} is expected.`;
    const [other] = rule.const ? named(rule.const.$data) : [];
    if (other && other.attributeType !== attributeType) {
      return `${is}, but "${other.attributeName}" is ${other.attributeType}: the two are expected to be the same.`;
    }
    for (const { if: condition, then } of rule.allOf ?? []) {
      for (const [sibling, { valEnum }] of Object.entries(condition)) {
        if (valEnum.includes(values[sibling]) && !then.enum.includes(attributeType)) {
          const title = schema.properties?.[sibling]?.title ?? sibling;
          return `${is}, but ${oneOf(then.enum)} is expected while ${title} is ${String(values[sibling])}.`;
        }
      }
    }
    return undefined;
  };
  const warnings: Record<string, string> = {};
  for (const [key, rule] of Object.entries((schema.attributeTypeRules ?? {}) as Record<string, ColumnTypeRule>)) {
    const warning = named(key)
      .map(column => unexpected(rule, column))
      .find(found => found !== undefined);
    if (warning) warnings[key] = warning;
  }
  return warnings;
}

/** A list in words: "integer", "integer or long", "integer, long or double". */
function oneOf(types: string[]): string {
  return types.length < 2 ? types.join() : `${types.slice(0, -1).join(", ")} or ${types.at(-1)}`;
}

/** The name a field is shown under. */
export function fieldLabel({ key, schema }: PropertyField): string {
  return schema.title ?? key;
}
