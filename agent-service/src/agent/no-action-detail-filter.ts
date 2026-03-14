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
 * No-action-detail filter.
 *
 * When enabled, replaces the code/properties fields in definition tool-call
 * arguments with a short placeholder. This forces the agent to reason about
 * operator semantics (via the summary field) and lineage rather than
 * low-level code details, saving tokens in the process.
 */

import type { ModelMessage } from "ai";
import { TOOL_NAME_CREATE_OR_MODIFY_OPERATOR } from "../tools/code-op-tools";
import { TOOL_NAME_ADD_OPERATOR, TOOL_NAME_MODIFY_OPERATOR } from "../tools/general-op-tools";
import { TOOL_NAME_GET_CURRENT_WORKFLOW } from "../tools/workflow-tools";

const ACTION_DETAIL_PLACEHOLDER =
  "(Details skipped; please focus on the operator's summary to understand the semantics of the operator.)";

/** Tool names whose args contain implementation details we want to redact. */
const DEFINITION_TOOLS = new Set([
  TOOL_NAME_CREATE_OR_MODIFY_OPERATOR,
  TOOL_NAME_ADD_OPERATOR,
  TOOL_NAME_MODIFY_OPERATOR,
]);

/**
 * Regex matching the `Properties: {...}` line in getCurrentWorkflow output.
 * Replaces the JSON value while keeping the field label.
 */
const PROPERTIES_LINE_REGEX = /^\tProperties: .+$/gm;

/**
 * Replace code/properties fields in **older** definition tool-call arguments
 * with a placeholder, and redact Properties lines from getCurrentWorkflow results.
 *
 * The **latest** definition call for each operator is kept intact so the LLM
 * can see (and modify) the current code. Only superseded calls are redacted.
 *
 * This forces the agent to reason about operator semantics (via the summary
 * field) and lineage rather than low-level code details, saving tokens.
 */
export function redactActionDetails(messages: ModelMessage[]): ModelMessage[] {
  let redactCallCount = 0;
  let redactResultCount = 0;

  // --- Pre-scan: find definition toolCallIds in the LAST assistant message ---
  // Only keep definitions from the most recent step intact. Everything older
  // gets redacted. This ensures the LLM can see/modify code it just wrote,
  // while all earlier definitions are replaced with placeholders.
  const lastStepDefCallIds = new Set<string>();

  // Build toolCallId → { toolName, operatorId } map at the same time
  const toolCallMap = new Map<string, { toolName: string; operatorId?: string }>();

  // Find the last assistant message index
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && Array.isArray(messages[i].content)) {
      lastAssistantIdx = i;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as any[]) {
      if (part.type !== "tool-call") continue;
      const args = part.args || part.input || {};
      toolCallMap.set(part.toolCallId, { toolName: part.toolName, operatorId: args.operatorId });
      // Keep definitions from the last assistant message intact
      if (i === lastAssistantIdx && DEFINITION_TOOLS.has(part.toolName)) {
        lastStepDefCallIds.add(part.toolCallId);
      }
    }
  }

  // --- Main pass: redact older definition calls and getCurrentWorkflow results ---
  const result: ModelMessage[] = messages.map(msg => {
    // Redact tool-call args in assistant messages (skip last step's definitions)
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      let modified = false;
      const newContent = (msg.content as any[]).map(part => {
        if (part.type !== "tool-call" || !DEFINITION_TOOLS.has(part.toolName)) return part;
        // Keep definitions from the last step intact
        if (lastStepDefCallIds.has(part.toolCallId)) return part;

        const args = part.args || part.input || {};

        // createOrModifyOperator: replace the `code` field
        if (part.toolName === TOOL_NAME_CREATE_OR_MODIFY_OPERATOR && args.code !== undefined) {
          modified = true;
          redactCallCount++;
          const newArgs = { ...args, code: ACTION_DETAIL_PLACEHOLDER };
          return part.args !== undefined
            ? { ...part, args: newArgs }
            : { ...part, input: newArgs };
        }

        // addOperator / modifyOperator: replace the `properties` field
        if (
          (part.toolName === TOOL_NAME_ADD_OPERATOR || part.toolName === TOOL_NAME_MODIFY_OPERATOR) &&
          args.properties !== undefined
        ) {
          modified = true;
          redactCallCount++;
          const newArgs = { ...args, properties: ACTION_DETAIL_PLACEHOLDER };
          return part.args !== undefined
            ? { ...part, args: newArgs }
            : { ...part, input: newArgs };
        }

        return part;
      });

      return modified ? { ...msg, content: newContent } : msg;
    }

    // Redact Properties lines in getCurrentWorkflow tool results
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      let modified = false;
      const newContent = (msg.content as any[]).map(part => {
        if (part.type !== "tool-result") return part;

        const info = toolCallMap.get(part.toolCallId);
        if (!info || info.toolName !== TOOL_NAME_GET_CURRENT_WORKFLOW) return part;

        // Extract the result string
        const rawResult = part.result ?? part.output;
        let resultStr: string;
        if (typeof rawResult === "string") {
          resultStr = rawResult;
        } else if (rawResult && typeof rawResult === "object" && rawResult.value !== undefined) {
          resultStr = String(rawResult.value);
        } else {
          return part;
        }

        // Replace Properties lines with placeholder
        const redacted = resultStr.replace(
          PROPERTIES_LINE_REGEX,
          `\tProperties: ${ACTION_DETAIL_PLACEHOLDER}`
        );
        if (redacted === resultStr) return part;

        modified = true;
        redactResultCount++;

        if (part.result !== undefined) {
          return { ...part, result: redacted };
        }
        if (typeof rawResult === "object" && rawResult.value !== undefined) {
          return { ...part, output: { ...rawResult, value: redacted } };
        }
        return { ...part, output: redacted };
      });

      return modified ? { ...msg, content: newContent } : msg;
    }

    return msg;
  });

  if (redactCallCount > 0 || redactResultCount > 0) {
    console.log(
      `[NoActionDetailFilter] Redacted ${redactCallCount} tool-call args, ` +
        `${redactResultCount} getCurrentWorkflow results (kept ${lastStepDefCallIds.size} last-step definitions)`
    );
  }

  return result;
}
