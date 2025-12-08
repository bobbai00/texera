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
 * Texera Agent - Core agent implementation using Vercel AI SDK.
 */

import { generateText, type CoreMessage, type LanguageModelV1 } from "ai";
import { WorkflowState } from "../workflow/workflow-state";
import { OperatorMetadataStore } from "../tools/metadata-tools";
import type {
  AgentSettings,
  ReActStep,
  AgentMessageStats,
  TokenUsage,
} from "../types/agent";
import { AgentState as AgentStateEnum, DEFAULT_AGENT_SETTINGS } from "../types/agent";
import { COPILOT_SYSTEM_PROMPT } from "./prompts";
import {
  createGetCurrentWorkflowTool,
  createAddOperatorTool,
  createAddLinkTool,
  createModifyOperatorTool,
  createDeleteFromWorkflowTool,
  TOOL_NAME_GET_CURRENT_WORKFLOW,
  TOOL_NAME_ADD_OPERATOR,
  TOOL_NAME_ADD_LINK,
  TOOL_NAME_MODIFY_OPERATOR,
  TOOL_NAME_DELETE_FROM_WORKFLOW,
} from "../tools/workflow-tools";
import {
  createListAllAvailableOperatorTypesTool,
  createGetOperatorSchemaTool,
  TOOL_NAME_LIST_ALL_AVAILABLE_OPERATOR_TYPES,
  TOOL_NAME_GET_OPERATOR_SCHEMA,
} from "../tools/metadata-tools";

// ============================================================================
// Agent Configuration
// ============================================================================

export interface TexeraAgentConfig {
  /** Language model to use */
  model: LanguageModelV1;
  /** Agent ID */
  agentId: string;
  /** Agent display name */
  agentName?: string;
  /** Custom system prompt (optional, defaults to COPILOT_SYSTEM_PROMPT) */
  systemPrompt?: string;
  /** Maximum number of steps per message */
  maxSteps?: number;
}

// ============================================================================
// Agent Result Types
// ============================================================================

export interface AgentMessageResult {
  /** Final response text */
  response: string;
  /** All steps taken during message processing */
  steps: ReActStep[];
  /** Token usage statistics */
  usage: TokenUsage;
  /** Message statistics */
  stats: AgentMessageStats;
  /** Whether the agent was stopped early */
  stopped: boolean;
  /** Error message if any */
  error?: string;
}

// ============================================================================
// Texera Agent Class
// ============================================================================

/**
 * TexeraAgent is the core agent implementation.
 * It maintains workflow state and processes user messages using the Vercel AI SDK.
 */
export class TexeraAgent {
  readonly agentId: string;
  readonly agentName: string;

  // State
  private state: AgentStateEnum = AgentStateEnum.AVAILABLE;
  private workflowState: WorkflowState;
  private metadataStore: OperatorMetadataStore;

  // Configuration
  private model: LanguageModelV1;
  private systemPrompt: string;
  private maxSteps: number;
  private settings: AgentSettings;

  // Conversation history
  private messages: CoreMessage[] = [];

  // Tools
  private tools: Record<string, any>;

  // Stop flag
  private shouldStop = false;

  constructor(config: TexeraAgentConfig) {
    this.agentId = config.agentId;
    this.agentName = config.agentName || `Agent-${config.agentId}`;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt || COPILOT_SYSTEM_PROMPT;
    this.maxSteps = config.maxSteps || 10;

    // Initialize state
    this.workflowState = new WorkflowState();
    this.metadataStore = new OperatorMetadataStore();

    // Initialize settings
    this.settings = {
      ...DEFAULT_AGENT_SETTINGS,
      systemPrompt: this.systemPrompt,
    };

    // Initialize tools
    this.tools = this.createTools();
  }

  // ============================================================================
  // Tool Creation
  // ============================================================================

  private createTools(): Record<string, any> {
    // Get operator schemas map for addOperator tool
    const operatorSchemas = new Map<string, any>();
    for (const [type, schema] of Object.entries(this.metadataStore.getAllOperatorTypes())) {
      operatorSchemas.set(type, this.metadataStore.getSchema(type));
    }

    return {
      [TOOL_NAME_GET_CURRENT_WORKFLOW]: createGetCurrentWorkflowTool(this.workflowState),
      [TOOL_NAME_ADD_OPERATOR]: createAddOperatorTool(this.workflowState, operatorSchemas),
      [TOOL_NAME_ADD_LINK]: createAddLinkTool(this.workflowState),
      [TOOL_NAME_MODIFY_OPERATOR]: createModifyOperatorTool(this.workflowState),
      [TOOL_NAME_DELETE_FROM_WORKFLOW]: createDeleteFromWorkflowTool(this.workflowState),
      [TOOL_NAME_LIST_ALL_AVAILABLE_OPERATOR_TYPES]: createListAllAvailableOperatorTypesTool(this.metadataStore),
      [TOOL_NAME_GET_OPERATOR_SCHEMA]: createGetOperatorSchemaTool(this.metadataStore),
    };
  }

  // ============================================================================
  // State Access
  // ============================================================================

  getState(): AgentStateEnum {
    return this.state;
  }

  getWorkflowState(): WorkflowState {
    return this.workflowState;
  }

