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
 * Context optimization v2: Selective execution result trimming.
 *
 * Instead of replacing the entire message history with a condensed format,
 * this approach keeps the full message history intact (preserving all tool calls,
 * assistant reasoning, and ordering) but selectively trims execution results
 * from tool results that belong to non-frontier operators.
 *
 * This preserves the reasoning trace while saving tokens on bulky execution
 * outputs that are no longer relevant.
 */

import type { ModelMessage } from "ai";
import type { WorkflowState } from "../workflow/workflow-state";
import { AgentMode } from "../types/agent";
import { TOOL_NAME_CREATE_OR_MODIFY_OPERATOR } from "../tools/code-op-tools";
import { TOOL_NAME_EXECUTE_OPERATOR } from "../tools/execution-tools";

// ============================================================================
// Frontier Computation
// ============================================================================

/**
 * Compute frontier operator IDs from the workflow state.
 * Delegates to WorkflowState.getFrontierOperators().
 */
export function computeFrontier(workflowState: WorkflowState, depth: number): string[] {
  return workflowState.getFrontierOperators(depth);
}

// ============================================================================
// Selective Execution Result Trimming
// ============================================================================

/**
 * Trim execution results from non-frontier operators while keeping the full
 * message history intact.
 *
 * For each tool-result in the message history:
 * - Errors (results starting with "[ERROR]") are always preserved.
 * - Code mode (`createOrModifyOperator`): strips everything after the
 *   "--- Execution Result ---" marker, keeping the action description.
 * - General mode (`executeOperator`): replaces the entire result.
 * - All other tool results are kept as-is regardless of frontier status.
 *
 * @param messages - The full message history
 * @param workflowState - Current workflow state
 * @param frontierDepth - BFS depth for frontier computation
 * @param agentMode - Current agent mode (code or general)
 * @returns Modified messages array with trimmed execution results
 */
export function trimNonFrontierResults(
  messages: ModelMessage[],
  workflowState: WorkflowState,
  frontierDepth: number,
  agentMode: AgentMode
): ModelMessage[] {
  const frontierOpIds = computeFrontier(workflowState, frontierDepth);
  const frontierSet = new Set(frontierOpIds);

  // First pass: scan assistant messages to build toolCallId -> { toolName, operatorId } map
  const toolCallMap = new Map<string, { toolName: string; operatorId?: string }>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content as any[]) {
        if (part.type === "tool-call") {
          toolCallMap.set(part.toolCallId, {
            toolName: part.toolName,
            operatorId: part.args?.operatorId,
          });
        }
      }
    }
  }

  // Second pass: clone and trim tool-result messages for non-frontier operators
  let trimCount = 0;
  const trimmedMessages: ModelMessage[] = messages.map(msg => {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) {
      return msg;
    }

    let modified = false;
    const newContent = (msg.content as any[]).map(part => {
      if (part.type !== "tool-result") return part;

      const info = toolCallMap.get(part.toolCallId);
      if (!info) return part;

      const { toolName, operatorId } = info;

      // Only trim execution-related tools for non-frontier operators
      if (!operatorId || frontierSet.has(operatorId)) return part;

      const resultStr = typeof part.result === "string" ? part.result : JSON.stringify(part.result);

      // Always preserve errors — the agent needs to learn from failures
      if (resultStr.startsWith("[ERROR]")) return part;

      if (toolName === TOOL_NAME_CREATE_OR_MODIFY_OPERATOR) {
        const marker = "--- Execution Result ---";
        const markerIdx = resultStr.indexOf(marker);
        if (markerIdx >= 0) {
          modified = true;
          trimCount++;
          return {
            ...part,
            result: resultStr.substring(0, markerIdx + marker.length) +
              "\n(Execution result omitted due to context optimization)",
          };
        }
        return part;
      }

      if (toolName === TOOL_NAME_EXECUTE_OPERATOR) {
        modified = true;
        trimCount++;
        return {
          ...part,
          result: "(Execution result omitted due to context optimization)",
        };
      }

      return part;
    });

    return modified ? { ...msg, content: newContent } : msg;
  });

  console.log(
    `[ContextOptimization] Trimmed ${trimCount} execution results ` +
      `(frontier: ${frontierOpIds.length} operators, depth: ${frontierDepth})`
  );

  return trimmedMessages;
}
