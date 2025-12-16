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
 * Texera Agent Service - HTTP Server using Elysia.js
 *
 * Provides REST API endpoints and WebSocket for agent interaction.
 * Supports user delegation mode where agents act on behalf of authenticated users.
 * Uses RxJS for reactive workflow change handling (persistence and compilation).
 *
 * WebSocket endpoint: /api/agents/:id/react
 * - Send message: { type: "message", content: "..." }
 * - Stop: { type: "stop" }
 * - Receive steps: { type: "step", step: ReActStep }
 * - Receive state: { type: "state", state: "AVAILABLE" | "GENERATING" | ... }
 */

import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { createOpenAI } from "@ai-sdk/openai";
import { Subscription } from "rxjs";
import { TexeraAgent } from "./agent/texera-agent";
import { getBackendConfig } from "./api/backend-api";
import { extractUserFromToken, validateToken } from "./api/auth-api";
import { retrieveWorkflow } from "./api/workflow-api";
import { OperatorMetadataStore } from "./tools/metadata-tools";
import type {
  AgentInfo,
  AgentDelegateConfig,
  CreateAgentRequest,
  UpdateAgentSettingsRequest,
  AgentSettingsApi,
  ReActStep,
  AgentAction,
} from "./types/agent";

// ============================================================================
// Configuration
// ============================================================================

const PORT = parseInt(process.env.PORT || "3001");
const API_PREFIX = process.env.API_PREFIX || "/api";
const LLM_API_KEY = process.env.LLM_API_KEY || "dummy";
const MODEL = process.env.MODEL || "gpt-4-turbo";

// ============================================================================
// Agent Management
// ============================================================================

// Extended agent store with delegate configuration
interface StoredAgent {
  agent: TexeraAgent;
  modelType: string;
  createdAt: Date;
  delegate?: AgentDelegateConfig;
  /** RxJS subscription for agent action streaming */
  agentActionSubscription?: Subscription;
  /** Active WebSocket connections for this agent */
  websockets: Set<any>;
}

// Store for active agents
const agentStore = new Map<string, StoredAgent>();
let agentCounter = 0;

/**
 * Create a new agent with optional delegate configuration.
 * When delegate config is provided, workflow changes are automatically persisted.
 * The agent handles workflow change subscriptions internally.
 */
async function createAgentInstance(
  modelType: string,
  customName?: string,
  delegateConfig?: AgentDelegateConfig
): Promise<{ agentId: string; stored: StoredAgent }> {
  const agentId = `agent-${++agentCounter}`;
  const config = getBackendConfig();

  // Use models endpoint as baseURL with /api path
  const openai = createOpenAI({
    baseURL: `${config.modelsEndpoint}/api`,
    apiKey: LLM_API_KEY,
  });

  const agent = new TexeraAgent({
    model: openai.chat(modelType || MODEL),
    agentId,
    agentName: customName || `Agent-${agentId}`,
  });

  // Initialize agent (loads operator metadata from backend and rebuilds tools)
  await agent.initialize();

  const stored: StoredAgent = {
    agent,
    modelType,
    createdAt: new Date(),
    delegate: delegateConfig,
    websockets: new Set(),
  };

  // If in delegate mode with workflowId, load workflow and setup delegate config
  if (delegateConfig?.workflowId && delegateConfig.userToken) {
    try {
      const workflow = await retrieveWorkflow(delegateConfig.userToken, delegateConfig.workflowId);
      delegateConfig.workflowName = workflow.name;

      // Load workflow content into agent's workflow state
      const workflowState = agent.getWorkflowState();
      workflowState.setWorkflowContent(workflow.content);

      // Set delegate config on agent (this sets up workflow change handlers internally)
      agent.setDelegateConfig({
        userToken: delegateConfig.userToken,
        workflowId: delegateConfig.workflowId,
        workflowName: delegateConfig.workflowName,
        computingUnitId: delegateConfig.computingUnitId,
      });

      console.log(`[Server] Loaded workflow ${delegateConfig.workflowId} for agent ${agentId}`);
    } catch (error) {
      console.warn(`[Server] Failed to load workflow ${delegateConfig.workflowId}:`, error);
    }
  }

  // Setup agent action streaming subscription
  stored.agentActionSubscription = setupAgentActionStreaming(agentId, stored);

  agentStore.set(agentId, stored);
  console.log(`[Server] Created new agent: ${agentId} (delegate: ${!!delegateConfig})`);

  return { agentId, stored };
}

/**
 * Setup RxJS subscription for streaming agent actions to WebSocket clients.
 */
