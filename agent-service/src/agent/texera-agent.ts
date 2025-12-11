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

import { generateText, type ModelMessage, type LanguageModel, stepCountIs } from "ai";
import { WorkflowState } from "../workflow/workflow-state";
import { OperatorMetadataStore } from "../tools/metadata-tools";
import { AgentActionManager } from "./agent-action-manager";
import type {
  AgentSettings,
  ReActStep,
  AgentMessageStats,
  TokenUsage,
  AgentAction,
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
  type ToolContext,
} from "../tools/workflow-tools";
import {
  createListAllAvailableOperatorTypesTool,
  createGetOperatorSchemaTool,
  TOOL_NAME_LIST_ALL_AVAILABLE_OPERATOR_TYPES,
  TOOL_NAME_GET_OPERATOR_SCHEMA,
} from "../tools/metadata-tools";
// Execution is now stateless via HTTP - tools create their own ExecutionClient per request

// ============================================================================
// Agent Configuration
// ============================================================================

export interface TexeraAgentConfig {
  /** Language model to use */
  model: LanguageModel;
  /** Agent ID */
  agentId: string;
  /** Agent display name */
  agentName?: string;
  /** Custom system prompt (optional, defaults to COPILOT_SYSTEM_PROMPT) */
  systemPrompt?: string;
  /** Maximum number of steps per message */
  maxSteps?: number;
  /** Pre-initialized metadata store (optional, uses global singleton if not provided) */
  metadataStore?: OperatorMetadataStore;
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

/** Callback for receiving ReActStep updates */
export type ReActStepCallback = (step: ReActStep) => void;

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
  // Uses global singleton - initialized once at server startup
  private metadataStore: OperatorMetadataStore;
  // Agent action manager for tracking workflow modifications
  private agentActionManager: AgentActionManager;

  // Configuration
  private model: LanguageModel;
  private systemPrompt: string;
  private maxSteps: number;
  private settings: AgentSettings;

  // Conversation history
  private messages: ModelMessage[] = [];

  // ReActSteps - accumulated reasoning steps
  private reActSteps: ReActStep[] = [];

  // Delegate configuration for backend operations
  private delegateConfig?: { userToken: string; workflowId: number; workflowName?: string };

  // Callback for streaming ReActSteps
  private stepCallback: ReActStepCallback | null = null;

  // Message counter for generating unique IDs
  private messageCounter = 0;

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
    // Use provided metadata store or global singleton
    this.metadataStore = config.metadataStore || OperatorMetadataStore.getInstance();
    // Initialize agent action manager
    this.agentActionManager = new AgentActionManager();

    // Initialize settings
    this.settings = {
      ...DEFAULT_AGENT_SETTINGS,
      systemPrompt: this.systemPrompt,
    };

