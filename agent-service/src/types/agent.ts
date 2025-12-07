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
 * Agent-related types for Texera Agent Service.
 */

import type { WorkflowContent } from "./workflow";

// ============================================================================
// Agent State
// ============================================================================

/**
 * Agent operational states
 */
export enum AgentState {
  UNAVAILABLE = "UNAVAILABLE",
  AVAILABLE = "AVAILABLE",
  GENERATING = "GENERATING",
  STOPPING = "STOPPING",
}

// ============================================================================
// Tool Result Types
// ============================================================================

/**
 * Base interface for all tool execution results
 */
export interface BaseToolResult {
  success: boolean;
  error?: string;
  viewedOperatorIds: string[];
  addedOperatorIds: string[];
  modifiedOperatorIds: string[];
}

/**
 * Operator access tracking from tool execution
 */
export interface ToolOperatorAccess {
  viewedOperatorIds: string[];
  addedOperatorIds: string[];
  modifiedOperatorIds: string[];
}

// ============================================================================
// Agent Action Types
// ============================================================================

/**
 * Operations performed by an agent action
 */
export interface AgentActionOperations {
  add?: { operatorIds: string[]; linkIds: string[] };
  modify?: { operatorIds: string[] };
  delete?: { operatorIds: string[]; linkIds: string[] };
}

/**
 * Complete agent action record
 */
export interface AgentAction {
  id: string;
  agentId: string;
  agentName: string;
  executorAgentId?: string;
  summary: string;
  operations: AgentActionOperations;
  createdAt: Date;
  workflowMetadata?: {
    wid?: number;
    name?: string;
  };
  beforeWorkflowContent?: WorkflowContent;
  afterWorkflowContent?: WorkflowContent;
}

// ============================================================================
// ReAct Step Types (Agent reasoning trace)
// ============================================================================

/**
 * Token usage statistics
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
}

/**
 * Base step interface
 */
interface BaseReActStep {
  messageId: string;
  stepId: string;
  timestamp: number;
}

/**
 * Text step - agent thinking or response
 */
export interface TextReActStep extends BaseReActStep {
  type: "text";
  content: string;
}

/**
 * Tool call step - agent calling a tool
 */
export interface ToolCallReActStep extends BaseReActStep {
  type: "tool-call";
  toolName: string;
  input: any;
  toolCallId: string;
}

/**
 * Tool result step - result from a tool call
 */
export interface ToolResultReActStep extends BaseReActStep {
  type: "tool-result";
  toolCallId: string;
  result: any;
  isError: boolean;
}

/**
 * Single step in agent reasoning (ReAct pattern) - discriminated union
 */
export type ReActStep = TextReActStep | ToolCallReActStep | ToolResultReActStep;

/**
 * Legacy ReAct step format (for compatibility)
 */
export interface LegacyReActStep {
  messageId: string;
  stepId: string;
  timestamp: number;
  role: "user" | "agent";
  content?: string;
  isBegin?: boolean;
  isEnd?: boolean;
  toolCalls?: any[];
  toolResults?: any[];
  usage?: TokenUsage;
  operatorAccess?: Map<number, ToolOperatorAccess>;
}

/**
 * Statistics for a single message request
 */
export interface AgentMessageStats {
  messageId: string;
  userMessage: string;
  startTime: number;
  endTime?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  stepCount: number;
  status: "running" | "completed" | "error" | "stopped";
  errorMessage?: string;
}

// ============================================================================
// Agent Settings
// ============================================================================

/**
 * Configurable settings for an agent instance
 */
export interface AgentSettings {
  /** System prompt for the agent */
  systemPrompt: string;
  /** Set of disabled tool names */
  disabledTools: Set<string>;
  /** Maximum token limit for operator results */
  maxOperatorResultTokenLimit: number;
  /** Tool execution timeout in milliseconds */
  toolTimeoutMs: number;
  /** Workflow execution timeout in milliseconds */
  executionTimeoutMs: number;
}

/**
 * Default agent settings
 */
export const DEFAULT_AGENT_SETTINGS: Omit<AgentSettings, "systemPrompt"> = {
  disabledTools: new Set(),
  maxOperatorResultTokenLimit: 1000,
  toolTimeoutMs: 120000, // 2 minutes
  executionTimeoutMs: 600000, // 10 minutes
};