function setupAgentActionStreaming(agentId: string, stored: StoredAgent): Subscription {
  const agentActionManager = stored.agent.getAgentActionManager();
  const agentActionStream$ = agentActionManager.getAgentActionStream();

  return agentActionStream$.subscribe((agentAction: AgentAction) => {
    console.log(`[Server] Agent ${agentId} created action: ${agentAction.id} - ${agentAction.summary}`);
    broadcastToAgent(agentId, { type: "agentAction", agentAction });
  });
}

/**
 * Get agent info for API response
 */
function getAgentInfo(agentId: string, stored: StoredAgent): AgentInfo {
  // Get settings from agent and convert to API format
  const agentSettings = stored.agent.getSettings();
  const settingsApi: AgentSettingsApi = {
    maxOperatorResultTokenLimit: agentSettings.maxOperatorResultTokenLimit,
    maxOperatorResultCellTokenLimit: agentSettings.maxOperatorResultCellTokenLimit,
    toolTimeoutSeconds: Math.round(agentSettings.toolTimeoutMs / 1000),
    executionTimeoutMinutes: Math.round(agentSettings.executionTimeoutMs / 60000),
    disabledTools: Array.from(agentSettings.disabledTools),
    maxSteps: agentSettings.maxSteps,
    onlyUseRelationalOperators: agentSettings.onlyUseRelationalOperators,
  };

  return {
    id: agentId,
    name: stored.agent.agentName,
    modelType: stored.modelType,
    state: stored.agent.getState(),
    createdAt: stored.createdAt,
    delegate: stored.delegate
      ? {
          userToken: "***", // Don't expose token
          userInfo: stored.delegate.userInfo,
          workflowId: stored.delegate.workflowId,
          workflowName: stored.delegate.workflowName,
        }
      : undefined,
    settings: settingsApi,
  };
}

/**
 * Get stored agent by ID or throw error
 */
function getStoredAgent(agentId: string): StoredAgent {
  const stored = agentStore.get(agentId);
  if (!stored) {
    throw new Error("Agent not found");
  }
  return stored;
}

// ============================================================================
// Agents Router (mounted at /agents)
// ============================================================================