  getMetadataStore(): OperatorMetadataStore {
    return this.metadataStore;
  }

  getMessages(): CoreMessage[] {
    return [...this.messages];
  }

  /**
   * Get system info including system prompt and tool definitions.
   * This is used by the frontend to display agent configuration.
   */
  getSystemInfo(): {
    systemPrompt: string;
    tools: Array<{ name: string; description: string; inputSchema: any; enabled: boolean }>;
  } {
    const toolsInfo = Object.entries(this.tools).map(([name, toolDef]) => {
      // Extract description and parameters from the tool definition
      const description = toolDef.description || "";
      const inputSchema = toolDef.parameters || {};
      const enabled = !this.settings.disabledTools.has(name);

      return {
        name,
        description,
        inputSchema,
        enabled,
      };
    });

    return {
      systemPrompt: this.systemPrompt,
      tools: toolsInfo,
    };
  }

  // ============================================================================
  // Message Processing
  // ============================================================================

  /**
   * Process a user message and return the agent's response.
   */
  async sendMessage(userMessage: string): Promise<AgentMessageResult> {
    const messageId = `msg-${Date.now()}`;
    const startTime = Date.now();
    const steps: ReActStep[] = [];
    let stepCount = 0;

    // Initialize stats
    const stats: AgentMessageStats = {
      messageId,
      userMessage,
      startTime,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      status: "running",
    };

    // Reset stop flag
    this.shouldStop = false;

    // Set state to generating
    this.state = AgentStateEnum.GENERATING;

    try {
      // Add user message to history
      this.messages.push({
        role: "user",
        content: userMessage,
      });

      // Create begin step (text type)
      steps.push({
        type: "text",
        messageId,
        stepId: `${messageId}-begin`,
        timestamp: Date.now(),
        content: `[User] ${userMessage}`,
      });

      // Call the model with tools
      const result = await generateText({
        model: this.model,
        system: this.systemPrompt,
        messages: this.messages,
        tools: this.tools,
        maxSteps: this.maxSteps,
        onStepFinish: async (event) => {
          stepCount++;

          // Check for stop
          if (this.shouldStop) {
            return;
          }

          // Add text step if there's text
          if (event.text) {
            steps.push({
              type: "text",
              messageId,
              stepId: `${messageId}-step-${stepCount}-text`,
              timestamp: Date.now(),
              content: event.text,
            });
          }

          // Add tool call steps
          if (event.toolCalls) {
            for (const toolCall of event.toolCalls) {
              steps.push({
                type: "tool-call",
                messageId,
                stepId: `${messageId}-step-${stepCount}-call-${toolCall.toolCallId}`,
                timestamp: Date.now(),
                toolName: toolCall.toolName,
                input: toolCall.args,
                toolCallId: toolCall.toolCallId,
              });
            }
          }

          // Add tool result steps
          if (event.toolResults) {
            for (const toolResult of event.toolResults) {
              steps.push({
                type: "tool-result",
                messageId,
                stepId: `${messageId}-step-${stepCount}-result-${toolResult.toolCallId}`,
                timestamp: Date.now(),
                toolCallId: toolResult.toolCallId,
                result: toolResult.result,
                isError: !toolResult.result?.success,
              });
            }
          }

          // Update stats
          if (event.usage) {
            stats.totalInputTokens += event.usage.promptTokens;
            stats.totalOutputTokens += event.usage.completionTokens;
            stats.totalTokens += event.usage.totalTokens;
          }
        },
      });

      // Create end step (text type with final response)
      steps.push({
        type: "text",
        messageId,
        stepId: `${messageId}-end`,
        timestamp: Date.now(),
        content: result.text,
      });

      // Add assistant response to history
      this.messages.push({
        role: "assistant",
        content: result.text,
      });

      // Update final stats
      stats.endTime = Date.now();
      stats.stepCount = stepCount;
      stats.status = this.shouldStop ? "stopped" : "completed";

      return {
        response: result.text,
        steps,
        usage: {
          inputTokens: stats.totalInputTokens,
          outputTokens: stats.totalOutputTokens,
          totalTokens: stats.totalTokens,
        },
        stats,
        stopped: this.shouldStop,
      };
    } catch (error: any) {
      // Handle error
      stats.endTime = Date.now();
      stats.stepCount = stepCount;
      stats.status = "error";
      stats.errorMessage = error.message || String(error);

      return {
        response: "",
        steps,
        usage: {
          inputTokens: stats.totalInputTokens,
          outputTokens: stats.totalOutputTokens,
          totalTokens: stats.totalTokens,
        },
        stats,
        stopped: this.shouldStop,
        error: stats.errorMessage,
      };
    } finally {
      this.state = AgentStateEnum.AVAILABLE;
    }
  }

  /**
   * Stop the current message processing.
   */
  stop(): void {
    this.shouldStop = true;
    this.state = AgentStateEnum.STOPPING;
  }

  /**
   * Clear conversation history.
   */
  clearHistory(): void {
    this.messages = [];
  }

  /**
   * Reset the agent (clear history and workflow).
   */
  reset(): void {
    this.messages = [];
    this.workflowState.reset();
  }

}
