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
import { Subscription } from "rxjs";
import { debounceTime } from "rxjs/operators";
import { WorkflowState } from "../workflow/workflow-state";
import { OperatorMetadataStore } from "../tools/metadata-tools";
import { AgentActionManager } from "./agent-action-manager";
import type { AgentSettings, ReActStep, AgentMessageStats, TokenUsage, AgentAction } from "../types/agent";
import { AgentState as AgentStateEnum, DEFAULT_AGENT_SETTINGS, OperatorResultSerializationMode } from "../types/agent";
import { COPILOT_SYSTEM_PROMPT, buildCopilotSystemPrompt } from "./prompts";
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
import { createExecuteWorkflowTool, TOOL_NAME_EXECUTE_WORKFLOW, type ExecutionConfig } from "../tools/execution-tools";

// ============================================================================
// Constants
// ============================================================================

/** Debounce interval for auto-persistence (ms) */
const PERSIST_DEBOUNCE_MS = 500;

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
  /** Pre-initialized metadata store (optional, uses global singleton if not provided) */
  metadataStore?: OperatorMetadataStore;
}

// ============================================================================
// Agent Result Types
// ============================================================================

export interface AgentMessageResult {
  /** Final response text */
  response: string;
  /** Full conversation messages from this interaction */
  messages: ModelMessage[];
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
  private settings: AgentSettings;

  // Conversation history
  private messages: ModelMessage[] = [];

  // ReActSteps - accumulated reasoning steps
  private reActSteps: ReActStep[] = [];

  // Delegate configuration for backend operations
  private delegateConfig?: { userToken: string; workflowId: number; workflowName?: string; computingUnitId?: number };

  // Callback for streaming ReActSteps
  private stepCallback: ReActStepCallback | null = null;

  // Message counter for generating unique IDs
  private messageCounter = 0;

  // Tools
  private tools: Record<string, any>;

  // Abort controller for stopping the agent
  private abortController: AbortController | null = null;

  // RxJS subscriptions for workflow change handling (persistence + compilation)
  private workflowChangeSubscription: Subscription | null = null;