const agentsRouter = new Elysia({ prefix: "/agents" })
  // List all agents
  .get("/", () => {
    const agentList = Array.from(agentStore.entries()).map(([id, stored]) => getAgentInfo(id, stored));
    return { agents: agentList };
  })

  // Create agent
  .post(
    "/",
    async ({ body }) => {
      const { modelType, name, userToken, workflowId, computingUnitId, settings } = body as CreateAgentRequest;

      if (!modelType) {
        throw new Error("modelType is required");
      }

      // If userToken provided, create delegate config
      let delegateConfig: AgentDelegateConfig | undefined;
      if (userToken) {
        if (!validateToken(userToken)) {
          throw new Error("Invalid or expired token");
        }

        const userInfo = extractUserFromToken(userToken);
        delegateConfig = {
          userToken,
          userInfo,
          workflowId,
          computingUnitId,
        };
      }

      const { agentId, stored } = await createAgentInstance(modelType, name, delegateConfig);

      // Apply initial settings if provided
      if (settings) {
        stored.agent.updateSettings({
          maxOperatorResultTokenLimit: settings.maxOperatorResultTokenLimit,
          maxOperatorResultCellTokenLimit: settings.maxOperatorResultCellTokenLimit,
          toolTimeoutMs: settings.toolTimeoutSeconds ? settings.toolTimeoutSeconds * 1000 : undefined,
          executionTimeoutMs: settings.executionTimeoutMinutes ? settings.executionTimeoutMinutes * 60000 : undefined,
          disabledTools: settings.disabledTools ? new Set(settings.disabledTools) : undefined,
          maxSteps: settings.maxSteps,
          onlyUseRelationalOperators: settings.onlyUseRelationalOperators,
        });
      }

      return getAgentInfo(agentId, stored);
    },
    {
      body: t.Object({
        modelType: t.String(),
        name: t.Optional(t.String()),
        userToken: t.Optional(t.String()),
        workflowId: t.Optional(t.Number()),
        computingUnitId: t.Optional(t.Number()),
        settings: t.Optional(
          t.Object({
            maxOperatorResultTokenLimit: t.Optional(t.Number()),
            maxOperatorResultCellTokenLimit: t.Optional(t.Number()),
            toolTimeoutSeconds: t.Optional(t.Number()),
            executionTimeoutMinutes: t.Optional(t.Number()),
            disabledTools: t.Optional(t.Array(t.String())),
            maxSteps: t.Optional(t.Number()),
            onlyUseRelationalOperators: t.Optional(t.Boolean()),
          })
        ),
      }),
    }
  )

  // Get agent by ID
  .get("/:id", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    return {
      ...getAgentInfo(id, stored),
      workflow: stored.agent.getWorkflowState().getWorkflowContent(),
      messageCount: stored.agent.getMessages().length,
    };
  })

  // Delete agent
  .delete("/:id", ({ params: { id } }) => {
    const stored = agentStore.get(id);
    if (!stored) {
      throw new Error("Agent not found");
    }

    // Unsubscribe agent action subscription if it exists
    if (stored.agentActionSubscription) {
      stored.agentActionSubscription.unsubscribe();
    }

    // Destroy agent (cleans up workflow state, subscriptions, and agent action manager)
    stored.agent.destroy();

    agentStore.delete(id);
    return { deleted: true };
  })

  // Send message to agent (blocking REST API - returns full ModelMessage list)
  .post(
    "/:id/message",
    async ({ params: { id }, body }) => {
      const stored = getStoredAgent(id);
      const { message } = body;

      if (!message || typeof message !== "string") {
        throw new Error("Message is required");
      }

      console.log(`[Server] Agent ${id} received message: ${message.substring(0, 50)}...`);

      const result = await stored.agent.sendMessage(message);

      console.log(`[Server] Agent ${id} completed with ${result.messages.length} messages`);

      return {
        response: result.response,
        messages: stored.agent.getMessages(),
        usage: result.usage,
        stats: result.stats,
        stopped: result.stopped,
        error: result.error,
      };
    },
    {
      body: t.Object({
        message: t.String(),
      }),
    }
  )

  // Get all ReActSteps (for polling fallback or initial load)
  .get("/:id/react-steps", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    return { steps: stored.agent.getReActSteps(), state: stored.agent.getState() };
  })

  // Get all agent actions (for polling fallback or initial load)
  .get("/:id/agent-actions", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    return { agentActions: stored.agent.getAgentActions() };
  })

  // Get workflow
  .get("/:id/workflow", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    return { workflow: stored.agent.getWorkflowState().getWorkflowContent() };
  })

  // Get agent internal state (workflow state as JSON for debugging)
  .get("/:id/state", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    const workflowState = stored.agent.getWorkflowState();
    return {
      agentId: id,
      agentName: stored.agent.agentName,
      agentState: stored.agent.getState(),
      workflow: workflowState.getWorkflowContent(),
      messageCount: stored.agent.getMessages().length,
      reActStepsCount: stored.agent.getReActSteps().length,
      createdAt: stored.createdAt,
      delegate: stored.delegate
        ? {
            workflowId: stored.delegate.workflowId,
            workflowName: stored.delegate.workflowName,
            userInfo: stored.delegate.userInfo,
          }
        : undefined,
    };
  })

  // Get messages
  .get("/:id/messages", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    return { messages: stored.agent.getMessages() };
  })

  // Get system info (system prompt and tools)
  .get("/:id/system-info", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    return stored.agent.getSystemInfo();
  })

  // Stop agent
  .post("/:id/stop", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    stored.agent.stop();
    return { status: "stopping" };
  })

  // Reset agent
  .post("/:id/reset", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    stored.agent.reset();
    return { status: "reset" };
  })

  // Clear messages
  .post("/:id/clear", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    stored.agent.clearHistory();
    return { status: "cleared" };
  })

  // Get agent settings
  .get("/:id/settings", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    const agentSettings = stored.agent.getSettings();
    return {
      maxOperatorResultTokenLimit: agentSettings.maxOperatorResultTokenLimit,
      maxOperatorResultCellTokenLimit: agentSettings.maxOperatorResultCellTokenLimit,
      toolTimeoutSeconds: Math.round(agentSettings.toolTimeoutMs / 1000),
      executionTimeoutMinutes: Math.round(agentSettings.executionTimeoutMs / 60000),
      disabledTools: Array.from(agentSettings.disabledTools),
      maxSteps: agentSettings.maxSteps,
      onlyUseRelationalOperators: agentSettings.onlyUseRelationalOperators,
    };
  })

  // Update agent settings
  .patch(
    "/:id/settings",
    ({ params: { id }, body }) => {
      const stored = getStoredAgent(id);
      const settings = body as UpdateAgentSettingsRequest;

      stored.agent.updateSettings({
        maxOperatorResultTokenLimit: settings.maxOperatorResultTokenLimit,
        maxOperatorResultCellTokenLimit: settings.maxOperatorResultCellTokenLimit,
        toolTimeoutMs: settings.toolTimeoutSeconds !== undefined ? settings.toolTimeoutSeconds * 1000 : undefined,
        executionTimeoutMs:
          settings.executionTimeoutMinutes !== undefined ? settings.executionTimeoutMinutes * 60000 : undefined,
        disabledTools: settings.disabledTools ? new Set(settings.disabledTools) : undefined,
        maxSteps: settings.maxSteps,
        onlyUseRelationalOperators: settings.onlyUseRelationalOperators,
      });

      // Return updated settings
      const agentSettings = stored.agent.getSettings();
      return {
        maxOperatorResultTokenLimit: agentSettings.maxOperatorResultTokenLimit,
        maxOperatorResultCellTokenLimit: agentSettings.maxOperatorResultCellTokenLimit,
        toolTimeoutSeconds: Math.round(agentSettings.toolTimeoutMs / 1000),
        executionTimeoutMinutes: Math.round(agentSettings.executionTimeoutMs / 60000),
        disabledTools: Array.from(agentSettings.disabledTools),
        maxSteps: agentSettings.maxSteps,
        onlyUseRelationalOperators: agentSettings.onlyUseRelationalOperators,
      };
    },
    {
      body: t.Object({
        maxOperatorResultTokenLimit: t.Optional(t.Number()),
        maxOperatorResultCellTokenLimit: t.Optional(t.Number()),
        toolTimeoutSeconds: t.Optional(t.Number()),
        executionTimeoutMinutes: t.Optional(t.Number()),
        maxSteps: t.Optional(t.Number()),
        disabledTools: t.Optional(t.Array(t.String())),
        onlyUseRelationalOperators: t.Optional(t.Boolean()),
      }),
    }
  );

