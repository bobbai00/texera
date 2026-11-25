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

// The datasets and the models an operator reads: the versions that its settings name, by their paths, as the server
// reads the kind of setting each is in. A setting holds a path because of the kind of setting it is
// (property-schema.ts), or because a UDF's code says that a parameter takes a version (udf-parameters.ts), never
// because its value looks like one: a path without a prefix looks like any other.

import { parseResourcePath, type ResourcePath, resourcePath } from "@/lib/resource-path";
import type { Operator } from "./model";
import type { OperatorSchema } from "./operator-schema";
import { fieldKind, type PropertyField, visibleFields } from "./property-schema";
import { type UdfParameter, udfParametersProperty } from "./udf-parameters";

/**
 * The versions of datasets and models that an operator's settings name, each once, in the order of its settings,
 * with the file in it that the first setting to name it names, if that one names a file.
 */
export function resourcesOf(operator: Operator, schema: OperatorSchema): ResourcePath[] {
  const root = schema.jsonSchema;
  const values = operator.operatorProperties;
  const named = new Map<string, ResourcePath>();
  for (const field of visibleFields(root, root, values)) {
    for (const path of pathsIn(field, values[field.key])) {
      // Each by the path of its version, whatever file in it is named.
      const version = resourcePath(versionOf(path));
      if (!named.has(version)) named.set(version, path);
    }
  }
  return [...named.values()];
}

/**
 * The input types of a parameter that take a version of a resource, as the backend's contract has them
 * (common/workflow-operator/src/main/resources/udf/ui-parameter-types.json).
 */
const resourceInputTypes = new Set<unknown>(["dataset", "model"]);

/**
 * A UDF's parameters as they are kept, those kept as parameters are: each by its name, with a value of text, and
 * taking a version of a resource only where its input type names a kind of resource exactly, as the backend reads it
 * (UiUdfParameterContract): another input type takes none.
 */
export function keptParameters(parameters: unknown): UdfParameter[] {
  return (Array.isArray(parameters) ? (parameters as unknown[]) : []).flatMap(parameter => {
    const { attribute, value, inputType } = (parameter ?? {}) as Partial<UdfParameter>;
    if (typeof attribute?.attributeName !== "string" || attribute.attributeName === "" || typeof value !== "string") {
      return [];
    }
    return [{ attribute, value, ...(resourceInputTypes.has(inputType) && { inputType }) }];
  });
}

/** What the value of a setting names, as the server reads the kind of setting it is: nothing for most. */
function pathsIn(field: PropertyField, value: unknown): ResourcePath[] {
  // A parameter takes a version as a whole: a path that goes on to a file names none
  // (FileResolver.resolveRepositoryVersion).
  if (field.key === udfParametersProperty) {
    return keptParameters(value).flatMap(parameter => {
      const path = parameter.inputType ? parseResourcePath(parameter.value) : undefined;
      return path && !path.file ? [path] : [];
    });
  }
  const kind = fieldKind(field);
  if (typeof value !== "string" || (kind !== "datasetFile" && kind !== "datasetVersion")) return [];
  const path = parseResourcePath(value);
  // A scan reads a file, of a version of a dataset or of a model: a path that stops at the version names none
  // (FileResolver.resolveForUser).
  if (kind === "datasetFile") return path?.file ? [path] : [];
  // A lister lists a version of a dataset, as far as the version that the path names (LakeFSDatasetVersionLister).
  return path?.kind === "dataset" ? [versionOf(path)] : [];
}

/** The version a path names, without the file in it. */
function versionOf({ kind, owner, name, version }: ResourcePath): ResourcePath {
  return { kind, owner, name, version };
}
