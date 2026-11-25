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

// The parameters a Python UDF declares in its code, each as self.UiParameter(name, type) in its one UDF class,
// optionally with value=Resource.DATASET or Resource.MODEL. The user gives each a value in the operator's
// properties, under uiParameters, and the engine hands the values to the code by name. The code is read with the
// same grammar that highlights it, so a comment or a string is never taken for a declaration.

import { parser } from "@lezer/python";

/** The property in which an operator's parameters and their values are kept. */
export const udfParametersProperty = "uiParameters";

export type ParameterType = "string" | "integer" | "long" | "double" | "boolean" | "timestamp";

/** One parameter, as it is kept among the operator's properties (UiUDFParameter in the operator's schema). */
export interface UdfParameter {
  attribute: { attributeName: string; attributeType: ParameterType };
  value: string;
  /** A parameter whose value is a version of a resource: then the value is the version's path. */
  inputType?: "dataset" | "model";
}

/**
 * How each type is written in Python, the first as the app writes it, as the backend's contract has them
 * (common/workflow-operator/src/main/resources/udf/ui-parameter-types.json).
 */
const typeNames: Record<ParameterType, string[]> = {
  string: ["STRING"],
  integer: ["INT", "INTEGER"],
  long: ["LONG"],
  double: ["DOUBLE"],
  boolean: ["BOOL", "BOOLEAN"],
  timestamp: ["TIMESTAMP"],
};
export const parameterTypes = Object.keys(typeNames) as ParameterType[];
const typesByName = new Map(
  Object.entries(typeNames).flatMap(([type, names]) => names.map(name => [name, type as ParameterType]))
);
const resources: Record<string, UdfParameter["inputType"]> = { DATASET: "dataset", MODEL: "model" };

/** The classes of the UDF templates (PythonUDFOpDescV2 and its kin): the one the code defines holds the UDF. */
const udfClasses = new Set([
  "ProcessTupleOperator",
  "ProcessBatchOperator",
  "ProcessTableOperator",
  "GenerateOperator",
]);

/** Hard keywords, which an attribute cannot be named; soft ones, such as match, can. */
const keywords = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except finally for from " +
    "global if import in is lambda nonlocal not or pass raise return try while with yield"
  ).split(" ")
);

type SyntaxNode = ReturnType<typeof parser.parse>["topNode"];

/** The parameters, or what keeps them from being read. */
export type Declared = { parameters: UdfParameter[] } | { problem: string };

/**
 * The parameters the code declares, in the order it declares them. Each keeps the value it has among the
 * current ones while its name and the kind of resource it names stay the same.
 */
export function declaredParameters(code: string, current: UdfParameter[]): Declared {
  const found = udfClass(code);
  if ("problem" in found) return found;
  const parameters = found.node ? declarations(found.node, code) : [];
  const names = new Set<string>();
  for (const { attribute } of parameters) {
    if (names.has(attribute.attributeName)) {
      return { problem: `The parameter ${attribute.attributeName} is declared more than once.` };
    }
    names.add(attribute.attributeName);
  }
  const key = (parameter: UdfParameter) => `${parameter.attribute.attributeName}:${parameter.inputType ?? ""}`;
  const values = new Map(current.map(parameter => [key(parameter), parameter.value]));
  return { parameters: parameters.map(parameter => ({ ...parameter, value: values.get(key(parameter)) ?? "" })) };
}

/**
 * What to insert into the code, and where, to declare one more parameter: at the start of the UDF class's
 * open(), which is written if the class has none.
 */
export function parameterDeclaration(
  code: string,
  name: string,
  type: ParameterType
): { offset: number; text: string } | { problem: string } {
  const attributeName = name.trim();
  if (!attributeName) return { problem: "A parameter needs a name." };
  const found = udfClass(code);
  if ("problem" in found) return found;
  if (!found.node) return { problem: "There is no UDF class, such as ProcessTupleOperator, to declare it in." };
  if (declarations(found.node, code).some(parameter => parameter.attribute.attributeName === attributeName)) {
    return { problem: `The parameter ${attributeName} is declared already.` };
  }
  const declaration =
    `self.${pythonName(attributeName)} = ` +
    `self.UiParameter(name=${JSON.stringify(attributeName)}, type=AttributeType.${typeNames[type][0]}).value`;
  const open = methodNamed(found.node, code, "open");
  if (open) return atBodyStart(code, open, [declaration]);
  const decorator = /^\s*@overrides\b/m.test(code) ? ["@overrides"] : [];
  return atBodyStart(code, found.node, [...decorator, "def open(self) -> None:", `    ${declaration}`]);
}

/** The one UDF class of the code, if it has one. Two are a problem: which one's parameters would count? */
function udfClass(code: string): { node?: SyntaxNode } | { problem: string } {
  const classes: SyntaxNode[] = [];
  parser.parse(code).iterate({
    enter: ({ name, node }) => {
      const className = name === "ClassDefinition" ? node.getChild("VariableName") : null;
      if (!className || !udfClasses.has(code.slice(className.from, className.to))) return;
      classes.push(node);
      return false;
    },
  });
  if (classes.length > 1) return { problem: "Only one UDF class may declare parameters." };
  return { node: classes[0] };
}

/** Every self.UiParameter(...) in the class that says what it declares; one it cannot read is left out. */
function declarations(udf: SyntaxNode, code: string): UdfParameter[] {
  const found: UdfParameter[] = [];
  udf.cursor().iterate(cursor => {
    if (cursor.name !== "CallExpression") return;
    const parameter = declarationIn(cursor.node, code);
    if (parameter) found.push(parameter);
    return false;
  });
  return found;
}