  constructor(config: TexeraAgentConfig) {
    this.agentId = config.agentId;
    this.agentName = config.agentName || `Agent-${config.agentId}`;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt || COPILOT_SYSTEM_PROMPT;

    // Initialize state
    this.workflowState = new WorkflowState();
    // Use provided metadata store or global singleton
    this.metadataStore = config.metadataStore || OperatorMetadataStore.getInstance();
    // Initialize agent action manager
    this.agentActionManager = new AgentActionManager();

    // Initialize settings with defaults
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
   * this just rebuilds the tools and system prompt with the existing metadata.
   */
  async initialize(): Promise<void> {
    try {
      // Only fetch from backend if not already initialized
      if (!this.metadataStore.isInitialized()) {
        await this.metadataStore.initializeFromBackend();
      }

      // Rebuild system prompt with operator schemas from metadata store
      this.systemPrompt = buildCopilotSystemPrompt(this.metadataStore);
      this.settings.systemPrompt = this.systemPrompt;

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
      settings: {
        maxOperatorResultTokenLimit: this.settings.maxOperatorResultTokenLimit,
        toolTimeoutMs: this.settings.toolTimeoutMs,
        executionTimeoutMs: this.settings.executionTimeoutMs,
      },
    };

    // Workflow and metadata tools
    const tools: Record<string, any> = {
      [TOOL_NAME_GET_CURRENT_WORKFLOW]: createGetCurrentWorkflowTool(this.workflowState),
      [TOOL_NAME_ADD_OPERATOR]: createAddOperatorTool(this.workflowState, operatorSchemas, context),
      [TOOL_NAME_ADD_LINK]: createAddLinkTool(this.workflowState, context),
      [TOOL_NAME_MODIFY_OPERATOR]: createModifyOperatorTool(this.workflowState, context),
      [TOOL_NAME_DELETE_FROM_WORKFLOW]: createDeleteFromWorkflowTool(this.workflowState, context),
      // [TOOL_NAME_LIST_ALL_AVAILABLE_OPERATOR_TYPES]: createListAllAvailableOperatorTypesTool(
      //   this.metadataStore,
      //   this.settings.onlyUseRelationalOperators
      // ),
      // [TOOL_NAME_GET_OPERATOR_SCHEMA]: createGetOperatorSchemaTool(this.metadataStore),
    };

    // Add execution tools if delegateConfig is available (requires user token and workflow ID)
    if (this.delegateConfig) {
      const executionConfig: ExecutionConfig = {
        userToken: this.delegateConfig.userToken,
        workflowId: this.delegateConfig.workflowId,
        computingUnitId: this.delegateConfig.computingUnitId,
        maxOperatorResultTokenLimit: this.settings.maxOperatorResultTokenLimit,
        maxOperatorResultCellTokenLimit: this.settings.maxOperatorResultCellTokenLimit,
        serializationMode: this.settings.operatorResultSerializationMode,
        restrictOperatorResultToken: this.settings.restrictOperatorResultToken,
        disablePrint: this.settings.disablePrint,
      };
      tools[TOOL_NAME_EXECUTE_WORKFLOW] = createExecuteWorkflowTool(this.workflowState, executionConfig);
    }

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

  /**
   * Get the current agent settings.
   */
  getSettings(): AgentSettings {
    return { ...this.settings };
  }

  /**
   * Update agent settings.
   * Only provided values will be updated.
   */
  updateSettings(updates: {
    maxOperatorResultTokenLimit?: number;
    maxOperatorResultCellTokenLimit?: number;
    operatorResultSerializationMode?: OperatorResultSerializationMode;
    toolTimeoutMs?: number;
    executionTimeoutMs?: number;
    disabledTools?: Set<string>;
    maxSteps?: number;
    onlyUseRelationalOperators?: boolean;
    restrictOperatorResultToken?: boolean;
    disablePrint?: boolean;
  }): void {
    if (updates.maxOperatorResultTokenLimit !== undefined) {
      this.settings.maxOperatorResultTokenLimit = updates.maxOperatorResultTokenLimit;
    }
    if (updates.maxOperatorResultCellTokenLimit !== undefined) {
      this.settings.maxOperatorResultCellTokenLimit = updates.maxOperatorResultCellTokenLimit;
    }
    if (updates.operatorResultSerializationMode !== undefined) {
      this.settings.operatorResultSerializationMode = updates.operatorResultSerializationMode;
    }
    if (updates.toolTimeoutMs !== undefined) {
      this.settings.toolTimeoutMs = updates.toolTimeoutMs;
    }
    if (updates.executionTimeoutMs !== undefined) {
      this.settings.executionTimeoutMs = updates.executionTimeoutMs;
    }
    if (updates.disabledTools !== undefined) {
      this.settings.disabledTools = updates.disabledTools;
    }
    if (updates.maxSteps !== undefined) {
      this.settings.maxSteps = updates.maxSteps;
    }
    if (updates.onlyUseRelationalOperators !== undefined) {
      this.settings.onlyUseRelationalOperators = updates.onlyUseRelationalOperators;
    }
    if (updates.restrictOperatorResultToken !== undefined) {
      this.settings.restrictOperatorResultToken = updates.restrictOperatorResultToken;
    }
    if (updates.disablePrint !== undefined) {
      this.settings.disablePrint = updates.disablePrint;
    }

    // Rebuild tools with updated settings
    this.tools = this.createTools();
    console.log(`[TexeraAgent ${this.agentId}] Settings updated`);
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
      const workflow = await retrieveWorkflow(this.delegateConfig.userToken, this.delegateConfig.workflowId);
      this.workflowState.setWorkflowContent(workflow.content);
      console.log(`[TexeraAgent ${this.agentId}] Refreshed workflow ${this.delegateConfig.workflowId} from backend`);
    } catch (error) {
      console.warn(`[TexeraAgent ${this.agentId}] Failed to refresh workflow from backend:`, error);
    }
  }

  /**
   * Set the delegate configuration for backend operations.
   * This also rebuilds tools to include the workflow metadata in tool context,
   * and sets up workflow change handlers for persistence.
   */
  setDelegateConfig(config: {
    userToken: string;
    workflowId: number;
    workflowName?: string;
    computingUnitId?: number;
  }): void {
    this.delegateConfig = config;

    // Rebuild tools with updated workflow metadata in context and execution tools
    this.tools = this.createTools();

    // Setup workflow change handlers (persistence + compilation)
    this.setupWorkflowChangeHandlers();
  }

  /**
   * Get the delegate configuration.
   */
  getDelegateConfig():
    | { userToken: string; workflowId: number; workflowName?: string; computingUnitId?: number }
    | undefined {
    return this.delegateConfig;
  }

  /**
   * Setup RxJS-based workflow change handling.
   * Sets up auto-persistence with debounce.
   */
  private setupWorkflowChangeHandlers(): void {
    // Cleanup previous subscription if any
    if (this.workflowChangeSubscription) {
      this.workflowChangeSubscription.unsubscribe();
    }

    const subscription = new Subscription();
    const workflowChanged$ = this.workflowState.getWorkflowChangedStream();

    // Auto-persistence with debounce (only if in delegate mode)
    if (this.delegateConfig?.workflowId && this.delegateConfig.userToken) {
      const persistSubscription = workflowChanged$.pipe(debounceTime(PERSIST_DEBOUNCE_MS)).subscribe(async () => {
        if (!this.delegateConfig?.workflowId || !this.delegateConfig.userToken) {
          return;
        }

        try {
          const { persistWorkflow } = await import("../api/workflow-api");
          const workflowContent = this.workflowState.getWorkflowContent();
          await persistWorkflow(
            this.delegateConfig.userToken,
            this.delegateConfig.workflowId,
            this.delegateConfig.workflowName || "Agent Workflow",
            workflowContent
          );
          console.log(`[TexeraAgent ${this.agentId}] Auto-persisted workflow ${this.delegateConfig.workflowId}`);
        } catch (error) {
          console.error(`[TexeraAgent ${this.agentId}] Failed to auto-persist workflow:`, error);
        }
      });

      subscription.add(persistSubscription);
    }

    // Track the subscription
    this.workflowChangeSubscription = subscription;
    this.workflowState.addSubscription(subscription);
  }

  /**
   * Process a user message and return the agent's response.
   * ReActSteps are accumulated internally and streamed via the callback if set.
   * Before processing, loads the latest workflow from backend.
   */
  async sendMessage(userMessage: string): Promise<AgentMessageResult> {
    const messageId = `msg-${this.agentId}-${++this.messageCounter}-${Date.now()}`;
    const startTime = Date.now();
    let stepIndex = 0;

    // Load latest workflow from backend
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

    // Create new abort controller for this message
    this.abortController = new AbortController();

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
        stopWhen: stepCountIs(this.settings.maxSteps),
        abortSignal: this.abortController?.signal,
        onStepFinish: async ({ text, toolCalls, toolResults, usage }) => {
          stepIndex++; // Increment first since user message is step 0

          // Build tool calls array
          const formattedToolCalls = toolCalls?.map(tc => ({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            input: tc.input,
          }));

          // Build tool results array - check for error field to determine if it's an error
          const formattedToolResults = toolResults?.map(tr => ({
            toolCallId: tr.toolCallId,
            output: tr.output,
            isError: !!(tr.output as any)?.error,
          }));

          // Create agent step
          const agentStep: ReActStep = {
            messageId,
            stepId: stepIndex,
            timestamp: Date.now(),
            role: "agent",
            content: text || "",
            isBegin: isFirstStep,
            isEnd: false,
            toolCalls: formattedToolCalls,
            toolResults: formattedToolResults,
            usage: usage
              ? {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  totalTokens: usage.totalTokens,
                }
              : undefined,
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

      // Add the response messages to history
      this.messages.push(...result.response.messages);

      // Update final stats
      stats.endTime = Date.now();
      stats.stepCount = stepIndex;
      stats.status = "completed";
      if (result.usage) {
        stats.totalInputTokens = result.usage.inputTokens || 0;
        stats.totalOutputTokens = result.usage.outputTokens || 0;
        stats.totalTokens = result.usage.totalTokens || 0;
      }

      return {
        response: result.text,
        messages: result.response.messages,
        usage: {
          inputTokens: stats.totalInputTokens,
          outputTokens: stats.totalOutputTokens,
          totalTokens: stats.totalTokens,
        },
        stats,
        stopped: false,
      };
    } catch (error: any) {
      // Check if this was an abort (user requested stop)
      const isAborted = error.name === "AbortError" || this.abortController?.signal.aborted;

      if (isAborted) {
        // Handle stop gracefully
        stepIndex++;
        const stoppedStep: ReActStep = {
          messageId,
          stepId: stepIndex,
          timestamp: Date.now(),
          role: "agent",
          content: "Generation stopped by user.",
          isBegin: false,
          isEnd: true,
        };
        this.addStep(stoppedStep);

        stats.endTime = Date.now();
        stats.stepCount = stepIndex;
        stats.status = "stopped";

        return {
          response: "",
          messages: [],
          usage: {
            inputTokens: stats.totalInputTokens,
            outputTokens: stats.totalOutputTokens,
            totalTokens: stats.totalTokens,
          },
          stats,
          stopped: true,
        };
      }

      // Handle actual error - add error step
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

      return {
        response: "",
        messages: [],
        usage: {
          inputTokens: stats.totalInputTokens,
          outputTokens: stats.totalOutputTokens,
          totalTokens: stats.totalTokens,
        },
        stats,
        stopped: false,
        error: stats.errorMessage,
      };
    } finally {
      this.abortController = null;
      this.state = AgentStateEnum.AVAILABLE;
    }
  }

  /**
   * Stop the current message processing immediately.
   * This aborts any ongoing LLM calls and tool executions.
   */
  stop(): void {
    this.state = AgentStateEnum.STOPPING;
    if (this.abortController) {
      this.abortController.abort();
    }
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
    // Cleanup workflow change subscription
    if (this.workflowChangeSubscription) {
      this.workflowChangeSubscription.unsubscribe();
      this.workflowChangeSubscription = null;
    }

    // Cleanup workflow state (unsubscribes all RxJS subscriptions, completes subjects)
    this.workflowState.destroy();

    // Cleanup agent action manager
    this.agentActionManager.destroy();

    // Clear conversation history
    this.messages = [];
    this.reActSteps = [];
  }
}
