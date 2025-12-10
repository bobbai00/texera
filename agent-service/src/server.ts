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
import { debounceTime, switchMap } from "rxjs/operators";
import { from } from "rxjs";
import type { WorkflowCompilationResponse } from "./api/compile-api";
import { TexeraAgent } from "./agent/texera-agent";
import { getBackendConfig } from "./api/backend-api";
import { extractUserFromToken, validateToken } from "./api/auth-api";
import { persistWorkflow, retrieveWorkflow } from "./api/workflow-api";
import { compileWorkflow } from "./api/compile-api";
import { CompilationState, type CompilationStateInfo } from "./workflow/workflow-state";
import type {
  AgentInfo,
  AgentDelegateConfig,
  CreateAgentRequest,
  ReActStep,
} from "./types/agent";

// ============================================================================
// Configuration
// ============================================================================

const PORT = parseInt(process.env.PORT || "3001");
const API_PREFIX = process.env.API_PREFIX || "/api";
const LLM_API_KEY = process.env.LLM_API_KEY || "dummy";
const MODEL = process.env.MODEL || "gpt-4-turbo";

// Debounce intervals (ms)
const PERSIST_DEBOUNCE_MS = 500;
const COMPILATION_DEBOUNCE_MS = 500;

// ============================================================================
// Agent Management
// ============================================================================

// Extended agent store with delegate configuration
interface StoredAgent {
  agent: TexeraAgent;
  modelType: string;
  createdAt: Date;
  delegate?: AgentDelegateConfig;
  /** RxJS subscription for workflow change handling */
  workflowSubscription?: Subscription;
  /** Active WebSocket connections for this agent */
  websockets: Set<any>;
}

// Store for active agents
const agentStore = new Map<string, StoredAgent>();
let agentCounter = 0;

/**
 * Setup RxJS-based workflow change handling for an agent.
 * Uses debounced streams for auto-persistence and compilation.
 * This follows the same pattern as the frontend's WorkflowCompilingService.
 */
function setupWorkflowChangeHandlers(
  agentId: string,
  stored: StoredAgent
): Subscription {
  const workflowState = stored.agent.getWorkflowState();
  const subscription = new Subscription();

  // Get the combined workflow change stream
  const workflowChanged$ = workflowState.getWorkflowChangedStream();

  // 1. Auto-persistence with debounce (only if in delegate mode)
  if (stored.delegate?.workflowId && stored.delegate.userToken) {
    const persistSubscription = workflowChanged$
      .pipe(debounceTime(PERSIST_DEBOUNCE_MS))
      .subscribe(async () => {
        if (!stored.delegate?.workflowId || !stored.delegate.userToken) {
          return;
        }

        try {
          const workflowContent = workflowState.getWorkflowContent();
          await persistWorkflow(
            stored.delegate.userToken,
            stored.delegate.workflowId,
            stored.delegate.workflowName || "Agent Workflow",
            workflowContent
          );
          console.log(`[Server] Auto-persisted workflow ${stored.delegate.workflowId} for agent ${agentId}`);
        } catch (error) {
          console.error(`[Server] Failed to auto-persist workflow for agent ${agentId}:`, error);
        }
      });

    subscription.add(persistSubscription);
  }

  // 2. Compilation trigger with debounce (following frontend pattern)
  const compilationSubscription = workflowChanged$
    .pipe(
      debounceTime(COMPILATION_DEBOUNCE_MS),
      switchMap(() => {
        const logicalPlan = workflowState.toLogicalPlan();
        // Only compile if there are operators
        if (logicalPlan.operators.length === 0) {
          return from([null]);
        }
        return compileWorkflow(logicalPlan);
      })
    )
    .subscribe((response: WorkflowCompilationResponse | null) => {
      if (!response) {
        // No operators or error - set to uninitialized
        workflowState.setCompilationState({
          state: CompilationState.Uninitialized,
        });
        return;
      }

      // Update compilation state based on response
      const compilationState: CompilationStateInfo = response.physicalPlan
        ? {
            state: CompilationState.Succeeded,
            operatorOutputSchemas: response.operatorOutputSchemas,
          }
        : {
            state: CompilationState.Failed,
            operatorOutputSchemas: response.operatorOutputSchemas,
            operatorErrors: response.operatorErrors,
          };

      workflowState.setCompilationState(compilationState);
      console.log(`[Server] Workflow compiled for agent ${agentId}: ${compilationState.state}`);
    });

  subscription.add(compilationSubscription);

  // Track the subscription in the workflow state for cleanup
  workflowState.addSubscription(subscription);

  return subscription;
}

