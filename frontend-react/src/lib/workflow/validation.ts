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

// Whether an operator can be executed as it is: its properties fit its type's schema, every input port has a
// link, and every column it names arrives at it. The canvas marks the operators that cannot, and an execution is
// not started while there is one.

import Ajv, { type ValidateFunction } from "ajv";
import type { PortSchemas } from "./compilation";
import type { WorkflowContent } from "./model";
import type { JsonSchema, OperatorSchema } from "./operator-schema";
import { missingColumn } from "./property-schema";

// The schemas carry keywords of Texera's own, which a strict validator would refuse.
const ajv = new Ajv({ strict: false });
const validators = new WeakMap<JsonSchema, ValidateFunction>();

/** Why each operator that cannot be executed cannot, by its id. Disabled operators are not executed, so not checked. */
export function operatorProblems(
  content: WorkflowContent,
  schemas: Map<string, OperatorSchema>
): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const operator of content.operators) {
    if (operator.isDisabled) continue;
    const schema = schemas.get(operator.operatorType);
    if (!schema) {
      problems[operator.operatorID] = `This server has no operator type ${operator.operatorType}.`;
      continue;
    }
    const linked = new Set(
      content.links.filter(link => link.target.operatorID === operator.operatorID).map(link => link.target.portID)
    );
    const problem = propertyProblem(schema.jsonSchema, operator.operatorProperties);
    if (problem) problems[operator.operatorID] = problem;
    else if (operator.inputPorts.some(port => !linked.has(port.portID))) {
      problems[operator.operatorID] = "An input port has no link.";
    }
  }
  return problems;
}

/**
 * The operators that name a column their input does not have, such as one that was renamed in the operator
 * before. The compiling service does not say so; the execution would fail on it.
 */
export function columnProblems(
  content: WorkflowContent,
  schemas: Map<string, OperatorSchema>,
  inputSchemas: PortSchemas
): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const operator of content.operators) {
    const schema = schemas.get(operator.operatorType)?.jsonSchema;
    if (!schema || operator.isDisabled) continue;
    const column = missingColumn(schema, schema, operator.operatorProperties, inputSchemas[operator.operatorID] ?? []);
    if (column !== undefined) problems[operator.operatorID] = `The input has no column "${column}".`;
  }
  return problems;
}

/** What is wrong with the first property that does not fit the schema, named as the form names it. */
function propertyProblem(schema: JsonSchema, properties: Record<string, unknown>): string | undefined {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  if (validate(properties)) return undefined;
  const [error] = validate.errors ?? [];
  const missing =
    error.keyword === "required" ? (error.params as { missingProperty: string }).missingProperty : undefined;
  const key = missing ?? error.instancePath.split("/")[1] ?? "";
  const title = schema.properties?.[key]?.title ?? key;
  if (missing) return `${title} is not set.`;
  return title ? `${title} ${error.message ?? "is not valid"}.` : "Some settings are not valid.";
}
