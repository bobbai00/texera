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

/** Represents one assistant reasoning step with its associated tool actions. */
interface ThoughtEntry {
  thought: string;
  actions: string[];
}

/**
 * Replace all tool-call / tool-result messages with a compact DAG summary
 * and a chronological list of assistant reasoning messages.
 *
 * @param messages        - Current conversation messages
 * @param workflowState   - Live workflow state (operators + links)
 * @param operatorExecutionResults - Map of operatorId → formatted result text
 * @param removeProperties - If true, strip code and other operator properties from the summary (default: true)
 * @returns Filtered message array
 */
export function redactActionDetails(
  messages: ModelMessage[],
  workflowState: WorkflowState,
  operatorExecutionResults: Map<string, string>,
  removeProperties: boolean = true
): ModelMessage[] {
  // --- Step 0: Build a map from toolCallId → first-line summary from tool messages ---
  // Every tool result follows the convention: first line = brief summary, rest = details.
  // This reuses the summaries produced by formatAddOperatorResult, formatExecuteOperatorResult, etc.
  const toolResultMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as any[]) {
      if (part.type !== "tool-result") continue;
      const fullText = extractResultText(part.result);
      if (!fullText) continue;
      // Take only the first line — the brief summary
      const firstNewline = fullText.indexOf("\n");
      toolResultMap.set(part.toolCallId, firstNewline >= 0 ? fullText.substring(0, firstNewline) : fullText);
    }
  }

  // --- Step 1: Extract operator creation order and agent thoughts ---
  const creationOrder: string[] = [];
  const seen = new Set<string>();
  const thoughtEntries: ThoughtEntry[] = [];

  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    // Extract text parts (agent reasoning) from this assistant message
    const textParts = (msg.content as any[])
      .filter(p => p.type === "text" && p.text?.trim())
      .map(p => p.text.trim());
    const thoughtText = textParts.join("\n");

    // Extract tool calls and build action descriptions from their results
    const actions: string[] = [];
    for (const part of msg.content as any[]) {
      if (part.type !== "tool-call") continue;
      const toolName = part.toolName;
      const args = part.args || part.input || {};
      const opId = args.operatorId;

      // Track creation order for DAG serialization
      if (DEFINITION_TOOLS.has(toolName) && opId) {
        if (!seen.has(opId)) {
          seen.add(opId);
          creationOrder.push(opId);
        }
      }

      // Use the tool's first-line summary as the action description
      const resultText = toolResultMap.get(part.toolCallId);
      if (resultText) {
        actions.push(resultText);
      }
    }

    // Record this thought entry if there's any content
    if (thoughtText || actions.length > 0) {
      thoughtEntries.push({ thought: thoughtText, actions });
    }
  }

  // --- Step 2: Serialize DAG summary (without embedded thoughts) ---
  const dagSummary = serializeDag(creationOrder, workflowState, operatorExecutionResults, removeProperties);

  // --- Step 3: Serialize agent thoughts as assistant messages ---
  const thoughtMessages: ModelMessage[] = thoughtEntries.map(entry => {
    const parts: string[] = [];
    if (entry.thought) {
      parts.push(entry.thought);
    }
    if (entry.actions.length > 0) {
      parts.push("Actions:\n" + entry.actions.map(a => `- ${a}`).join("\n"));
    }
    return {
      role: "assistant" as const,
      content: parts.join("\n"),
    };
  });

  // --- Step 4: Reconstruct messages ---
  // Keep user messages, drop assistant/tool messages (replaced by thoughts + DAG)
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push(msg);
      continue;
    }

    // Drop assistant messages (extracted into thoughtMessages)
    if (msg.role === "assistant") {
      continue;
    }

    // Drop tool messages entirely
    if (msg.role === "tool") {
      continue;
    }

    // Keep anything else (system, etc.)
    result.push(msg);
  }

  // Append agent thoughts as assistant messages
  result.push(...thoughtMessages);

  // Append DAG summary as final user message if any operators exist
  if (dagSummary) {
    result.push({
      role: "user",
      content: dagSummary,
    });

    console.log(
      `[NoActionDetailFilter] Replaced tool messages with DAG summary (${creationOrder.length} operators in creation order, ` +
        `${operatorExecutionResults.size} with results) and ${thoughtMessages.length} thought messages`
    );
  }

  return result;
}


/**
 * Append a single operator entry to the DAG summary lines.
 * - Includes operator type between "Created" and "Operator"
 * - For error operators, includes the code so the LLM can see what went wrong
 */
function appendOperatorEntry(
  lines: string[],
  index: number,
  op: OperatorPredicate,
  execResult: string | undefined,
  removeProperties: boolean
): void {
  const summary = op.customDisplayName || op.operatorID;
  const hasError = execResult !== undefined && execResult.includes("[ERROR]");

  lines.push("");
  lines.push(`[${index}] Created ${op.operatorType} Operator: ${op.operatorID}`);
  lines.push(`  Summary: ${summary}`);

  if (!removeProperties) {
    // Include operator properties (code, configuration, etc.)
    const props = op.operatorProperties;
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined && value !== null && value !== "") {
          const valueStr = typeof value === "string" ? value : JSON.stringify(value);
          lines.push(`  ${key}: ${valueStr}`);
        }
      }
    }
  } else if (hasError) {
    // When removing properties, still include code for error operators so the LLM can fix them
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
  operatorExecutionResults: Map<string, string>,
  removeProperties: boolean
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
    appendOperatorEntry(lines, index, op, operatorExecutionResults.get(opId), removeProperties);
    index++;
  }

  // Include any operators that exist in workflow but weren't in creation order
  for (const op of allOperators) {
    if (included.has(op.operatorID)) continue;
    appendOperatorEntry(lines, index, op, operatorExecutionResults.get(op.operatorID), removeProperties);
    index++;
  }

  // Append links section in topological order
  const allLinks = workflowState.getAllLinks();
  if (allLinks.length > 0) {
    // Build topological ordering of operators (Kahn's algorithm)
    const opIds = new Set(allOperators.map(op => op.operatorID));
    const inDegree = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const id of opIds) {
      inDegree.set(id, 0);
      children.set(id, []);
    }
    for (const link of allLinks) {
      children.get(link.source.operatorID)?.push(link.target.operatorID);
      inDegree.set(link.target.operatorID, (inDegree.get(link.target.operatorID) ?? 0) + 1);
    }
    const queue: string[] = [...opIds].filter(id => (inDegree.get(id) ?? 0) === 0);
    const topoOrder = new Map<string, number>();
    let rank = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      topoOrder.set(node, rank++);
      for (const child of children.get(node) ?? []) {
        const newDeg = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, newDeg);
        if (newDeg === 0) queue.push(child);
      }
    }

    // Sort links by source topological rank, then target rank
    const sortedLinks = [...allLinks].sort((a, b) => {
      const srcA = topoOrder.get(a.source.operatorID) ?? 0;
      const srcB = topoOrder.get(b.source.operatorID) ?? 0;
      if (srcA !== srcB) return srcA - srcB;
      return (topoOrder.get(a.target.operatorID) ?? 0) - (topoOrder.get(b.target.operatorID) ?? 0);
    });

    lines.push("");
    lines.push("Links:");
    for (const link of sortedLinks) {
      lines.push(`  ${link.source.operatorID} --> ${link.target.operatorID}`);
    }
  }

  return lines.join("\n");
}

/**
 * Extract a plain-text result from a tool-result value.
 * Tool results are plain strings (from createToolResult / createErrorResult).
 */
function extractResultText(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "result" in result) {
    const r = (result as any).result;
    return typeof r === "string" ? r : null;
  }
  return null;
}
