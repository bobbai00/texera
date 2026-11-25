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

// What an operator's card says of its settings: each setting that says something, in the words a person would use,
// in the order of the form. A file is its name and a version its resource's name and its own, a list of conditions
// reads as it is written, code is the language it is written in, a password is never shown, and what is left at its
// default says nothing. Wherever else a value is shown in a short line, as in what a version changed, it reads as
// here, by its field where it has one (valueText).

import { parseResourcePath } from "@/lib/resource-path";
import { codeLanguage, codeLanguageNames, codeProperty } from "./code";
import { delimiterPresets } from "./delimiter";
import { sameValue } from "./diff";
import type { Operator } from "./model";
import type { JsonSchema, OperatorSchema } from "./operator-schema";
import { delimiterMode, fieldKind, fieldLabel, type PropertyField, resolve, visibleFields } from "./property-schema";
import { keptParameters } from "./resources";
import { udfParametersProperty } from "./udf-parameters";

/** One setting of an operator, as its card says it. */
export interface SettingLine {
  key: string;
  /** The setting's name, as the form names it. */
  label: string;
  /** What it is set to, to be read beside its name. */
  value: string;
  /** What it is set to, to be read without its name: a number or a switch says its name too, as "Limit 15". */
  short: string;
}

/** The field a value is read by: its key and its schema, which say what kind of value it is. */
type ValueField = Pick<PropertyField, "key" | "schema">;

/** No field: a value read by it reads as any other. */
const anyValue: ValueField = { key: "", schema: {} };

/** The settings of an operator that say something, in the order of the form. */
export function settingLines(operator: Operator, schema: OperatorSchema): SettingLine[] {
  const root = schema.jsonSchema;
  return visibleFields(root, root, operator.operatorProperties).flatMap((field): SettingLine[] => {
    const said = settingWords(operator, field, root);
    if (!said) return [];
    const label = fieldLabel(field);
    const value = shortened(said);
    const set = operator.operatorProperties[field.key];
    const short =
      typeof set === "number" ? `${label} ${value}` : typeof set === "boolean" ? (set ? label : `no ${label}`) : value;
    return [{ key: field.key, label, value, short }];
  });
}

/** The first two settings side by side, for a card that has one line for them: "biscoe.csv · Limit 15". */
export function summaryLine(lines: SettingLine[]): string {
  return lines
    .slice(0, 2)
    .map(line => line.short)
    .join(" · ");
}

/**
 * A value as it reads in a short line, as its card says it, read by its field where it has one: text as it is, a
 * number as it is written, a switch as yes or no, the items of a list one after another, and the values of a group
 * side by side; "not set" for no value, and a password as set or not set. A long one is shortened.
 */
export function valueText(value: unknown, field: ValueField = anyValue, root: JsonSchema = {}): string {
  if (fieldKind(field) === "password") return isEmpty(value) ? "not set" : "set";
  return shortened(words(value, field, root)) || "not set";
}

/**
 * A value that changed, as it read before and as it reads after, each as valueText reads it. Two that read alike, as
 * an empty list and a list of one empty row do, read as JSON writes them, so that what changed shows; a password
 * reads as set or not set all the same.
 */
export function changeTexts(
  before: unknown,
  after: unknown,
  field: ValueField = anyValue,
  root: JsonSchema = {}
): [string, string] {
  const texts: [string, string] = [valueText(before, field, root), valueText(after, field, root)];
  if (texts[0] !== texts[1] || fieldKind(field) === "password") return texts;
  return [writtenText(before), writtenText(after)];
}

/** What a setting of an operator says, in words; "" when it says nothing. */
function settingWords(operator: Operator, field: PropertyField, root: JsonSchema): string {
  const value = operator.operatorProperties[field.key];
  // A switch that is off and was never on by default says nothing, and neither does a value left at its default,
  // such as the code an operator came with.
  if (value === false && field.schema.default !== true) return "";
  if (field.schema.default !== undefined && sameValue(value, field.schema.default)) return "";
  const language = codeLanguage(operator.operatorType);
  // The code of an operator that holds code says the language it is written in, never what it says.
  if (language && field.key === codeProperty) {
    return typeof value === "string" && value !== "" ? `${codeLanguageNames[language]} code` : "";
  }
  if (field.key === udfParametersProperty) return parameterWords(value);
  return words(value, field, root);
}

/** A value in words, read as its field's schema says where it says something. "" when the value says nothing. */
function words(value: unknown, field: ValueField, root: JsonSchema): string {
  if (isEmpty(value)) return "";
  if (Array.isArray(value)) {
    const item = { key: field.key, schema: resolve(field.schema.items ?? {}, root) };
    return value
      .map(each => words(each, item, root))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "object") {
    const group = value as Record<string, unknown>;
    // The values side by side, as the form shows them where the schema says, as "medal = Gold".
    const fields = field.schema.properties
      ? visibleFields(field.schema, root, group)
      : Object.keys(group).map(key => ({ key, schema: {} }));
    return fields
      .map(each => words(group[each.key], each, root))
      .filter(Boolean)
      .join(" ");
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value);
  switch (fieldKind(field)) {
    case "datasetFile":
      return pathWords(text, "file");
    case "datasetVersion":
      return pathWords(text, "version");
    // A password says nothing: a short line says whether one is set (valueText), a card nothing at all.
    case "password":
      return "";
    case "delimiter":
      // Some delimiters, such as a tab, cannot be seen as they are: those read by their names.
      return delimiterPresets[delimiterMode(field.schema)].find(preset => preset.value === text)?.label ?? text;
    default:
      return text;
  }
}

/** A UDF's parameters that have a value, each by its name and its value: "count 5, weights resnet v3". */
function parameterWords(parameters: unknown): string {
  return keptParameters(parameters)
    .filter(({ value }) => value !== "")
    .map(
      ({ attribute, value, inputType }) =>
        `${attribute.attributeName} ${inputType ? pathWords(value, "version") : value}`
    )
    .join(", ");
}

/**
 * A path as a person names what it names, by the kind of setting that holds it: a file by its name, and a version by
 * its resource's name and its own, whatever follows it. What names no file where a file is read, or no version, by
 * its last part, as a file found already does.
 */
function pathWords(value: string, holds: "file" | "version"): string {
  const path = parseResourcePath(value);
  if (holds === "file") return lastPart(path?.file ?? value);
  return path ? `${path.name} ${path.version}` : lastPart(value);
}

function lastPart(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** A value as JSON writes it, in a short line: "not set" for no value. */
function writtenText(value: unknown): string {
  return value === undefined ? "not set" : shortened(JSON.stringify(value));
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** A text cut short to fit a short line. */
function shortened(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