function declarationIn(call: SyntaxNode, code: string): UdfParameter | undefined {
  const callee = call.getChild("MemberExpression");
  const argumentList = call.getChild("ArgList");
  if (!argumentList || memberPath(callee, code)?.join(".") !== "self.UiParameter") return undefined;
  let attributeName: string | undefined;
  let attributeType: ParameterType | undefined;
  let inputType: UdfParameter["inputType"];
  const positional = ["name", "type"];
  let named = false;
  for (const { key, value } of callArguments(argumentList, code)) {
    // A positional argument after a named one is not Python.
    if (key) named = true;
    else if (named) return undefined;
    const which = key ?? positional.shift();
    if (which === "name" && attributeName === undefined) attributeName = stringIn(value, code);
    else if ((which === "type" || which === "attr_type") && attributeType === undefined) {
      const path = memberPath(value, code);
      attributeType =
        path?.length === 2 && path[0] === "AttributeType" ? typesByName.get(path[1].toUpperCase()) : undefined;
    } else if (which === "value" && inputType === undefined) {
      const path = memberPath(value, code);
      inputType = path?.length === 2 && path[0] === "Resource" ? resources[path[1].toUpperCase()] : undefined;
      if (!inputType) return undefined;
    } else return undefined;
  }
  // What a resource's parameter is given is the path of a version, which is text.
  if (!attributeName || !attributeType || (inputType && attributeType !== "string")) return undefined;
  return { attribute: { attributeName, attributeType }, value: "", ...(inputType && { inputType }) };
}

/** The arguments of a call, each with its keyword if it has one. */
function callArguments(argumentList: SyntaxNode, code: string): { key?: string; value: SyntaxNode }[] {
  const parts = children(argumentList).filter(node => !["(", ")", ","].includes(node.name));
  const found: { key?: string; value: SyntaxNode }[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const node = parts[index];
    if (node.name === "VariableName" && parts[index + 1]?.name === "AssignOp" && parts[index + 2]) {
      found.push({ key: code.slice(node.from, node.to), value: parts[index + 2] });
      index += 2;
    } else found.push({ value: node });
  }
  return found;
}

function stringIn(node: SyntaxNode, code: string): string | undefined {
  if (node.name !== "String") return undefined;
  const quoted = code
    .slice(node.from, node.to)
    .match(/^[rRuU]?(?:"""([\s\S]*)"""|'''([\s\S]*)'''|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')$/);
  return (
    quoted
      ?.slice(1)
      .find(part => part !== undefined)
      ?.trim() || undefined
  );
}

/** a.b.c as ["a", "b", "c"], for a member expression. */
function memberPath(node: SyntaxNode | null, code: string): string[] | undefined {
  if (node?.name !== "MemberExpression") return undefined;
  const parts = children(node)
    .filter(child => child.name === "VariableName" || child.name === "PropertyName")
    .map(child => code.slice(child.from, child.to));
  return parts.length > 0 ? parts : undefined;
}

function methodNamed(udf: SyntaxNode, code: string, name: string): SyntaxNode | undefined {
  const body = udf.getChild("Body");
  for (const statement of body ? children(body) : []) {
    // A method with a decorator is a DecoratedStatement around its definition.
    const definition = statement.name === "FunctionDefinition" ? statement : statement.getChild("FunctionDefinition");
    const defined = definition?.getChild("VariableName");
    if (definition && defined && code.slice(defined.from, defined.to) === name) return definition;
  }
  return undefined;
}

/**
 * Lines to insert at the start of a class's or a method's body, indented as the body is, after its docstring if it
 * has one. A body with nothing in it yet but comments gets them right after its header.
 */
function atBodyStart(code: string, definition: SyntaxNode, lines: string[]): { offset: number; text: string } {
  const body = definition.getChild("Body");
  // "⚠" is what the grammar makes of a body whose statements are all commented out.
  const statements = body ? children(body).filter(child => ![":", "Comment", "⚠"].includes(child.name)) : [];
  const first = statements.at(0);
  if (body && first && code.slice(body.from, first.from).includes("\n")) {
    const indent = indentationAt(code, first.from);
    const docstring = first.name === "ExpressionStatement" && first.getChild("String") !== null;
    if (docstring) {
      const block = lines.map(line => `${indent}${line}`).join("\n");
      return { offset: lineEnd(code, first.to - 1), text: `\n${lines.length > 1 ? "\n" : ""}${block}` };
    }
    const block = lines.map(line => `${indent}${line}\n`).join("");
    // A method that is written anew is set apart from what follows it by an empty line.
    return { offset: lineStart(code, first.from), text: lines.length > 1 ? `${block}\n` : block };
  }
  const indent = `${indentationAt(code, definition.from)}    `;
  return { offset: lineEnd(code, body?.from ?? definition.to), text: lines.map(line => `\n${indent}${line}`).join("") };
}

/** A name as a Python attribute can have it. */
function pythonName(name: string): string {
  const identifier = name.replace(/\W/g, "_").replace(/^(?=\d)/, "_") || "parameter";
  return keywords.has(identifier) ? `${identifier}_` : identifier;
}

function children(node: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) found.push(child);
  return found;
}

function lineStart(code: string, position: number): number {
  return code.lastIndexOf("\n", position - 1) + 1;
}

function lineEnd(code: string, position: number): number {
  const newline = code.indexOf("\n", position);
  return newline === -1 ? code.length : newline;
}

function indentationAt(code: string, position: number): string {
  return /^[ \t]*/.exec(code.slice(lineStart(code, position), position))?.[0] ?? "";
}
