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
 * Assistant reasoning text is inlined with operators as "Agent thought:" sections.
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
  // --- Step 1: Extract operator creation order and associated thoughts from tool calls ---
  const creationOrder: string[] = [];
  const seen = new Set<string>();
  // Map of operatorId → list of agent reasoning texts (accumulated across steps)
  const operatorThoughts = new Map<string, string[]>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    // Extract text parts (agent reasoning) from this assistant message
    const textParts = (msg.content as any[])
      .filter(p => p.type === "text" && p.text?.trim())
      .map(p => p.text.trim());
    const thoughtText = textParts.join("\n");

    // Extract operator IDs from tool calls in this message
    const opIdsInMessage: string[] = [];
    for (const part of msg.content as any[]) {
      if (part.type !== "tool-call" || !DEFINITION_TOOLS.has(part.toolName)) continue;
      const args = part.args || part.input || {};
      const opId = args.operatorId;
      if (opId) {
        if (!seen.has(opId)) {
          seen.add(opId);
          creationOrder.push(opId);
        }
        opIdsInMessage.push(opId);
      }
    }

    // Associate the thought text with each operator in this message
    if (thoughtText && opIdsInMessage.length > 0) {
      for (const opId of opIdsInMessage) {
        if (!operatorThoughts.has(opId)) operatorThoughts.set(opId, []);
        operatorThoughts.get(opId)!.push(thoughtText);
      }
    }
  }

  // --- Step 2: Serialize DAG summary with inline thoughts ---
  const dagSummary = serializeDag(creationOrder, workflowState, operatorExecutionResults, operatorThoughts);

  // --- Step 3: Reconstruct messages ---
  // Drop all assistant text + tool-call messages and tool messages;
  // assistant reasoning is now inlined in the DAG summary.
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push(msg);
      continue;
    }

    // Drop assistant messages (text is inlined in DAG summary)
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
 * - Includes operator type between "Created" and "Operator"
 * - Includes agent reasoning text inline as "Agent thought:" section
 * - For error operators, includes the code so the LLM can see what went wrong
 */
function appendOperatorEntry(
  lines: string[],
  index: number,
  op: OperatorPredicate,
  execResult: string | undefined,
  thoughts: string[] | undefined
): void {
  const summary = op.customDisplayName || op.operatorID;
  const hasError = execResult !== undefined && execResult.includes("[ERROR]");

  lines.push("");
  lines.push(`[${index}] Created ${op.operatorType} Operator: ${op.operatorID}`);
  lines.push(`  Summary: ${summary}`);

  // Include agent reasoning text (accumulated from all steps that touched this operator)
  if (thoughts && thoughts.length > 0) {
    lines.push(`  Agent thought: ${thoughts.join("\n  ")}`);
  }

  // Include code for error operators so the LLM can see what went wrong
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
  operatorExecutionResults: Map<string, string>,
  operatorThoughts: Map<string, string[]>
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
    appendOperatorEntry(lines, index, op, operatorExecutionResults.get(opId), operatorThoughts.get(opId));
    index++;
  }

  // Include any operators that exist in workflow but weren't in creation order
  for (const op of allOperators) {
    if (included.has(op.operatorID)) continue;
    appendOperatorEntry(lines, index, op, operatorExecutionResults.get(op.operatorID), operatorThoughts.get(op.operatorID));
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
