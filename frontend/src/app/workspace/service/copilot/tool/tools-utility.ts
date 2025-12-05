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

// Default tool execution timeout in milliseconds (2 minutes)
export const DEFAULT_TOOL_TIMEOUT_MS = 120000;

// Default maximum token limit for operator result data to prevent overwhelming LLM context
// Estimated as characters / 4 (common approximation for token counting)
export const DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT = 1000;

// Default execution timeout for workflow execution in milliseconds (10 minutes)
export const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Base interface for all tool execution results.
 * Ensures consistent structure across all tools with required tracking fields.
 */
export interface BaseToolResult {
  /**
   * Indicates whether the tool execution was successful.
   */
  success: boolean;

  /**
   * Error message if the tool execution failed.
   */
  error?: string;

  /**
   * List of operator IDs that were viewed/read during tool execution.
   * Empty array if no operators were viewed.
   */
  viewedOperatorIds: string[];

  /**
   * List of operator IDs that were newly added during tool execution.
   * Empty array if no operators were added.
   */
  addedOperatorIds: string[];

  /**
   * List of operator IDs that were modified/updated during tool execution.
   * Empty array if no operators were modified.
   */
  modifiedOperatorIds: string[];
}

/**
 * Creates a successful tool result with default values for required fields.
 * Tools can extend this with additional custom fields.
 *
 * @param data - Custom data fields for the tool result
 * @param viewedOperatorIds - Operator IDs that were viewed (default: [])
 * @param addedOperatorIds - Operator IDs that were added (default: [])
 * @param modifiedOperatorIds - Operator IDs that were modified (default: [])
 * @returns BaseToolResult with success=true and provided data
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
 *
 * @param error - Error message describing the failure
 * @returns BaseToolResult with success=false and error message
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

/**
 * Estimates the number of tokens in a JSON-serializable object
 * Uses a common approximation: tokens ≈ characters / 4
 */
export function estimateTokenCount(data: any): number {
  try {
    const jsonString = JSON.stringify(data);
    return Math.ceil(jsonString.length / 4);
  } catch (error) {
    // Fallback if JSON.stringify fails
    return 0;
  }
}

/**
 * Essential Plotly chart data structure.
 * Contains only the data traces and relevant layout properties for LLM consumption.
 */
export interface EssentialPlotlyData {
  /** The data traces (series) of the chart - this is the actual chart data */
  data: any[];
  /** Essential layout properties (titles, axis labels) */
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
 *
 * The full Plotly JSON from plotly.io.to_json() contains:
 * - data: Array of trace objects (the actual chart data) - KEPT
 * - layout: Object with layout properties - FILTERED to keep only essential parts
 *   - layout.template: Default styling/theme data (hundreds of lines) - REMOVED
 *   - layout.xaxis/yaxis/title: Useful for understanding the chart - KEPT
 *
 * @param fullPlotlyJson - The complete Plotly JSON object from plotly.io.to_json()
 * @returns Essential Plotly data with only data traces and key layout properties
 */
export function extractEssentialPlotlyData(fullPlotlyJson: any): EssentialPlotlyData {
  if (!fullPlotlyJson || typeof fullPlotlyJson !== "object") {
    return { data: [] };
  }

  const result: EssentialPlotlyData = {
    data: Array.isArray(fullPlotlyJson.data) ? fullPlotlyJson.data : [],
  };

  // Extract only essential layout properties (skip template and other theme data)
  if (fullPlotlyJson.layout && typeof fullPlotlyJson.layout === "object") {
    const layout = fullPlotlyJson.layout;
    const essentialLayout: EssentialPlotlyData["layout"] = {};

    // Keep title
    if (layout.title !== undefined) {
      essentialLayout.title = layout.title;
    }

    // Keep axis titles (but not full axis config with gridcolor, linecolor, etc.)
    if (layout.xaxis?.title !== undefined) {
      essentialLayout.xaxis = { title: layout.xaxis.title };
    }
    if (layout.yaxis?.title !== undefined) {
      essentialLayout.yaxis = { title: layout.yaxis.title };
    }
    if (layout.zaxis?.title !== undefined) {
      essentialLayout.zaxis = { title: layout.zaxis.title };
    }

    // Keep legend configuration if present
    if (layout.legend !== undefined) {
      essentialLayout.legend = layout.legend;
    }

    // Keep annotations if present (useful for understanding chart context)
    if (Array.isArray(layout.annotations) && layout.annotations.length > 0) {
      essentialLayout.annotations = layout.annotations;
    }

    // Only include layout if we have any essential properties
    if (Object.keys(essentialLayout).length > 0) {
      result.layout = essentialLayout;
    }
  }

  return result;
}

/**
 * Wraps a tool definition to add timeout protection to its execute function
 * Uses AbortController to properly cancel operations on timeout
 *
 * @param toolConfig - The tool configuration to wrap
 * @param timeoutMs - Optional timeout in milliseconds (default: DEFAULT_TOOL_TIMEOUT_MS)
 */
export function toolWithTimeout(toolConfig: any, timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS): any {
  const originalExecute = toolConfig.execute;

  return {
    ...toolConfig,
    execute: async (args: any) => {
      const abortController = new AbortController();

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          abortController.abort();
          reject(new Error("timeout"));
        }, timeoutMs);
      });

      try {
        const argsWithSignal = { ...args, signal: abortController.signal };
        return await Promise.race([originalExecute(argsWithSignal), timeoutPromise]);
      } catch (error: any) {
        if (error.message === "timeout") {
          const timeoutMinutes = Math.round(timeoutMs / 60000);
          return createErrorResult(
            `Tool execution timeout - operation took longer than ${timeoutMinutes} minute(s). Please try again later.`
          );
        }
        throw error;
      }
    },
  };
}
