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
 * Base interface for all tool execution results.
 * Tools return either a success result with a message, or an error.
 * The message field provides human-readable feedback to the agent.
 */
export interface BaseToolResult {
  /** Human-readable message describing what happened */
  message: string;
  /** Error message if the tool failed (presence indicates failure) */
  error?: string;
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
// Aligned with frontend texera-copilot.ts ReActStep interface
// ============================================================================

/**
 * Token usage statistics
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

/**
 * ReActStep - Represents a single reasoning and acting step in the agent's response.
 * Each step contains the agent's reasoning text, tool calls, results, and metadata.
 */
export interface ReActStep {
  messageId: string;
  stepId: number;
  timestamp: number;
  role: "user" | "agent";
  content: string;
  /** For user messages: the actual content sent to the model (may include prepended context) */
  actualContent?: string;
  isBegin: boolean;
  isEnd: boolean;
  toolCalls?: Array<{
    toolName: string;
    toolCallId: string;
    input: any;
  }>;
  toolResults?: Array<{
    toolCallId: string;
    output: any;
    isError?: boolean;
  }>;
  usage?: TokenUsage;
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
 * Serialization mode for operator results
 */
export enum OperatorResultSerializationMode {
  /** JSON array of objects */
  JSON = "json",
  /** Table format: header\nrow\nrow\n (CSV-like) */
  TABLE = "table",
  /** TOON format: Token-Oriented Object Notation (most compact for LLMs) */
  TOON = "toon",
}

/**
 * Agent operating mode - determines which tools and prompts are used
 */
export enum AgentMode {
  /** Code mode: Uses code operator tools (addCodeOperator, modifyCodeOperator), no operator schemas in prompt */
  CODE = "code",
  /** General mode: Uses workflow tools (addOperator, modifyOperator), includes operator schemas in prompt */
  GENERAL = "general",
}

/**
 * Configurable settings for an agent instance
 */
export interface AgentSettings {
  /** System prompt for the agent */
  systemPrompt: string;
  /** Set of disabled tool names */
  disabledTools: Set<string>;
  /** Maximum character limit for operator results (uses symmetric truncation: first half + notice + last half) */
  maxOperatorResultCharLimit: number;
  /** Maximum character limit per cell (truncates individual cell values beyond this limit) */
  maxOperatorResultCellCharLimit: number;
  /** Serialization mode for operator results (json, table, or toon) */
  operatorResultSerializationMode: OperatorResultSerializationMode;
  /** Tool execution timeout in milliseconds */
  toolTimeoutMs: number;
  /** Workflow execution timeout in milliseconds */
  executionTimeoutMs: number;
  /** Maximum number of steps per message */
  maxSteps: number;
  /** Agent operating mode (code or general) */
  agentMode: AgentMode;
  /** Auto-execute operator after add/modify in code mode (default: false) */
  autoExecuteOnChange: boolean;
}

/**
 * Default agent settings
 */
export const DEFAULT_AGENT_SETTINGS: Omit<AgentSettings, "systemPrompt"> = {
  disabledTools: new Set(),
  maxOperatorResultCharLimit: 40000, // 20,000 characters (matches smolagents)
  maxOperatorResultCellCharLimit: 20000, // 4,000 characters per cell
  operatorResultSerializationMode: OperatorResultSerializationMode.TABLE,
  toolTimeoutMs: 240000, // 4 minutes
  executionTimeoutMs: 240000, // 4 minutes
  maxSteps: 100,
  agentMode: AgentMode.CODE, // Default to CODE mode
  autoExecuteOnChange: true, // Auto-execute after add/modify in code mode
};

// ============================================================================
// User Delegate Configuration
// ============================================================================

/**
 * User information extracted from JWT token
 */
export interface UserInfo {
  uid: number;
  name: string;
  email: string;
  role: string;
}

/**
 * Configuration for an agent acting as a user delegate
 */
export interface AgentDelegateConfig {
  /** JWT token for authenticated API calls */
  userToken: string;
  /** User information extracted from token */
  userInfo?: UserInfo;
  /** Associated workflow ID (wid) */
  workflowId?: number;
  /** Workflow name */
  workflowName?: string;
  /** Computing unit ID (cuid) for workflow execution */
  computingUnitId?: number;
}

/**
 * Agent settings for API (serializable version without Set)
 */
export interface AgentSettingsApi {
  /** Maximum character limit for operator results (uses symmetric truncation) */
  maxOperatorResultCharLimit?: number;
  /** Maximum character limit per cell (truncates individual cell values beyond this limit) */
  maxOperatorResultCellCharLimit?: number;
  /** Serialization mode for operator results: "json", "table", or "toon" */
  operatorResultSerializationMode?: "json" | "table" | "toon";
  /** Tool execution timeout in seconds */
  toolTimeoutSeconds?: number;
  /** Workflow execution timeout in minutes */
  executionTimeoutMinutes?: number;
  /** List of disabled tool names */
  disabledTools?: string[];
  /** Maximum number of steps per message */
  maxSteps?: number;
  /** Agent operating mode: "code" or "general" */
  agentMode?: "code" | "general";
  /** Auto-execute operator after add/modify in code mode */
  autoExecuteOnChange?: boolean;
}

/**
 * Extended agent info including delegate configuration
 */
export interface AgentInfo {
  id: string;
  name: string;
  modelType: string;
  state: AgentState;
  createdAt: Date;
  /** Delegate configuration (if acting on behalf of a user) */
  delegate?: AgentDelegateConfig;
  /** Current agent settings (serializable format) */
  settings?: AgentSettingsApi;
}

/**
 * Request to create a new agent
 */
export interface CreateAgentRequest {
  modelType: string;
  name?: string;
  /** JWT token for delegate mode */
  userToken?: string;
  /** Workflow ID to associate with */
  workflowId?: number;
  /** Computing unit ID for workflow execution */
  computingUnitId?: number;
  /** Optional initial settings */
  settings?: AgentSettingsApi;
}

/**
 * Request to update agent settings
 */
export interface UpdateAgentSettingsRequest {
  /** Maximum character limit for operator results (uses symmetric truncation) */
  maxOperatorResultCharLimit?: number;
  /** Maximum character limit per cell (truncates individual cell values beyond this limit) */
  maxOperatorResultCellCharLimit?: number;
  /** Serialization mode for operator results: "json", "table", or "toon" */
  operatorResultSerializationMode?: "json" | "table" | "toon";
  /** Tool execution timeout in seconds */
  toolTimeoutSeconds?: number;
  /** Workflow execution timeout in minutes */
  executionTimeoutMinutes?: number;
  /** List of disabled tool names */
  disabledTools?: string[];
  /** Maximum number of steps per message */
  maxSteps?: number;
  /** Agent operating mode: "code" or "general" */
  agentMode?: "code" | "general";
  /** Auto-execute operator after add/modify in code mode */
  autoExecuteOnChange?: boolean;
}

// ============================================================================
// Trace Replay Types
// ============================================================================

/**
 * Content structure of a trace file (exported from agent conversation)
 */
export interface TraceContent {
  /** Final response text from the agent */
  response: string;
  /** Full conversation messages in Vercel AI SDK ModelMessage format */
  messages: any[];
}

/**
 * WebSocket message for replaying a trace
 */
export interface ReplayTraceMessage {
  type: "replay";
  trace: TraceContent;
}

/**
 * Tools that should be skipped during replay (execution-related tools)
 */
export const REPLAY_SKIP_TOOLS = new Set([
  "executeWorkflow",
  "getExecutionState",
  "killWorkflow",
  "getExecutionResult",
  "getOperatorResult",
]);

