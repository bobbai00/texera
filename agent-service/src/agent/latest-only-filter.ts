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
 * Latest-only message filter.
 *
 * When the agent iterates on a workflow over many steps, the message history
 * accumulates tool calls for operators that were later modified or deleted.
 * This filter keeps only the **latest** tool call/result for each operator
 * that **still exists** in the current workflow, removing stale context.
 */

import type { ModelMessage } from "ai";
import type { WorkflowState } from "../workflow/workflow-state";
import { TOOL_NAME_CREATE_OR_MODIFY_OPERATOR } from "../tools/code-op-tools";
import { TOOL_NAME_EXECUTE_OPERATOR } from "../tools/execution-tools";
import {
  TOOL_NAME_GET_CURRENT_WORKFLOW,
  TOOL_NAME_ADD_LINK,
  TOOL_NAME_DELETE_LINK,
  TOOL_NAME_DELETE_OPERATOR,
} from "../tools/workflow-tools";
import { TOOL_NAME_ADD_OPERATOR, TOOL_NAME_MODIFY_OPERATOR } from "../tools/general-op-tools";
import { TOOL_NAME_LIST_ALL_AVAILABLE_OPERATOR_TYPES, TOOL_NAME_GET_OPERATOR_SCHEMA } from "../tools/metadata-tools";

// ============================================================================
// Operator ID Extraction
// ============================================================================

/** Tools that never reference a specific operator — always keep. */
const NO_OPERATOR_TOOLS = new Set([
  TOOL_NAME_GET_CURRENT_WORKFLOW,
  TOOL_NAME_LIST_ALL_AVAILABLE_OPERATOR_TYPES,
  TOOL_NAME_GET_OPERATOR_SCHEMA,
]);

/**
 * Extract all operator IDs referenced by a tool-call's arguments.
 * Returns an empty array for tools that don't reference operators.
 */
function extractOperatorIds(toolName: string, params: Record<string, any>): string[] {
  if (NO_OPERATOR_TOOLS.has(toolName)) return [];

  const ids: string[] = [];

  // Single operatorId (createOrModifyOperator, executeOperator, deleteOperator,
  // addOperator, modifyOperator)
  if (typeof params.operatorId === "string") {
    ids.push(params.operatorId);
  }

  // addLink references two operators
  if (typeof params.sourceOperatorId === "string") {
    ids.push(params.sourceOperatorId);
  }
  if (typeof params.targetOperatorId === "string") {
    ids.push(params.targetOperatorId);
  }

  return ids;
}

// ============================================================================
// Latest-Only Filter
// ============================================================================

interface ToolCallEntry {
  /** Index of the assistant message in the messages array */
  messageIndex: number;
  /** Index of the tool-call part within the message's content array */
  partIndex: number;
  /** The tool call ID (used to match corresponding tool-result) */
  toolCallId: string;
  /** Tool name */
  toolName: string;
  /** Operator IDs referenced by this tool call */
  operatorIds: string[];
}

/**
 * Filter message history to keep only the latest tool call/result for each
 * operator that still exists in the current workflow.
 *
 * Algorithm:
 * 1. Scan assistant messages to build a chronological list of tool-call entries.
 * 2. Reverse-traverse to find the latest call per operator, marking stale ones.
 * 3. Remove marked tool-call parts from assistant messages and corresponding
 *    tool-result parts from tool messages.
 * 4. Drop empty messages.
 */
export function filterLatestOnlyMessages(messages: ModelMessage[], workflowState: WorkflowState): ModelMessage[] {
  // Build the set of operator IDs currently in the workflow
  const currentOperatorIds = new Set(workflowState.getAllEnabledOperators().map(op => op.operatorID));

  // --- Step 1: Scan assistant messages, collect tool-call entries in order ---
  const entries: ToolCallEntry[] = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (let partIdx = 0; partIdx < (msg.content as any[]).length; partIdx++) {
      const part = (msg.content as any[])[partIdx];
      if (part.type !== "tool-call") continue;

      const params = part.args || part.input || {};
      const toolName: string = part.toolName;
      const operatorIds = extractOperatorIds(toolName, params);

      entries.push({
        messageIndex: msgIdx,
        partIndex: partIdx,
        toolCallId: part.toolCallId,
        toolName,
        operatorIds,
      });
    }
  }

  // --- Step 2: Reverse traverse to decide which tool calls to remove ---
  const seenOperatorIds = new Set<string>();
  const toolCallIdsToRemove = new Set<string>();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const { toolName, operatorIds } = entry;

    // No operator IDs → keep unconditionally (getCurrentWorkflow, getOperatorSchema, etc.)
    if (operatorIds.length === 0) {
      continue;
    }

    // Check if ALL referenced operators have been deleted from the workflow
    const allDeleted = operatorIds.every(id => !currentOperatorIds.has(id));
    if (allDeleted) {
      toolCallIdsToRemove.add(entry.toolCallId);
      continue;
    }

    // deleteOperator for an operator still in workflow → stale delete (operator was re-created)
    if (toolName === TOOL_NAME_DELETE_OPERATOR && currentOperatorIds.has(operatorIds[0])) {
      toolCallIdsToRemove.add(entry.toolCallId);
      continue;
    }

    // Check if this is a superseded (not-latest) call for any referenced operator
    const anyAlreadySeen = operatorIds.some(id => seenOperatorIds.has(id));
    if (anyAlreadySeen) {
      toolCallIdsToRemove.add(entry.toolCallId);
    } else {
      // First (latest) encounter — mark all referenced operators as seen
      for (const id of operatorIds) {
        seenOperatorIds.add(id);
      }
    }
  }

  if (toolCallIdsToRemove.size === 0) {
    console.log(`[LatestOnlyFilter] No tool calls removed (${entries.length} total)`);
    return messages;
  }

  // --- Step 3: Filter messages ---
  const filtered: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const newContent = (msg.content as any[]).filter(part => {
        if (part.type === "tool-call") {
          return !toolCallIdsToRemove.has(part.toolCallId);
        }
        return true; // keep text parts
      });

      // Drop message only if it had content before and is now empty
      if (newContent.length > 0) {
        filtered.push({ ...msg, content: newContent });
      }
    } else if (msg.role === "tool" && Array.isArray(msg.content)) {
      const newContent = (msg.content as any[]).filter(part => {
        if (part.type === "tool-result") {
          return !toolCallIdsToRemove.has(part.toolCallId);
        }
        return true;
      });

      if (newContent.length > 0) {
        filtered.push({ ...msg, content: newContent });
      }
    } else {
      // user messages and other message types — keep as-is
      filtered.push(msg);
    }
  }

  console.log(
    `[LatestOnlyFilter] Removed ${toolCallIdsToRemove.size}/${entries.length} tool call pairs ` +
      `(${currentOperatorIds.size} operators in workflow)`
  );

  return filtered;
}