/**
 * Create a new agent with optional delegate configuration.
 * When delegate config is provided, workflow changes are automatically persisted.
 * Uses RxJS for reactive change handling.
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

  // If in delegate mode with workflowId, load workflow
  if (delegateConfig?.workflowId && delegateConfig.userToken) {
    try {
      const workflow = await retrieveWorkflow(delegateConfig.userToken, delegateConfig.workflowId);
      delegateConfig.workflowName = workflow.name;

      // Load workflow content into agent's workflow state
      const workflowState = agent.getWorkflowState();
      workflowState.setWorkflowContent(workflow.content);
      console.log(`[Server] Loaded workflow ${delegateConfig.workflowId} for agent ${agentId}`);
    } catch (error) {
      console.warn(`[Server] Failed to load workflow ${delegateConfig.workflowId}:`, error);
    }
  }

  // Setup RxJS-based workflow change handlers (persistence + compilation)
  stored.workflowSubscription = setupWorkflowChangeHandlers(agentId, stored);

  agentStore.set(agentId, stored);
  console.log(`[Server] Created new agent: ${agentId} (delegate: ${!!delegateConfig})`);

  return { agentId, stored };
}

/**
 * Get agent info for API response
 */
function getAgentInfo(agentId: string, stored: StoredAgent): AgentInfo {
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
      const { modelType, name, userToken, workflowId } = body as CreateAgentRequest;

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
        };
      }

      const { agentId, stored } = await createAgentInstance(modelType, name, delegateConfig);
      return getAgentInfo(agentId, stored);
    },
    {
      body: t.Object({
        modelType: t.String(),
        name: t.Optional(t.String()),
        userToken: t.Optional(t.String()),
        workflowId: t.Optional(t.Number()),
      }),
    }
  )

  // Get agent by ID
  .get("/:id", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    return {
      ...getAgentInfo(id, stored),
      workflow: stored.agent.getWorkflowState().getWorkflowContent(),
      compilationState: stored.agent.getWorkflowState().getCompilationState(),
      messageCount: stored.agent.getMessages().length,
    };
  })

  // Delete agent
  .delete("/:id", ({ params: { id } }) => {
    const stored = agentStore.get(id);
    if (!stored) {
      throw new Error("Agent not found");
    }

    // Cleanup RxJS subscriptions via workflow state destroy
    stored.agent.getWorkflowState().destroy();

    // Also unsubscribe the stored subscription if it exists
    if (stored.workflowSubscription) {
      stored.workflowSubscription.unsubscribe();
    }

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

      console.log(`[Server] Agent ${id} completed with ${result.steps.length} steps`);

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

  // Get workflow
  .get("/:id/workflow", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    return { workflow: stored.agent.getWorkflowState().getWorkflowContent() };
  })

  // Get compilation state
  .get("/:id/compilation", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    return { compilationState: stored.agent.getWorkflowState().getCompilationState() };
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
  });

// ============================================================================
// WebSocket Message Types
// ============================================================================

interface WsMessage {
  type: "message" | "stop";
  content?: string;
}

interface WsOutgoingMessage {
  type: "step" | "state" | "error" | "complete" | "init";
  step?: ReActStep;
  state?: string;
  error?: string;
  steps?: ReActStep[];
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
  .group(API_PREFIX, (app) => app.use(agentsRouter))
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

      // Send initial state and existing steps
      const initMessage: WsOutgoingMessage = {
        type: "init",
        state: stored.agent.getState(),
        steps: stored.agent.getReActSteps(),
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
        // Broadcast state change to all connected clients
        broadcastToAgent(agentId, { type: "state", state: stored.agent.getState() });
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

        // Broadcast state change
        broadcastToAgent(agentId, { type: "state", state: stored.agent.getState() });

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

          console.log(`[WS] Agent ${agentId} completed with ${result.steps.length} steps`);
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
  const httpRoutes = routes.filter((r) => r.method !== "WS");
  const wsRoutes = routes.filter((r) => r.method === "WS");

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
  console.log("RxJS Features:");
  console.log(`  - Workflow changes trigger debounced compilation (${COMPILATION_DEBOUNCE_MS}ms)`);
  console.log(`  - Auto-persistence with debounce (${PERSIST_DEBOUNCE_MS}ms)`);
  console.log(LINE);
}

printStartupMessage();

export default app;
