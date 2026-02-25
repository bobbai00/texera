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
import { TOOL_NAME_EXECUTE_OPERATOR, SECTION_EXECUTION_DATA } from "../tools/execution-tools";

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

const TRIMMED_NOTICE = "(execution result skipped due to the context compaction)";

/**
 * Remove the "[Execution Data]" section from a result string while preserving
 * everything before it (operator action description, "[Execution Metadata]", etc.).
 * Returns the original string unchanged if no data section is found.
 */
function trimExecutionDataSection(resultStr: string): string {
  const dataIdx = resultStr.indexOf(SECTION_EXECUTION_DATA);
  if (dataIdx < 0) return resultStr;

  // Keep everything before the data section marker, plus a trimmed notice
  const before = resultStr.substring(0, dataIdx).trimEnd();
  return before + "\n" + SECTION_EXECUTION_DATA + "\n" + TRIMMED_NOTICE;
}

/**
 * Trim execution results from non-frontier operators while keeping the full
 * message history intact.
 *
 * For each tool-result in the message history:
 * - Errors (results starting with "[ERROR]") are always preserved.
 * - For execution-related tools (`createOrModifyOperator`, `executeOperator`):
 *   Removes the "[Execution Data]" section (the raw table/JSON) while
 *   preserving the "[Execution Metadata]" section (shape, dataflow, columns).
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
  // Note: Vercel AI SDK uses `input` (not `args`) for tool-call parameters
  const toolCallMap = new Map<string, { toolName: string; operatorId?: string }>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content as any[]) {
        if (part.type === "tool-call") {
          const params = part.args || part.input || {};
          toolCallMap.set(part.toolCallId, {
            toolName: part.toolName,
            operatorId: params.operatorId,
          });
        }
      }
    }
  }

  // Second pass: clone and trim tool-result messages for non-frontier operators
  // Note: Vercel AI SDK tool-result uses `output` (not `result`), and the output
  // can be a structured object like { type: "text", value: "..." } or a plain string.
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

      // Extract the result string from whichever field/format the AI SDK uses
      const rawResult = part.result ?? part.output;
      let resultStr: string;
      if (typeof rawResult === "string") {
        resultStr = rawResult;
      } else if (rawResult && typeof rawResult === "object" && rawResult.value !== undefined) {
        // Structured format: { type: "text", value: "..." }
        resultStr = String(rawResult.value);
      } else {
        resultStr = JSON.stringify(rawResult);
      }

      // Always preserve errors — the agent needs to learn from failures
      if (resultStr.startsWith("[ERROR]")) return part;

      // Helper to build the replacement result in the same format as the original
      const buildReplacement = (newText: string): any => {
        if (part.result !== undefined) {
          // Original uses `result` field
          return { ...part, result: newText };
        }
        // Original uses `output` field
        if (typeof rawResult === "object" && rawResult.value !== undefined) {
          // Structured format: preserve the wrapper
          return { ...part, output: { ...rawResult, value: newText } };
        }
        return { ...part, output: newText };
      };

      if (toolName === TOOL_NAME_CREATE_OR_MODIFY_OPERATOR || toolName === TOOL_NAME_EXECUTE_OPERATOR) {
        const trimmedText = trimExecutionDataSection(resultStr);
        if (trimmedText !== resultStr) {
          modified = true;
          trimCount++;
          return buildReplacement(trimmedText);
        }
        return part;
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
