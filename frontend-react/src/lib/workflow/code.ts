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

// Operators whose work is written as code: the user-defined functions. Their schemas do not say that a property
// holds code, or in which language, so this table does. It is the one place that knows.

export type CodeLanguage = "python" | "r" | "java";

const languages = new Map<string, CodeLanguage>([
  ["PythonUDFV2", "python"],
  ["PythonUDFSourceV2", "python"],
  ["DualInputPortsPythonUDFV2", "python"],
  ["RUDF", "r"],
  ["RUDFSource", "r"],
  ["JavaUDF", "java"],
]);

/** The property of such an operator that holds its code. */
export const codeProperty = "code";

/** The language an operator type's code is written in. Undefined for an operator type without code. */
export function codeLanguage(operatorType: string): CodeLanguage | undefined {
  return languages.get(operatorType);
}

/** What each language is called. */
export const codeLanguageNames: Record<CodeLanguage, string> = { python: "Python", r: "R", java: "Java" };