    // Initialize tools - will have operator schemas if metadata store is already initialized
    this.tools = this.createTools();
  }

  /**
   * Initialize the agent by loading operator metadata from the backend.
   * If the metadata store is already initialized (e.g., global singleton),
   * this just rebuilds the tools with the existing metadata.
   */
  async initialize(): Promise<void> {
    try {
      // Only fetch from backend if not already initialized
      if (!this.metadataStore.isInitialized()) {
        await this.metadataStore.initializeFromBackend();
      }
      // Rebuild tools with loaded metadata
      this.tools = this.createTools();
      console.log(`[TexeraAgent ${this.agentId}] Initialized with ${this.metadataStore.getOperatorCount()} operators`);
    } catch (error) {
      console.error(`[TexeraAgent ${this.agentId}] Failed to initialize metadata:`, error);
      // Continue with empty metadata - tools will still work but addOperator will fail
    }
  }

  // ============================================================================
  // Tool Creation
  // ============================================================================

  private createTools(): Record<string, any> {
    // Get operator schemas map for addOperator tool
    // Each entry needs both jsonSchema and additionalMetadata for port info
    const operatorSchemas = new Map<string, any>();
    for (const type of Object.keys(this.metadataStore.getAllOperatorTypes())) {
      const jsonSchema = this.metadataStore.getSchema(type);
      const additionalMetadata = this.metadataStore.getAdditionalMetadata(type);
      if (jsonSchema) {
        operatorSchemas.set(type, { jsonSchema, additionalMetadata });
      }
    }

    // Build tool context for agent action tracking
    const context: ToolContext = {
      metadataStore: this.metadataStore,
      agentActionManager: this.agentActionManager,
      agentId: this.agentId,
      agentName: this.agentName,
      workflowMetadata: this.delegateConfig
        ? { wid: this.delegateConfig.workflowId, name: this.delegateConfig.workflowName }
        : undefined,
    };

    // Workflow and metadata tools
    // Note: Execution tools are now handled via stateless HTTP requests, not via the agent
    const tools: Record<string, any> = {
      [TOOL_NAME_GET_CURRENT_WORKFLOW]: createGetCurrentWorkflowTool(this.workflowState),
      [TOOL_NAME_ADD_OPERATOR]: createAddOperatorTool(this.workflowState, operatorSchemas, context),
      [TOOL_NAME_ADD_LINK]: createAddLinkTool(this.workflowState, context),
      [TOOL_NAME_MODIFY_OPERATOR]: createModifyOperatorTool(this.workflowState, context),
      [TOOL_NAME_DELETE_FROM_WORKFLOW]: createDeleteFromWorkflowTool(this.workflowState, context),
      [TOOL_NAME_LIST_ALL_AVAILABLE_OPERATOR_TYPES]: createListAllAvailableOperatorTypesTool(this.metadataStore),
      [TOOL_NAME_GET_OPERATOR_SCHEMA]: createGetOperatorSchemaTool(this.metadataStore),
    };

    return tools;
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

  getAgentActionManager(): AgentActionManager {
    return this.agentActionManager;
  }

  /**
   * Get all agent actions.
   */
  getAgentActions(): AgentAction[] {
    return this.agentActionManager.getAllAgentActions();
  }

  getMessages(): ModelMessage[] {
    return [...this.messages];
  }

  /**
   * Get all accumulated ReActSteps.
   */
  getReActSteps(): ReActStep[] {
    return [...this.reActSteps];
  }

  /**
   * Set a callback to receive ReActStep updates in real-time.
   * @param callback - Function to call when a new step is added
   */
  setStepCallback(callback: ReActStepCallback | null): void {
    this.stepCallback = callback;
  }

  /**
   * Add a ReActStep and notify the callback if set.
   */
  private addStep(step: ReActStep): void {
    this.reActSteps.push(step);
    if (this.stepCallback) {
      this.stepCallback(step);
    }
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
   * Load workflow from backend and refresh state.
   * Called before processing each message to ensure we have the latest workflow.
   */
  async refreshWorkflowFromBackend(): Promise<void> {
    if (!this.delegateConfig?.workflowId || !this.delegateConfig?.userToken) {
      return;
    }

    try {
      const { retrieveWorkflow } = await import("../api/workflow-api");
      const workflow = await retrieveWorkflow(
        this.delegateConfig.userToken,
        this.delegateConfig.workflowId
      );
      this.workflowState.setWorkflowContent(workflow.content);
      console.log(`[TexeraAgent ${this.agentId}] Refreshed workflow ${this.delegateConfig.workflowId} from backend`);

      // Trigger compilation to refresh schemas
      await this.compileWorkflow();
    } catch (error) {
      console.warn(`[TexeraAgent ${this.agentId}] Failed to refresh workflow from backend:`, error);
    }
  }

  /**
   * Compile the current workflow to get schemas.
   */
  private async compileWorkflow(): Promise<void> {
    try {
      const { compileWorkflowAsync } = await import("../api/compile-api");
      const { CompilationState } = await import("../workflow/workflow-state");
      const logicalPlan = this.workflowState.toLogicalPlan();

      if (logicalPlan.operators.length === 0) {
        this.workflowState.setCompilationState({ state: CompilationState.Uninitialized });
        return;
      }

      const response = await compileWorkflowAsync(logicalPlan);
      if (!response) {
        this.workflowState.setCompilationState({ state: CompilationState.Uninitialized });
        return;
      }

      this.workflowState.setCompilationState(
        response.physicalPlan
          ? { state: CompilationState.Succeeded, operatorOutputSchemas: response.operatorOutputSchemas }
          : { state: CompilationState.Failed, operatorOutputSchemas: response.operatorOutputSchemas, operatorErrors: response.operatorErrors }
      );
    } catch (error) {
      console.warn(`[TexeraAgent ${this.agentId}] Compilation failed:`, error);
    }
  }

  /**
   * Set the delegate configuration for backend operations.
   * This also rebuilds tools to include the workflow metadata in tool context.
   */
  setDelegateConfig(config: { userToken: string; workflowId: number; workflowName?: string }): void {
    this.delegateConfig = config;
    // Rebuild tools with updated workflow metadata in context
    this.tools = this.createTools();
  }

  /**
   * Get the delegate configuration.
   */
  getDelegateConfig(): { userToken: string; workflowId: number; workflowName?: string } | undefined {
    return this.delegateConfig;
  }

  /**
   * Process a user message and return the agent's response.
   * ReActSteps are accumulated internally and streamed via the callback if set.
   * Before processing, loads the latest workflow from backend and compiles it.
   */
  async sendMessage(userMessage: string): Promise<AgentMessageResult> {
    const messageId = `msg-${this.agentId}-${++this.messageCounter}-${Date.now()}`;
    const startTime = Date.now();
    let stepIndex = 0;

    // Load latest workflow from backend and compile to refresh schemas
    await this.refreshWorkflowFromBackend();

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

      // Create user message step (stepId 0)
      const userStep: ReActStep = {
        messageId,
        stepId: 0,
        timestamp: Date.now(),
        role: "user",
        content: userMessage,
        isBegin: true,
        isEnd: true,
      };
      this.addStep(userStep);

      let isFirstStep = true;

      // Call the model with tools
      const result = await generateText({
        model: this.model,
        system: this.systemPrompt,
        messages: this.messages,
        tools: this.tools,
        stopWhen: stepCountIs(this.maxSteps),
        onStepFinish: async ({ text, toolCalls, toolResults, usage }) => {
          // Check for stop
          if (this.shouldStop) {
            return;
          }

          stepIndex++; // Increment first since user message is step 0

          // Build tool calls array in the format expected by frontend
          const formattedToolCalls = toolCalls?.map((tc) => ({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            input: tc.input,
          }));

          // Build tool results array in the format expected by frontend
          const formattedToolResults = toolResults?.map((tr) => ({
            toolCallId: tr.toolCallId,
            output: tr.output,
            isError: !(tr.output as any)?.success,
          }));

          // Build operator access map from tool results
          const operatorAccess: Record<number, any> = {};
          if (toolResults) {
            toolResults.forEach((tr, index) => {
              const output = tr.output as any;
              if (output && (output.viewedOperatorIds || output.addedOperatorIds || output.modifiedOperatorIds)) {
                operatorAccess[index] = {
                  viewedOperatorIds: output.viewedOperatorIds || [],
                  addedOperatorIds: output.addedOperatorIds || [],
                  modifiedOperatorIds: output.modifiedOperatorIds || [],
                };
              }
            });
          }

          // Create agent step with all info combined
          const agentStep: ReActStep = {
            messageId,
            stepId: stepIndex,
            timestamp: Date.now(),
            role: "agent",
            content: text || "",
            isBegin: isFirstStep,
            isEnd: false, // Will be updated in the final step
            toolCalls: formattedToolCalls,
            toolResults: formattedToolResults,
            usage: usage ? {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            } : undefined,
            operatorAccess: Object.keys(operatorAccess).length > 0 ? operatorAccess : undefined,
          };
          this.addStep(agentStep);

          isFirstStep = false;

          // Update stats
          if (usage) {
            stats.totalInputTokens = usage.inputTokens || 0;
            stats.totalOutputTokens = usage.outputTokens || 0;
            stats.totalTokens = usage.totalTokens || 0;
          }
        },
      });

      // Mark the last step as isEnd: true (instead of creating a duplicate final step)
      if (this.reActSteps.length > 0) {
        const lastStep = this.reActSteps[this.reActSteps.length - 1];
        if (lastStep.messageId === messageId && lastStep.role === "agent") {
          lastStep.isEnd = true;
        }
      }

      // Add assistant response to history
      this.messages.push({
        role: "assistant",
        content: result.text,
      });

      // TODO: add the whole message history into the history by doing:
         this.messages.push(...result.response.messages);

      // Update final stats
      stats.endTime = Date.now();
      stats.stepCount = stepIndex;
      stats.status = this.shouldStop ? "stopped" : "completed";
      if (result.usage) {
        stats.totalInputTokens = result.usage.inputTokens || 0;
        stats.totalOutputTokens = result.usage.outputTokens || 0;
        stats.totalTokens = result.usage.totalTokens || 0;
      }

      // Return steps for this message only
      const messageSteps = this.reActSteps.filter(s => s.messageId === messageId);

      return {
        response: result.text,
        steps: messageSteps,
        usage: {
          inputTokens: stats.totalInputTokens,
          outputTokens: stats.totalOutputTokens,
          totalTokens: stats.totalTokens,
        },
        stats,
        stopped: this.shouldStop,
      };
    } catch (error: any) {
      // Handle error - add error step
      stepIndex++;
      const errorStep: ReActStep = {
        messageId,
        stepId: stepIndex,
        timestamp: Date.now(),
        role: "agent",
        content: `Error: ${error.message || String(error)}`,
        isBegin: false,
        isEnd: true,
      };
      this.addStep(errorStep);

      // Update stats
      stats.endTime = Date.now();
      stats.stepCount = stepIndex;
      stats.status = "error";
      stats.errorMessage = error.message || String(error);

      const messageSteps = this.reActSteps.filter(s => s.messageId === messageId);

      return {
        response: "",
        steps: messageSteps,
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
   * Clear conversation history and ReActSteps.
   */
  clearHistory(): void {
    this.messages = [];
    this.reActSteps = [];
  }

  /**
   * Reset the agent (clear history, ReActSteps, and workflow).
   */
  reset(): void {
    this.messages = [];
    this.reActSteps = [];
    this.workflowState.reset();
  }

  /**
   * Cleanup and disconnect any resources.
   * This properly cleans up RxJS subscriptions via workflowState.destroy().
   */
  destroy(): void {
    // Cleanup workflow state (unsubscribes all RxJS subscriptions, completes subjects)
    this.workflowState.destroy();

    // Cleanup agent action manager
    this.agentActionManager.destroy();

    // Clear conversation history
    this.messages = [];
    this.reActSteps = [];
  }

}