// ============================================================================
// WebSocket Message Types
// ============================================================================

interface WsMessage {
  type: "message" | "stop";
  content?: string;
}

interface WsOutgoingMessage {
  type: "step" | "state" | "error" | "complete" | "init" | "agentAction";
  step?: ReActStep;
  state?: string;
  error?: string;
  steps?: ReActStep[];
  agentAction?: AgentAction;
  agentActions?: AgentAction[];
}

/**
 * Broadcast a message to all WebSocket clients connected to an agent
 */
function broadcastToAgent(agentId: string, message: WsOutgoingMessage): void {
  const stored = agentStore.get(agentId);
  if (!stored) return;

  const jsonMessage = JSON.stringify(message);
  for (const ws of stored.websockets) {
    try {
      ws.send(jsonMessage);
    } catch (error) {
      console.error(`[WS] Failed to send message to client:`, error);
      stored.websockets.delete(ws);
    }
  }
}

// ============================================================================
// Main Application
// ============================================================================

const app = new Elysia()
  .use(cors())
  // Health check (at root, not under prefix)
  .get("/health", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }))
  // Mount agents router under API prefix
  .group(API_PREFIX, app => app.use(agentsRouter))
  // WebSocket endpoint for real-time ReActSteps streaming
  .ws(`${API_PREFIX}/agents/:id/react`, {
    open(ws) {
      const agentId = (ws.data as any).params?.id;
      console.log(`[WS] Client connected to agent ${agentId}`);

      const stored = agentStore.get(agentId);
      if (!stored) {
        ws.send(JSON.stringify({ type: "error", error: "Agent not found" }));
        ws.close();
        return;
      }

      // Add this websocket to the agent's set
      stored.websockets.add(ws);

      // Send initial state, existing steps, and agent actions
      const initMessage: WsOutgoingMessage = {
        type: "init",
        state: stored.agent.getState(),
        steps: stored.agent.getReActSteps(),
        agentActions: stored.agent.getAgentActions(),
      };
      ws.send(JSON.stringify(initMessage));
    },

    async message(ws, messageData) {
      const agentId = (ws.data as any).params?.id;
      const stored = agentStore.get(agentId);

      if (!stored) {
        ws.send(JSON.stringify({ type: "error", error: "Agent not found" }));
        return;
      }

      let msg: WsMessage;
      try {
        msg = typeof messageData === "string" ? JSON.parse(messageData) : (messageData as WsMessage);
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid message format" }));
        return;
      }

      if (msg.type === "stop") {
        stored.agent.stop();
        // Broadcast STOPPING state immediately to all connected clients
        broadcastToAgent(agentId, { type: "state", state: "STOPPING" });
        return;
      }

      if (msg.type === "message") {
        if (!msg.content || typeof msg.content !== "string") {
          ws.send(JSON.stringify({ type: "error", error: "Message content is required" }));
          return;
        }

        console.log(`[WS] Agent ${agentId} received message: ${msg.content.substring(0, 50)}...`);

        // Set up step callback to stream steps in real-time
        stored.agent.setStepCallback((step: ReActStep) => {
          broadcastToAgent(agentId, { type: "step", step });
        });

        // Broadcast GENERATING state immediately before starting processing
        // The agent will set its internal state in sendMessage, but we want frontend to know immediately
        broadcastToAgent(agentId, { type: "state", state: "GENERATING" });

        try {
          const result = await stored.agent.sendMessage(msg.content);

          // Clear the callback
          stored.agent.setStepCallback(null);

          // Get the last step (which now has isEnd: true) and broadcast it
          // This ensures the frontend receives the final step with isEnd: true
          const allSteps = stored.agent.getReActSteps();
          const lastStep = allSteps[allSteps.length - 1];
          if (lastStep && lastStep.isEnd) {
            broadcastToAgent(agentId, { type: "step", step: lastStep });
          }

          // Broadcast completion
          broadcastToAgent(agentId, {
            type: "complete",
            state: stored.agent.getState(),
          });

          console.log(`[WS] Agent ${agentId} completed with ${result.messages.length} steps`);
        } catch (error: any) {
          stored.agent.setStepCallback(null);
          broadcastToAgent(agentId, { type: "error", error: error.message });
        }
      }
    },

    close(ws) {
      const agentId = (ws.data as any).params?.id;
      console.log(`[WS] Client disconnected from agent ${agentId}`);

      const stored = agentStore.get(agentId);
      if (stored) {
        stored.websockets.delete(ws);
      }
    },
  })
  // Error handling
  .onError(({ error, set }) => {
    console.error("[Server] Error:", error);

    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage === "Agent not found") {
      set.status = 404;
      return { error: "Agent not found" };
    }

    if (errorMessage === "Invalid or expired token") {
      set.status = 401;
      return { error: "Invalid or expired token" };
    }

    if (errorMessage === "modelType is required") {
      set.status = 400;
      return { error: "modelType is required" };
    }

    set.status = 500;
    return { error: errorMessage || "Internal server error" };
  })
  .listen(PORT);

