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

/**
 * System prompts for Texera Agent Service.
 */

import { OperatorMetadataStore, ALLOWED_OPERATOR_TYPES } from "../tools/metadata-tools";

/**
 * Base system prompt for the Texera Copilot agent.
 * Used directly for CODE mode, extended with operator schemas for GENERAL mode.
 */
export const BASE_SYSTEM_PROMPT = `# Texera Copilot
You are a data science Copilot helping users solve data-centric questions using the dataflow.

## Dataflow Semantics Guidelines

**Think in dataflow** - data flows from sources through transformations to results

**Each operator should do ONE thing, link multiple operators into Chain, Tree or Graphs to do complex analysis & maximize the result reuse**,

**Build dataflow incrementally** - whenever you want to do a data transformation, TRY TO reuse existing operators and link new operators to existing operators.

**Use workflow's execution result to understand the document and data**

**Reduce the size of execution result**: to avoid token overflow, use operations like sampling or retrieving meta information to reduce the execution result size
`;

/**
 * Build the operator schemas string for allowed operators.
 * @param metadataStore - The operator metadata store
 * @returns Formatted string of operator schemas
 */
export function buildAllowedOperatorSchemas(metadataStore: OperatorMetadataStore): string {
  const schemas: string[] = [];

  for (const operatorType of ALLOWED_OPERATOR_TYPES) {
    const compactSchema = metadataStore.getCompactSchema(operatorType);
    const description = metadataStore.getDescription(operatorType);

    if (compactSchema) {
      schemas.push(
        `## ${operatorType}\n` +
          (description ? `Description: ${description}\n` : "") +
          `Schema:\n\`\`\`json\n${JSON.stringify(compactSchema, null, 2)}\n\`\`\``
      );
    }
  }

  return schemas.length > 0 ? schemas.join("\n\n") : "No operators available.";
}

/**
 * Build the complete system prompt for GENERAL mode with operator schemas.
 * @param metadataStore - The operator metadata store
 * @returns Complete system prompt with operator schemas appended
 */
export function buildGeneralModeSystemPrompt(metadataStore: OperatorMetadataStore): string {
  const operatorSchemas = buildAllowedOperatorSchemas(metadataStore);
  return (
    BASE_SYSTEM_PROMPT +
    "\n## Available Operators\nYou have the following operators available:\n" +
    operatorSchemas
  );
}
