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

// What the compiling service says about a workflow (POST /compile, WorkflowCompilationResource.scala): the
// columns each operator puts out, and why an operator cannot be compiled. The editor offers those columns where
// a property names a column, and marks the operators that do not compile.

import { type Link, portIndex } from "./model";

/** A column of an operator's input or output (Attribute.java). */
export interface Attribute {
  attributeName: string;
  attributeType: string;
}

/** The service's answer. A port's key is its place and whether it is internal, such as "0_false". */
export interface CompilationAnswer {
  operatorOutputSchemas?: Record<string, Record<string, Attribute[] | null>>;
  operatorErrors?: Record<string, { message?: string; details?: string }>;
}

/** The columns on each port of each operator, by the operator's id and the port's place. Undefined while unknown. */
export type PortSchemas = Record<string, (Attribute[] | undefined)[]>;

export interface Compilation {
  /** The columns each operator puts out on each output port. */
  outputSchemas: PortSchemas;
  /** Why an operator does not compile, in words meant for people. */
  errors: Record<string, string>;
}

export const noCompilation: Compilation = { outputSchemas: {}, errors: {} };

/** Reads the service's answer: what each operator puts out, and why one does not compile. */
export function readCompilation(answer: CompilationAnswer): Compilation {
  const outputSchemas: PortSchemas = {};
  for (const [operatorId, ports] of Object.entries(answer.operatorOutputSchemas ?? {})) {
    outputSchemas[operatorId] = [];
    for (const [key, schema] of Object.entries(ports))
      outputSchemas[operatorId][Number(key.split("_")[0])] = schema ?? undefined;
  }
  const errors: Compilation["errors"] = {};
  for (const [operatorId, error] of Object.entries(answer.operatorErrors ?? {})) {
    errors[operatorId] = readableError(error.message || error.details || "");
  }
  return { outputSchemas, errors };
}

/**
 * The columns that arrive at each input port of each operator: what the operator before it puts out. An operator
 * need not compile itself to be told what arrives, so one that is not complete yet is still offered its columns.
 */
export function inputSchemas(links: Link[], outputSchemas: PortSchemas): PortSchemas {
  const arriving: PortSchemas = {};
  for (const { source, target } of links) {
    arriving[target.operatorID] ??= [];
    // Several links into one port carry the same columns, so the first one says what arrives.
    arriving[target.operatorID][portIndex(target.portID).index] ??=
      outputSchemas[source.operatorID]?.[portIndex(source.portID).index];
  }
  return arriving;
}

/**
 * The part of an engine error that is meant for people. Errors arrive as the text of a Java exception, such as
 * "java.lang.RuntimeException: Operator is not configured properly: requirement failed: Each sort key must have
 * an attribute selected."
 */
export function readableError(message: string): string {
  let text = message.trim();
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text
      .replace(/^[\w.$]+(?:Exception|Error)(?::\s*|$)/, "")
      .replace(/^(?:Operator is not configured properly|requirement failed):\s*/i, "");
  }
  // A bare exception, such as a MatchError on a missing value, says nothing a person can use.
  if (!text || /^null$/i.test(text)) return "Some settings are missing or not valid.";
  return text.charAt(0).toUpperCase() + text.slice(1);
}