// ============================================================================
// Startup Message - Using Elysia's routes property
// ============================================================================

function printStartupMessage() {
  const LINE = "=".repeat(60);
  console.log(LINE);
  console.log("Texera Agent Service (Elysia.js + RxJS)");
  console.log(LINE);
  console.log(`Server running at http://localhost:${PORT}`);
  console.log("");

  // Print routes from Elysia's routes property
  console.log("Registered Routes:");
  const routes = app.routes;

  // Group routes by type (HTTP vs WebSocket)
  const httpRoutes = routes.filter(r => r.method !== "WS");
  const wsRoutes = routes.filter(r => r.method === "WS");

  // Print HTTP routes
  for (const route of httpRoutes) {
    const method = route.method.padEnd(6);
    console.log(`  ${method} ${route.path}`);
  }

  // Print WebSocket routes
  if (wsRoutes.length > 0) {
    console.log("");
    console.log("WebSocket Endpoints:");
    for (const route of wsRoutes) {
      console.log(`  WS     ${route.path}`);
    }
    console.log("         Send: { type: 'message', content: '...' }");
    console.log("         Send: { type: 'stop' }");
    console.log("         Recv: { type: 'step' | 'state' | 'complete' | 'error' | 'init', ... }");
  }

  console.log("");
  console.log("Environment:");
  console.log(`  LLM_API_KEY: ${LLM_API_KEY === "dummy" ? "dummy (default)" : "set"}`);
  console.log(`  MODEL: ${MODEL}`);
  console.log(`  MODELS_ENDPOINT: ${getBackendConfig().modelsEndpoint}`);
  console.log(`  COMPILE_ENDPOINT: ${getBackendConfig().compileEndpoint}`);
  console.log("");
  console.log("Features:");
  console.log("  - Auto-persistence with debounce (500ms)");
  console.log("  - Tools compile workflow on-demand for fresh schemas");
  console.log(LINE);
}

// Initialize global metadata store at startup
async function initializeServices() {
  try {
    console.log("[Server] Initializing global operator metadata store...");
    const metadataStore = await OperatorMetadataStore.initializeGlobal();
    console.log(`[Server] Loaded ${metadataStore.getOperatorCount()} operators into global metadata store`);
  } catch (error) {
    console.warn("[Server] Failed to initialize global metadata store:", error);
    console.warn("[Server] Agents will initialize metadata individually on creation");
  }
}

// Run startup initialization
initializeServices().then(() => {
  printStartupMessage();
});

export default app;
