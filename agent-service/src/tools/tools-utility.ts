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
 * Tool utilities for Texera Agent Service.
 */

import type { BaseToolResult } from "../types/agent";

// ============================================================================
// Constants
// ============================================================================

/** Default tool execution timeout in milliseconds (2 minutes) */
export const DEFAULT_TOOL_TIMEOUT_MS = 120000;

/** Default maximum token limit for operator result data */
export const DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT = 1000;

/** Default execution timeout for workflow execution in milliseconds (10 minutes) */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;

// ============================================================================
// Result Creators
// ============================================================================

/**
 * Creates a successful tool result with default values for required fields.
 */
export function createSuccessResult<T extends Record<string, any>>(
  data: T,
  viewedOperatorIds: string[] = [],
  addedOperatorIds: string[] = [],
  modifiedOperatorIds: string[] = []
): BaseToolResult & T {
  return {
    success: true,
    viewedOperatorIds,
    addedOperatorIds,
    modifiedOperatorIds,
    ...data,
  };
}

/**
 * Creates a failed tool result with an error message.
 */
export function createErrorResult(error: string): BaseToolResult {
  return {
    success: false,
    error,
    viewedOperatorIds: [],
    addedOperatorIds: [],
    modifiedOperatorIds: [],
  };
}

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimates the number of tokens in a JSON-serializable object.
 * Uses a common approximation: tokens ≈ characters / 4
 */
export function estimateTokenCount(data: any): number {
  try {
    const jsonString = JSON.stringify(data);
    return Math.ceil(jsonString.length / 4);
  } catch {
    return 0;
  }
}

// ============================================================================
// Plotly Data Extraction
// ============================================================================

/**
 * Essential Plotly chart data structure (stripped of template/theme data)
 */
export interface EssentialPlotlyData {
  data: any[];
  layout?: {
    title?: any;
    xaxis?: { title?: any };
    yaxis?: { title?: any };
    zaxis?: { title?: any };
    legend?: any;
    annotations?: any[];
  };
}

/**
 * Extracts essential data from a full Plotly JSON object.
 * Removes template/theme data that bloats the JSON without adding analytical value.
 */
export function extractEssentialPlotlyData(fullPlotlyJson: any): EssentialPlotlyData {
  if (!fullPlotlyJson || typeof fullPlotlyJson !== "object") {
    return { data: [] };
  }

  const result: EssentialPlotlyData = {
    data: Array.isArray(fullPlotlyJson.data) ? fullPlotlyJson.data : [],
  };

  if (fullPlotlyJson.layout && typeof fullPlotlyJson.layout === "object") {
    const layout = fullPlotlyJson.layout;
    const essentialLayout: EssentialPlotlyData["layout"] = {};

    if (layout.title !== undefined) {
      essentialLayout.title = layout.title;
    }
    if (layout.xaxis?.title !== undefined) {
      essentialLayout.xaxis = { title: layout.xaxis.title };
    }
    if (layout.yaxis?.title !== undefined) {
      essentialLayout.yaxis = { title: layout.yaxis.title };
    }
    if (layout.zaxis?.title !== undefined) {
      essentialLayout.zaxis = { title: layout.zaxis.title };
    }
    if (layout.legend !== undefined) {
      essentialLayout.legend = layout.legend;
    }
    if (Array.isArray(layout.annotations) && layout.annotations.length > 0) {
      essentialLayout.annotations = layout.annotations;
    }

    if (Object.keys(essentialLayout).length > 0) {
      result.layout = essentialLayout;
    }
  }

  return result;
}

// ============================================================================
// Tool Timeout Wrapper
// ============================================================================

/**
 * Wraps a tool's execute function with timeout protection.
 */
export function withTimeout<TArgs, TResult>(
  execute: (args: TArgs) => Promise<TResult>,
  timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS
): (args: TArgs) => Promise<TResult | BaseToolResult> {
  return async (args: TArgs) => {
    const timeoutPromise = new Promise<BaseToolResult>((_, reject) => {
      setTimeout(() => {
        reject(new Error("timeout"));
      }, timeoutMs);
    });

    try {
      return await Promise.race([execute(args), timeoutPromise]);
    } catch (error: any) {
      if (error.message === "timeout") {
        const timeoutMinutes = Math.round(timeoutMs / 60000);
        return createErrorResult(`Tool execution timeout - operation took longer than ${timeoutMinutes} minute(s).`);
      }
      throw error;
    }
  };
}

// ============================================================================
// Result Token Filtering
// ============================================================================

/**
 * Filters result rows by token limit.
 */
export function filterByTokenLimit<T>(
  rows: readonly T[],
  maxTokenLimit: number = DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT
): { limited: T[]; tokenCount: number; truncated: boolean } {
  const limited: T[] = [];
  let tokenCount = 0;

  for (const row of rows) {
    const rowTokens = estimateTokenCount(row);
    if (tokenCount + rowTokens > maxTokenLimit) break;
    limited.push(row);
    tokenCount += rowTokens;
  }

  return {
    limited,
    tokenCount,
    truncated: limited.length < rows.length,
  };
}
