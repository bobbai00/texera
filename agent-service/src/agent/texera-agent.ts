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
import type {
  AgentSettings,
  ReActStep,
  AgentMessageStats,
  TokenUsage,
  AgentAction,
  UserInfo,
  TraceContent,
} from "../types/agent";
import {
  AgentState as AgentStateEnum,
  DEFAULT_AGENT_SETTINGS,
  OperatorResultSerializationMode,
  AgentMode,
  ExecutionBackend,
  REPLAY_SKIP_TOOLS,
} from "../types/agent";
import {
  BASE_SYSTEM_PROMPT,
  buildGeneralModeSystemPrompt,
  buildCodeModeSystemPrompt,
  EXAMPLES_STANDARD,
  EXAMPLES_FINE_GRAINED,
  EXAMPLES_PARALLEL,
  EXAMPLES_RESULT_PARAM,
  EXAMPLES_PARALLEL_RESULT_PARAM,
} from "./prompts";
import {
  createGetCurrentWorkflowTool,
  createAddLinkTool,
  createDeleteLinkTool,
  createDeleteOperatorTool,
  TOOL_NAME_GET_CURRENT_WORKFLOW,
  TOOL_NAME_ADD_LINK,
  TOOL_NAME_DELETE_LINK,
  TOOL_NAME_DELETE_OPERATOR,
  type ToolContext,
} from "../tools/workflow-tools";
import { ParallelCallCoordinator } from "../tools/parallel-call-coordinator";
import {
  createAddOperatorTool,
  createModifyOperatorTool,
  TOOL_NAME_ADD_OPERATOR,
  TOOL_NAME_MODIFY_OPERATOR,
} from "../tools/general-op-tools";
import {
  createCreateOrModifyOperatorTool,
  TOOL_NAME_CREATE_OR_MODIFY_OPERATOR,
} from "../tools/code-op-tools";
import {
  createListAllAvailableOperatorTypesTool,
  createGetOperatorSchemaTool,
  TOOL_NAME_LIST_ALL_AVAILABLE_OPERATOR_TYPES,
  TOOL_NAME_GET_OPERATOR_SCHEMA,
} from "../tools/metadata-tools";
import {
  createExecuteOperatorTool,
  executeOperatorAndFormat,
  TOOL_NAME_EXECUTE_OPERATOR,
  type ExecutionConfig,
} from "../tools/execution-tools";
import { trimNonFrontierResults } from "./context-optimization";
import { filterLatestOnlyMessages } from "./latest-only-filter";

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
  /** Model type identifier (e.g., "gpt-4-turbo") */
  modelType: string;
  /** Agent ID */
  agentId: string;
  /** Agent display name */
  agentName?: string;
  /** Custom system prompt (optional, defaults to BASE_SYSTEM_PROMPT) */
  systemPrompt?: string;
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
  readonly modelType: string;
  readonly createdAt: Date;

  // State
  private state: AgentStateEnum = AgentStateEnum.AVAILABLE;
  private workflowState: WorkflowState;
  // Uses global singleton - initialized once at server startup
  private metadataStore: OperatorMetadataStore;
  // Agent action manager for tracking workflow modifications
  private agentActionManager: AgentActionManager;

  // Server-managed state (for HTTP/WebSocket handling)
  /** RxJS subscription for agent action streaming */
  private agentActionSubscription: Subscription | null = null;
  /** Active WebSocket connections for this agent */
  private websockets: Set<any> = new Set();

  // Configuration
  private model: LanguageModel;
  private systemPrompt: string;
  private settings: AgentSettings;

  // Conversation history
  private messages: ModelMessage[] = [];

  // ReActSteps - accumulated reasoning steps
  private reActSteps: ReActStep[] = [];

  // Delegate configuration for backend operations
  private delegateConfig?: {
    userToken: string;
    userInfo?: UserInfo;
    workflowId: number;
    workflowName?: string;
    computingUnitId?: number;
  };

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
    this.modelType = config.modelType;
    this.createdAt = new Date();
    this.model = config.model;
    this.systemPrompt = config.systemPrompt || BASE_SYSTEM_PROMPT;

    // Initialize state
    this.workflowState = new WorkflowState();
    // Always use global singleton metadata store
    this.metadataStore = OperatorMetadataStore.getInstance();
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

      // Rebuild system prompt based on agent mode
      this.rebuildSystemPrompt();

      // Rebuild tools with loaded metadata
      this.tools = this.createTools();
      console.log(
        `[TexeraAgent ${this.agentId}] Initialized in ${this.settings.agentMode} mode with ${this.metadataStore.getOperatorCount()} operators`
      );
    } catch (error) {
      console.error(`[TexeraAgent ${this.agentId}] Failed to initialize metadata:`, error);
      // Continue with empty metadata - tools will still work but addOperator will fail
    }
  }

  /**
   * Rebuild system prompt based on current agent mode and settings.
   * GENERAL mode: includes operator schemas in the prompt
   * CODE mode: uses structured prompt with examples
   * fineGrainedPrompt: uses stricter atomic operation constraints
   */
  private rebuildSystemPrompt(): void {
    if (this.settings.agentMode === AgentMode.GENERAL) {
      this.systemPrompt = buildGeneralModeSystemPrompt(this.metadataStore);
    } else {
      let examples: string;
      if (this.settings.fineGrainedPrompt) {
        examples = EXAMPLES_FINE_GRAINED;
      } else if (this.settings.parallelToolCalls && this.settings.optionalResultRetrieval) {
        examples = EXAMPLES_PARALLEL_RESULT_PARAM;
      } else if (this.settings.parallelToolCalls) {
        examples = EXAMPLES_PARALLEL;
      } else if (this.settings.optionalResultRetrieval) {
        examples = EXAMPLES_RESULT_PARAM;
      } else {
        examples = EXAMPLES_STANDARD;
      }
      this.systemPrompt = buildCodeModeSystemPrompt(examples);
    }
    this.settings.systemPrompt = this.systemPrompt;
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

    // Build execution config getter for auto-execute feature
    const getExecutionConfig = this.delegateConfig
      ? (): ExecutionConfig => ({
          userToken: this.delegateConfig!.userToken,
          workflowId: this.delegateConfig!.workflowId,
          computingUnitId: this.delegateConfig!.computingUnitId,
          maxOperatorResultCharLimit: this.settings.maxOperatorResultCharLimit,
          maxOperatorResultCellCharLimit: this.settings.maxOperatorResultCellCharLimit,
          serializationMode: this.settings.operatorResultSerializationMode,
          executionTimeoutMs: this.settings.executionTimeoutMs,
          cacheEnabled: this.settings.cacheEnabled,
          executionBackend: this.settings.executionBackend,
          noExecutionMetadata: this.settings.noExecutionMetadata,
        })
      : undefined;

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
        maxOperatorResultCharLimit: this.settings.maxOperatorResultCharLimit,
        toolTimeoutMs: this.settings.toolTimeoutMs,
        executionTimeoutMs: this.settings.executionTimeoutMs,
        optionalResultRetrieval: this.settings.optionalResultRetrieval,
      },
      // Provide execution helper when execution is configured
      executeOperator: getExecutionConfig
        ? (operatorId: string) => executeOperatorAndFormat(this.workflowState, getExecutionConfig(), operatorId)
        : undefined,
      // Coordinate parallel tool calls with inter-operator dependencies
      parallelCoordinator: this.settings.parallelToolCalls
        ? new ParallelCallCoordinator(this.settings.toolTimeoutMs)
        : undefined,
    };

    // Common tools for both modes
    const tools: Record<string, any> = {
      [TOOL_NAME_GET_CURRENT_WORKFLOW]: createGetCurrentWorkflowTool(this.workflowState),
      [TOOL_NAME_DELETE_OPERATOR]: createDeleteOperatorTool(this.workflowState, context),
    };

    // Mode-specific tools
    if (this.settings.agentMode === AgentMode.CODE) {
      // CODE mode: Use unified coding tool (creates or modifies operators)
      tools[TOOL_NAME_CREATE_OR_MODIFY_OPERATOR] = createCreateOrModifyOperatorTool(this.workflowState, operatorSchemas, context);
    } else {
      // GENERAL mode: Use workflow tools (addOperator, modifyOperator) + metadata tools
      tools[TOOL_NAME_ADD_OPERATOR] = createAddOperatorTool(this.workflowState, operatorSchemas, context);
      tools[TOOL_NAME_MODIFY_OPERATOR] = createModifyOperatorTool(this.workflowState, context);
      tools[TOOL_NAME_LIST_ALL_AVAILABLE_OPERATOR_TYPES] = createListAllAvailableOperatorTypesTool(this.metadataStore, true);
      tools[TOOL_NAME_GET_OPERATOR_SCHEMA] = createGetOperatorSchemaTool(this.metadataStore);
      tools[TOOL_NAME_ADD_LINK] = createAddLinkTool(this.workflowState, context);
      tools[TOOL_NAME_DELETE_LINK] = createDeleteLinkTool(this.workflowState, context);
    }

    // Add execution tools if delegateConfig is available (requires user token and workflow ID)
    if (getExecutionConfig) {
      tools[TOOL_NAME_EXECUTE_OPERATOR] = createExecuteOperatorTool(this.workflowState, getExecutionConfig);
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

  // ============================================================================
  // WebSocket Management (for server use)
  // ============================================================================

  /**
   * Get all active WebSocket connections for this agent.
   */
  getWebsockets(): Set<any> {
    return this.websockets;
  }

  /**
   * Add a WebSocket connection to this agent.
   */
  addWebsocket(ws: any): void {
    this.websockets.add(ws);
  }

  /**
   * Remove a WebSocket connection from this agent.
   */
  removeWebsocket(ws: any): void {
    this.websockets.delete(ws);
  }

  // ============================================================================
  // Agent Action Subscription Management (for server use)
  // ============================================================================

  /**
   * Set the agent action subscription for streaming.
   */
  setAgentActionSubscription(subscription: Subscription | null): void {
    this.agentActionSubscription = subscription;
  }

  /**
   * Get the agent action subscription.
   */
  getAgentActionSubscription(): Subscription | null {
    return this.agentActionSubscription;
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
    maxOperatorResultCharLimit?: number;
    maxOperatorResultCellCharLimit?: number;
    operatorResultSerializationMode?: OperatorResultSerializationMode;
    toolTimeoutMs?: number;
    executionTimeoutMs?: number;
    disabledTools?: Set<string>;
    maxSteps?: number;
    agentMode?: AgentMode;
    fineGrainedPrompt?: boolean;
    enableContextOptimization?: boolean;
    frontierDepth?: number;
    trimmedResultCharLimit?: number;
    cacheEnabled?: boolean;
    executionBackend?: ExecutionBackend;
    latestOnly?: boolean;
    dynamicDepthEnabled?: boolean;
    parallelToolCalls?: boolean;
    optionalResultRetrieval?: boolean;
    noExecutionMetadata?: boolean;
  }): void {
    let promptNeedsRebuild = false;

    if (updates.maxOperatorResultCharLimit !== undefined) {
      this.settings.maxOperatorResultCharLimit = updates.maxOperatorResultCharLimit;
    }
    if (updates.maxOperatorResultCellCharLimit !== undefined) {
      this.settings.maxOperatorResultCellCharLimit = updates.maxOperatorResultCellCharLimit;
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
    if (updates.agentMode !== undefined && updates.agentMode !== this.settings.agentMode) {
      this.settings.agentMode = updates.agentMode;
      promptNeedsRebuild = true;
    }
    if (updates.fineGrainedPrompt !== undefined && updates.fineGrainedPrompt !== this.settings.fineGrainedPrompt) {
      this.settings.fineGrainedPrompt = updates.fineGrainedPrompt;
      promptNeedsRebuild = true;
    }
    if (updates.enableContextOptimization !== undefined) {
      this.settings.enableContextOptimization = updates.enableContextOptimization;
    }
    if (updates.frontierDepth !== undefined) {
      this.settings.frontierDepth = Math.max(1, updates.frontierDepth);
    }
    if (updates.trimmedResultCharLimit !== undefined) {
      this.settings.trimmedResultCharLimit = Math.max(0, updates.trimmedResultCharLimit);
    }
    if (updates.cacheEnabled !== undefined) {
      this.settings.cacheEnabled = updates.cacheEnabled;
    }
    if (updates.executionBackend !== undefined) {
      this.settings.executionBackend = updates.executionBackend;
    }
    if (updates.latestOnly !== undefined) {
      this.settings.latestOnly = updates.latestOnly;
    }
    if (updates.dynamicDepthEnabled !== undefined) {
      this.settings.dynamicDepthEnabled = updates.dynamicDepthEnabled;
    }
    if (updates.parallelToolCalls !== undefined && updates.parallelToolCalls !== this.settings.parallelToolCalls) {
      this.settings.parallelToolCalls = updates.parallelToolCalls;
      promptNeedsRebuild = true;
    }
    if (updates.optionalResultRetrieval !== undefined && updates.optionalResultRetrieval !== this.settings.optionalResultRetrieval) {
      this.settings.optionalResultRetrieval = updates.optionalResultRetrieval;
      promptNeedsRebuild = true;
    }
    if (updates.noExecutionMetadata !== undefined) {
      this.settings.noExecutionMetadata = updates.noExecutionMetadata;
    }

    // If mode or fineGrainedPrompt changed, rebuild system prompt
    if (promptNeedsRebuild) {
      this.rebuildSystemPrompt();
    }

    // Rebuild tools with updated settings
    this.tools = this.createTools();
    console.log(
      `[TexeraAgent ${this.agentId}] Settings updated: ` +
        `mode=${this.settings.agentMode}, ` +
        `fineGrainedPrompt=${this.settings.fineGrainedPrompt}, ` +
        `maxOperatorResultCharLimit=${this.settings.maxOperatorResultCharLimit}, ` +
        `maxOperatorResultCellCharLimit=${this.settings.maxOperatorResultCellCharLimit}`
    );
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
    userInfo?: UserInfo;
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
    | { userToken: string; userInfo?: UserInfo; workflowId: number; workflowName?: string; computingUnitId?: number }
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
   *
   * @param userMessage - The user's message
   * @param contextOperatorIds - Optional operator IDs to filter context.
   *                             If provided, relevant ReActSteps are prepended as text context.
   */
  async sendMessage(userMessage: string, contextOperatorIds?: string[]): Promise<AgentMessageResult> {
    const messageId = `msg-${this.agentId}-${++this.messageCounter}-${Date.now()}`;
    const startTime = Date.now();
    let stepIndex = 0;

    // Load latest workflow from backend
    await this.refreshWorkflowFromBackend();

    // Build the actual message to send - prepend relevant context if operator IDs provided
    let actualUserMessage = userMessage;
    if (contextOperatorIds && contextOperatorIds.length > 0) {
      const contextText = this.buildContextText(contextOperatorIds);
      if (contextText) {
        actualUserMessage = `${contextText}\n\n${userMessage}`;
        console.log(
          `[TexeraAgent ${this.agentId}] Prepended context for operators [${contextOperatorIds.join(", ")}]`
        );
      }
    }

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
      // Add user message to history (with context prepended if applicable)
      this.messages.push({
        role: "user",
        content: actualUserMessage,
      });

      // Create user message step (stepId 0) - show original message for display
      // Estimate input tokens for the user message (rough approximation: ~4 chars per token)
      const estimatedInputTokens = Math.ceil(actualUserMessage.length / 4);
      const userStep: ReActStep = {
        messageId,
        stepId: 0,
        timestamp: Date.now(),
        role: "user",
        content: userMessage, // Original message for display
        actualContent: actualUserMessage !== userMessage ? actualUserMessage : undefined, // Full message with context if different
        isBegin: true,
        isEnd: true,
        usage: {
          inputTokens: estimatedInputTokens,
          outputTokens: 0,
          totalTokens: estimatedInputTokens,
        },
      };
      this.addStep(userStep);

      let isFirstStep = true;
      let lastPreparedMessages: ModelMessage[] | undefined;

      // Call the model with tools - uses full message history
      const result = await generateText({
        model: this.model,
        system: this.systemPrompt,
        messages: this.messages,
        tools: this.tools,
        stopWhen: stepCountIs(this.settings.maxSteps),
        prepareStep: (this.settings.enableContextOptimization || this.settings.latestOnly)
          ? ({ stepNumber, messages: currentMessages }) => {
              if (stepNumber === 0) return undefined;
              let processed = currentMessages;
              // latestOnly first: removes whole tool-call/result pairs for stale operators
              if (this.settings.latestOnly) {
                processed = filterLatestOnlyMessages(processed, this.workflowState);
              }
              // context optimization second: trims execution result sections
              if (this.settings.enableContextOptimization) {
                const effectiveDepth = this.settings.dynamicDepthEnabled
                  ? this.workflowState.computeAveragePathLength()
                  : this.settings.frontierDepth;
                processed = trimNonFrontierResults(
                  processed,
                  this.workflowState,
                  effectiveDepth,
                  this.settings.agentMode,
                  this.settings.trimmedResultCharLimit
                );
              }
              lastPreparedMessages = processed;
              return { messages: processed };
            }
          : undefined,
        abortSignal: this.abortController?.signal,
        // Note: reasoning_effort is NOT passed here — it's configured per-model in
        // litellm-config.yaml via extra_body to bypass LiteLLM's param validation.
        providerOptions: this.settings.parallelToolCalls
          ? {}
          : {
              openai: { parallelToolCalls: false },
              anthropic: { disableParallelToolUse: true },
              mistral: { parallelToolCalls: false },
            },
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
            inputMessages: lastPreparedMessages,
          };
          lastPreparedMessages = undefined;
          this.addStep(agentStep);

          isFirstStep = false;
          // Note: per-step usage is stored in each ReActStep.usage
          // Final totals are computed from result.totalUsage after generateText completes
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

      // Update final stats - use totalUsage from result (aggregate across all steps)
      // Note: result.usage is only the final step, result.totalUsage is the aggregate
      stats.endTime = Date.now();
      stats.stepCount = stepIndex;
      stats.status = "completed";

      // Prefer totalUsage (aggregate) over accumulated values
      const finalUsage = (result as any).totalUsage || result.usage;
      if (finalUsage) {
        stats.totalInputTokens = finalUsage.inputTokens || finalUsage.promptTokens || 0;
        stats.totalOutputTokens = finalUsage.outputTokens || finalUsage.completionTokens || 0;
        stats.totalTokens = finalUsage.totalTokens || 0;
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

  // ============================================================================
  // Context Filtering Methods (ReActStep-based)
  // ============================================================================

  /**
   * Extract operator IDs that were affected by a ReActStep.
   * Looks at tool results to find operator IDs (added/modified).
   *
   * @param step - The ReActStep to analyze
   * @returns Object with added and modified operator IDs
   */
  private getOperatorIdsFromStep(step: ReActStep): { added: string[]; modified: string[] } {
    const added: string[] = [];
    const modified: string[] = [];

    if (!step.toolResults) {
      return { added, modified };
    }

    for (const result of step.toolResults) {
      if (result.isError || !result.output) continue;

      // Find the corresponding tool call to determine the operation type
      const toolCall = step.toolCalls?.find(tc => tc.toolCallId === result.toolCallId);
      const toolName = toolCall?.toolName || "";

      const outputStr = typeof result.output === "string" ? result.output : JSON.stringify(result.output);

      // Extract operator ID from string patterns like:
      // - "Added operator op-123, number of input ports: 1, number of output ports: 1"
      // - "Operator op-123 modified"
      // Pattern matches operator IDs like "operator-uuid-123" or "op-123"
      const addedMatch = outputStr.match(/Added operator ([a-zA-Z0-9_-]+)/);
      if (addedMatch && (toolName === "addOperator" || toolName.toLowerCase().includes("add"))) {
        added.push(addedMatch[1]);
        continue;
      }

      const modifiedMatch = outputStr.match(/Operator ([a-zA-Z0-9_-]+) modified/);
      if (modifiedMatch && (toolName === "modifyOperator" || toolName.toLowerCase().includes("modify"))) {
        modified.push(modifiedMatch[1]);
        continue;
      }

      // Try JSON parsing as fallback for structured outputs
      try {
        const output = JSON.parse(outputStr);
        if (output.operatorId) {
          if (toolName === "addOperator" || toolName === "addCodeOperator") {
            added.push(output.operatorId);
          } else if (toolName === "modifyOperator" || toolName === "modifyCodeOperator") {
            modified.push(output.operatorId);
          }
        }
      } catch {
        // Not JSON, already handled string patterns above
      }
    }

    return { added, modified };
  }

  /**
   * Get ReActSteps that affected the specified operator IDs.
   *
   * @param operatorIds - The operator IDs to filter by
   * @returns Array of relevant ReActSteps
   */
  public getReActStepsByOperatorIds(operatorIds: string[]): ReActStep[] {
    if (!operatorIds || operatorIds.length === 0) {
      return [...this.reActSteps];
    }

    const operatorIdSet = new Set(operatorIds);
    const relevantSteps: ReActStep[] = [];

    for (const step of this.reActSteps) {
      const { added, modified } = this.getOperatorIdsFromStep(step);

      // Check if any of the step's operators match the requested IDs
      const affectsOperator = [...added, ...modified].some(id => operatorIdSet.has(id));

      if (affectsOperator) {
        relevantSteps.push(step);
      }
    }

    return relevantSteps;
  }

  /**
   * Build context text from relevant ReActSteps for the specified operator IDs.
   * This text is prepended to the user message.
   *
   * @param operatorIds - The operator IDs to filter by
   * @returns Context text string, or empty string if no relevant context
   */
  private buildContextText(operatorIds: string[]): string {
    const relevantSteps = this.getReActStepsByOperatorIds(operatorIds);

    if (relevantSteps.length === 0) {
      return "";
    }

    // Serialize relevant steps to text
    const stepsText = relevantSteps
      .map(step => {
        let text = "";

        // User message
        if (step.role === "user") {
          text = `[User]: ${step.content}`;
        } else {
          // Agent step
          text = `[Agent Step ${step.stepId}]`;
          if (step.content) {
            text += `\nThinking: ${step.content}`;
          }
          if (step.toolCalls && step.toolCalls.length > 0) {
            for (const tc of step.toolCalls) {
              text += `\nTool: ${tc.toolName}`;
              // Only include minimal input info to keep context concise
              if (tc.input) {
                const inputStr = JSON.stringify(tc.input);
                if (inputStr.length < 200) {
                  text += ` - Input: ${inputStr}`;
                }
              }
            }
          }
          if (step.toolResults && step.toolResults.length > 0) {
            for (const tr of step.toolResults) {
              if (!tr.isError && tr.output) {
                const outputStr = typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output);
                // Truncate long outputs
                const truncated = outputStr.length > 300 ? outputStr.substring(0, 300) + "..." : outputStr;
                text += `\nResult: ${truncated}`;
              }
            }
          }
        }

        return text;
      })
      .join("\n\n");

    return `Here is the relevant conversation history for the operators you're asking about:\n\n${stepsText}\n\n---`;
  }

  /**
   * Cleanup and disconnect any resources.
   * This properly cleans up RxJS subscriptions via workflowState.destroy().
   */
  destroy(): void {
    // Cleanup agent action subscription
    if (this.agentActionSubscription) {
      this.agentActionSubscription.unsubscribe();
      this.agentActionSubscription = null;
    }

    // Cleanup workflow change subscription
    if (this.workflowChangeSubscription) {
      this.workflowChangeSubscription.unsubscribe();
      this.workflowChangeSubscription = null;
    }

    // Cleanup workflow state (unsubscribes all RxJS subscriptions, completes subjects)
    this.workflowState.destroy();

    // Cleanup agent action manager
    this.agentActionManager.destroy();

    // Clear websocket connections
    this.websockets.clear();

    // Clear conversation history
    this.messages = [];
    this.reActSteps = [];
  }

  // ============================================================================
  // Trace Replay Methods
  // ============================================================================

  /**
   * Set the agent state (public method for replay).
   */
  setState(state: AgentStateEnum): void {
    this.state = state;
  }

  /**
   * Set the conversation messages directly (for loading trace).
   */
  setMessages(messages: ModelMessage[]): void {
    this.messages = [...messages];
  }

  /**
   * Append a single message to the conversation history.
   */
  appendMessage(message: ModelMessage): void {
    this.messages.push(message);
  }

  /**
   * Add a ReActStep publicly (for replay).
   */
  addReActStepPublic(step: ReActStep): void {
    this.addStep(step);
  }

  /**
   * Execute a single tool by name with the given input.
   * Returns the tool result as a string.
   * @throws Error if tool not found or execution fails
   */
  async executeTool(toolName: string, input: any): Promise<any> {
    const toolDef = this.tools[toolName];
    if (!toolDef) {
      throw new Error(`Tool '${toolName}' not found`);
    }
    if (!toolDef.execute) {
      throw new Error(`Tool '${toolName}' does not have an execute function`);
    }
    return await toolDef.execute(input);
  }

  /**
   * Replay a trace in two phases:
   *
   * Phase 1: Parse all messages and emit ReActSteps
   *   - Tool results are looked up from trace (not executed yet)
   *   - Each assistant message becomes ONE ReActStep
   *   - stepId resets for each user message
   *
   * Phase 2: Execute tool calls to build workflow
   *   - Skip execution tools (executeOperator, getOperatorResult, etc.)
   *   - Abort on any error (no rollback needed)
   *
   * @param trace - The trace content containing messages
   * @param onStep - Callback for each ReActStep generated
   * @param onError - Callback for errors
   * @returns Promise that resolves when replay is complete
   */
  async replayTrace(
    trace: TraceContent,
    onStep: (step: ReActStep) => void,
    onError: (error: string) => void
  ): Promise<void> {
    const messages = trace.messages;

    // ========================================================================
    // Phase 1: Build tool results map and emit ReActSteps
    // ========================================================================

    // Build a map of toolCallId -> tool result from all tool messages
    const toolResultsMap = new Map<string, { output: any; isError: boolean }>();
    for (const message of messages) {
      if (message.role === "tool") {
        const content = message.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "tool-result" && part.toolCallId) {
              // Handle both formats:
              // 1. Direct output: { output: "string" } or { output: {...} }
              // 2. Wrapped output: { output: { type: "text", value: "string" } }
              let rawOutput = part.output || part.result || part.content;
              if (rawOutput && typeof rawOutput === "object" && rawOutput.type === "text" && rawOutput.value !== undefined) {
                rawOutput = rawOutput.value;
              }
              toolResultsMap.set(part.toolCallId, {
                output: rawOutput,
                isError: part.isError || false,
              });
            }
          }
        } else if (message.tool_call_id) {
          // Alternative format: tool message with tool_call_id at message level
          toolResultsMap.set(message.tool_call_id, {
            output: content,
            isError: false,
          });
        }
      }
    }

    // Collect all tool calls for Phase 2 execution
    const allToolCalls: Array<{ toolName: string; toolCallId: string; input: any }> = [];

    let stepId = 0;
    let currentMessageId = "";

    this.state = AgentStateEnum.GENERATING;

    // Emit all ReActSteps
    for (const message of messages) {
      if (message.role === "user") {
        // Generate new message ID and reset stepId for this user message
        currentMessageId = `replay-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        stepId = 0; // Reset stepId for each user message

        // Extract user content
        const userContent =
          typeof message.content === "string" ? message.content : JSON.stringify(message.content);

        // Create user step (stepId 0)
        const userStep: ReActStep = {
          messageId: currentMessageId,
          stepId: stepId++,
          timestamp: Date.now(),
          role: "user",
          content: userContent,
          isBegin: true,
          isEnd: true,
        };

        this.addStep(userStep);
        onStep(userStep);

        // Add to message history
        this.messages.push(message);
      } else if (message.role === "assistant") {
        // Parse assistant message content
        const { textContent, toolCalls } = this.parseAssistantMessage(message);

        // Look up tool results from the map and collect for execution
        const toolCallsForStep: Array<{ toolName: string; toolCallId: string; input: any }> = [];
        const toolResultsForStep: Array<{ toolCallId: string; output: any; isError?: boolean }> = [];

        for (const toolCall of toolCalls) {
          toolCallsForStep.push({
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            input: toolCall.input,
          });

          // Look up the result from the trace
          const result = toolResultsMap.get(toolCall.toolCallId);
          toolResultsForStep.push({
            toolCallId: toolCall.toolCallId,
            output: result?.output ?? "[Result not found in trace]",
            isError: result?.isError ?? false,
          });

          // Collect for Phase 2 execution
          allToolCalls.push(toolCall);
        }

        // Create ONE ReActStep for this assistant message
        // stepId 0 = user, stepId 1 = first assistant step, etc.
        const isFirstAssistantStep = stepId === 1;

        const assistantStep: ReActStep = {
          messageId: currentMessageId,
          stepId: stepId++,
          timestamp: Date.now(),
          role: "agent",
          content: textContent,
          isBegin: isFirstAssistantStep,
          isEnd: true,
          toolCalls: toolCallsForStep.length > 0 ? toolCallsForStep : undefined,
          toolResults: toolResultsForStep.length > 0 ? toolResultsForStep : undefined,
        };

        this.addStep(assistantStep);
        onStep(assistantStep);

        // Add assistant message to history
        this.messages.push(message);
      } else if (message.role === "tool") {
        // Tool messages are already processed into the map
        // Just add to message history for completeness
        this.messages.push(message);
      }
    }

    // ========================================================================
    // Phase 2: Execute tool calls to build workflow
    // ========================================================================

    for (const toolCall of allToolCalls) {
      // Skip execution tools
      if (REPLAY_SKIP_TOOLS.has(toolCall.toolName)) {
        console.log(`[Replay] Skipping execution tool: ${toolCall.toolName}`);
        continue;
      }

      try {
        console.log(`[Replay] Executing tool: ${toolCall.toolName}`);
        await this.executeTool(toolCall.toolName, toolCall.input);
      } catch (error: any) {
        const errorMsg = `Replay aborted: ${toolCall.toolName} failed - ${error.message || String(error)}`;
        console.error(`[Replay] ${errorMsg}`);
        onError(errorMsg);
        this.state = AgentStateEnum.AVAILABLE;
        return; // Abort without rollback
      }
    }

    this.state = AgentStateEnum.AVAILABLE;
    console.log(`[Replay] Completed successfully. Executed ${allToolCalls.length} tool calls.`);
  }

  /**
   * Parse an assistant message to extract text content and tool calls.
   */
  private parseAssistantMessage(message: any): {
    textContent: string;
    toolCalls: Array<{ toolName: string; toolCallId: string; input: any }>;
  } {
    let textContent = "";
    const toolCalls: Array<{ toolName: string; toolCallId: string; input: any }> = [];

    const content = message.content;

    if (typeof content === "string") {
      textContent = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") {
          textContent += part.text || "";
        } else if (part.type === "tool-call") {
          toolCalls.push({
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            input: part.input || part.args || {},
          });
        }
      }
    }

    return { textContent, toolCalls };
  }
}
