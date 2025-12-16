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
 * Execution types for Texera Agent Service.
 * These types match the backend SyncExecutionResource response exactly.
 */

// ============================================================================
// Console Message
// ============================================================================

/**
 * Simplified console message - just type and message.
 */
export interface ConsoleMessage {
  msgType: string;
  message: string;
}

// ============================================================================
// Operator Info
// ============================================================================

/**
 * Structured CSV result format for compact representation.
 */
export interface CsvResult {
  header: string[]; // Column names
  rows: string[][]; // Array of rows, each row is an array of cell values
}

/**
 * Per-operator execution info returned by the sync API.
 */
export interface OperatorInfo {
  state: string;
  inputTuples: number;
  outputTuples: number;
  resultMode: string; // "table" or "visualization"
  resultFormat?: string; // "json" or "csv"
  result?: Record<string, any>[] | CsvResult; // JSON array or CSV structure
  totalRowCount?: number;
  displayedRows?: number;
  truncated?: boolean;
  consoleLogs?: ConsoleMessage[];
  error?: string;
}

// ============================================================================
// Execution Result
// ============================================================================

/**
 * Sync execution result from the backend.
 */
export interface SyncExecutionResult {
  success: boolean;
  state: string;
  operators: Record<string, OperatorInfo>;
  compilationErrors?: Record<string, string>;
  errors?: string[];
}
