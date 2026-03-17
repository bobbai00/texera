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
 * No-action-detail filter — DAG serialization variant.
 *
 * Replaces ALL historical tool-call / tool-result messages with a single
 * plain-text "Workflow State" summary.  The summary is built from the live
 * WorkflowState (operators, links, display names) and a pre-populated
 * execution-results map that records each operator's formatted result text
 * as tools execute.
 *
 * This eliminates the tool-call message structures that GPT-5.2 tends to
 * imitate (causing validation errors or "[REDACTED]"-echo loops).
 */

import type { ModelMessage } from "ai";
import { TOOL_NAME_CREATE_OR_MODIFY_OPERATOR } from "../tools/code-op-tools";
import { TOOL_NAME_ADD_OPERATOR, TOOL_NAME_MODIFY_OPERATOR } from "../tools/general-op-tools";
import type { WorkflowState } from "../workflow/workflow-state";
import type { OperatorPredicate } from "../types/workflow";

/** Tool names that define / modify operators (used to extract creation order). */
const DEFINITION_TOOLS = new Set([
  TOOL_NAME_CREATE_OR_MODIFY_OPERATOR,
  TOOL_NAME_ADD_OPERATOR,
  TOOL_NAME_MODIFY_OPERATOR,
]);

/**
 * Replace all tool-call / tool-result messages with a compact DAG summary.
 *
 * @param messages        - Current conversation messages
 * @param workflowState   - Live workflow state (operators + links)
 * @param operatorExecutionResults - Map of operatorId → formatted result text
 * @returns Filtered message array
 */
export function redactActionDetails(
  messages: ModelMessage[],
  workflowState: WorkflowState,
  operatorExecutionResults: Map<string, string>
): ModelMessage[] {
  // --- Step 1: Extract operator creation order from tool calls ---
  const creationOrder: string[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as any[]) {
      if (part.type !== "tool-call" || !DEFINITION_TOOLS.has(part.toolName)) continue;
      const args = part.args || part.input || {};
      const opId = args.operatorId;
      if (opId && !seen.has(opId)) {
        seen.add(opId);
        creationOrder.push(opId);
      }
    }
  }

  // --- Step 2: Serialize DAG summary ---
  const dagSummary = serializeDag(creationOrder, workflowState, operatorExecutionResults);

  // --- Step 3: Reconstruct messages ---
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push(msg);
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Keep only text parts; drop tool-call parts
      const textParts = (msg.content as any[]).filter(p => p.type === "text" && p.text?.trim());
      if (textParts.length > 0) {
        result.push({ ...msg, content: textParts });
      }
      continue;
    }

    // Drop tool messages entirely
    if (msg.role === "tool") {
      continue;
    }

    // Keep anything else (system, etc.)
    result.push(msg);
  }

  // Append DAG summary as final user message if any operators exist
  if (dagSummary) {
    result.push({
      role: "user",
      content: dagSummary,
    });

    console.log(
      `[NoActionDetailFilter] Replaced tool messages with DAG summary (${creationOrder.length} operators in creation order, ` +
        `${operatorExecutionResults.size} with results)`
    );
  }

  return result;
}

/**
 * Append a single operator entry to the DAG summary lines.
 * For operators whose execution result contains an error, include the code.
 */
function appendOperatorEntry(
  lines: string[],
  index: number,
  op: OperatorPredicate,
  execResult: string | undefined
): void {
  const summary = op.customDisplayName || op.operatorID;
  const hasError = execResult !== undefined && execResult.includes("[ERROR]");

  lines.push("");
  lines.push(`[${index}] Created Operator: ${op.operatorID}`);
  lines.push(`  Summary: ${summary}`);

  // For error operators, include the code so the LLM can see what went wrong
  if (hasError) {
    const code = op.operatorProperties?.code;
    if (code) {
      lines.push(`  Code: ${code}`);
    }
  }

  if (execResult) {
    lines.push("  Result:");
    const indented = execResult
      .split("\n")
      .map(l => "  " + l)
      .join("\n");
    lines.push(indented);
  } else {
    lines.push("  Not yet executed.");
  }
}

/**
 * Serialize the workflow into a compact text DAG summary.
 */
function serializeDag(
  creationOrder: string[],
  workflowState: WorkflowState,
  operatorExecutionResults: Map<string, string>
): string | null {
  const allOperators = workflowState.getAllOperators();
  if (allOperators.length === 0 && creationOrder.length === 0) return null;

  const lines: string[] = ["=== Current Workflow ==="];

  // Build a set of operator IDs currently in the workflow
  const activeOpIds = new Set(allOperators.map(op => op.operatorID));

  // Include operators in creation order first (skip deleted ones)
  const included = new Set<string>();
  let index = 1;

  for (const opId of creationOrder) {
    if (!activeOpIds.has(opId)) continue; // deleted operator
    const op = workflowState.getOperator(opId);
    if (!op) continue;

    included.add(opId);
    appendOperatorEntry(lines, index, op, operatorExecutionResults.get(opId));
    index++;
  }

  // Include any operators that exist in workflow but weren't in creation order
  for (const op of allOperators) {
    if (included.has(op.operatorID)) continue;
    appendOperatorEntry(lines, index, op, operatorExecutionResults.get(op.operatorID));
    index++;
  }

  // Links
  const allLinks = workflowState.getAllLinks();
  if (allLinks.length > 0) {
    const linkStrs = allLinks.map(l => `${l.source.operatorID}-->${l.target.operatorID}`);
    lines.push("");
    lines.push(`Links: ${linkStrs.join(", ")}`);
  }

  return lines.join("\n");
}
