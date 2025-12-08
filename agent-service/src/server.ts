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
 * Provides REST API endpoints for agent interaction.
 * Supports user delegation mode where agents act on behalf of authenticated users.
 * Workflow changes are automatically persisted to the backend when in delegate mode.
 */

import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { createOpenAI } from "@ai-sdk/openai";
import { TexeraAgent } from "./agent/texera-agent";
import { getBackendConfig } from "./api/backend-api";
import { extractUserFromToken, validateToken } from "./api/auth-api";
import { persistWorkflow, retrieveWorkflow } from "./api/workflow-api";
import type { WorkflowChangeEvent } from "./workflow/workflow-state";
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

// ============================================================================
// Agent Management
// ============================================================================

// Extended agent store with delegate configuration
interface StoredAgent {
  agent: TexeraAgent;
  modelType: string;
  createdAt: Date;
  delegate?: AgentDelegateConfig;
  /** Accumulated ReActSteps for streaming */
  reActSteps: ReActStep[];
  /** Debounce timer for auto-persist */
  persistTimer?: ReturnType<typeof setTimeout>;
}

// Store for active agents
const agentStore = new Map<string, StoredAgent>();
let agentCounter = 0;

// Debounce interval for workflow persistence (ms)
const PERSIST_DEBOUNCE_MS = 500;

/**
 * Schedule workflow persistence with debouncing.
 * Multiple rapid changes will be batched into a single persist call.
 */
function schedulePersist(agentId: string, stored: StoredAgent): void {
  // Clear any pending persist
  if (stored.persistTimer) {
    clearTimeout(stored.persistTimer);
  }

  // Schedule new persist
  stored.persistTimer = setTimeout(async () => {
    if (!stored.delegate?.workflowId || !stored.delegate.userToken) {
      return;
    }

    try {
      const workflowContent = stored.agent.getWorkflowState().getWorkflowContent();
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
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Create a new agent with optional delegate configuration.
 * When delegate config is provided, workflow changes are automatically persisted.
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

  // Initialize operators from backend
  try {
    await agent.getMetadataStore().initializeFromBackend();
  } catch (error) {
    console.warn(`[Server] Failed to load operators from backend for agent ${agentId}:`, error);
  }

  const stored: StoredAgent = {
    agent,
    modelType,
    createdAt: new Date(),
    delegate: delegateConfig,
    reActSteps: [],
  };

  // If in delegate mode with workflowId, load workflow and setup auto-persist
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

    // Register change listener for auto-persistence
    agent.getWorkflowState().addChangeListener((_event: WorkflowChangeEvent) => {
      schedulePersist(agentId, stored);
    });
  }

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
      messageCount: stored.agent.getMessages().length,
    };
  })

  // Delete agent
  .delete("/:id", ({ params: { id } }) => {
    const stored = agentStore.get(id);
    if (!stored) {
      throw new Error("Agent not found");
    }
    // Clear any pending persist timer
    if (stored.persistTimer) {
      clearTimeout(stored.persistTimer);
    }
    agentStore.delete(id);
    return { deleted: true };
  })

  // Send message to agent
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

      // Store ReActSteps
      stored.reActSteps.push(...result.steps);

      console.log(`[Server] Agent ${id} completed with ${result.steps.length} steps`);

      return {
        response: result.response,
        steps: result.steps,
        usage: result.usage,
        stats: result.stats,
        stopped: result.stopped,
        error: result.error,
        workflow: stored.agent.getWorkflowState().getWorkflowContent(),
      };
    },
    {
      body: t.Object({
        message: t.String(),
      }),
    }
  )

  // Stream message to agent (SSE)
  .post(
    "/:id/stream",
    async function* ({ params: { id }, body }) {
      const stored = getStoredAgent(id);
      const { message } = body;

      if (!message || typeof message !== "string") {
        throw new Error("Message is required");
      }

      // Yield start event
      yield { event: "start", data: { agentId: id, message } };

      try {
        // Process message
        const result = await stored.agent.sendMessage(message);

        // Yield each step
        for (const step of result.steps) {
          stored.reActSteps.push(step);
          yield { event: "step", data: step };
        }

        // Yield complete event
        yield {
          event: "complete",
          data: {
            response: result.response,
            usage: result.usage,
            stats: result.stats,
            workflow: stored.agent.getWorkflowState().getWorkflowContent(),
          },
        };
      } catch (error: any) {
        yield { event: "error", data: { error: error.message } };
      }
    },
    {
      body: t.Object({
        message: t.String(),
      }),
    }
  )

  // Get all ReActSteps
  .get("/:id/react-steps", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    return { steps: stored.reActSteps, state: stored.agent.getState() };
  })

  // Stream ReActSteps (SSE)
  .get("/:id/react-steps/stream", async function* ({ params: { id } }) {
    const stored = getStoredAgent(id);
    let lastIndex = 0;

    // Send initial steps
    if (stored.reActSteps.length > 0) {
      yield { event: "steps", data: stored.reActSteps };
      lastIndex = stored.reActSteps.length;
    }

    // Poll for updates
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 500));

      // Send any new steps
      if (stored.reActSteps.length > lastIndex) {
        const newSteps = stored.reActSteps.slice(lastIndex);
        lastIndex = stored.reActSteps.length;
        yield { event: "steps", data: newSteps };
      }

      // Send state update
      yield { event: "state", data: { state: stored.agent.getState() } };
    }
  })

  // Get workflow
  .get("/:id/workflow", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    return { workflow: stored.agent.getWorkflowState().getWorkflowContent() };
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
    stored.reActSteps = [];
    return { status: "reset" };
  })

  // Clear messages
  .post("/:id/clear", ({ params: { id } }) => {
    const stored = getStoredAgent(id);
    stored.agent.clearHistory();
    stored.reActSteps = [];
    return { status: "cleared" };
  });

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
// Startup Message
// ============================================================================

console.log("=".repeat(60));
console.log("Texera Agent Service (Elysia.js)");
console.log("=".repeat(60));
console.log(`Server running at http://localhost:${PORT}`);
console.log(`API Prefix: ${API_PREFIX}`);
console.log("");
console.log("API Endpoints:");
console.log("  GET  /health                                  - Health check");
console.log(`  GET  ${API_PREFIX}/agents                              - List all agents`);
console.log(`  POST ${API_PREFIX}/agents                              - Create new agent`);
console.log(`  GET  ${API_PREFIX}/agents/:id                          - Get agent info + workflow`);
console.log(`  DELETE ${API_PREFIX}/agents/:id                        - Delete agent`);
console.log(`  POST ${API_PREFIX}/agents/:id/message                  - Send message`);
console.log(`  POST ${API_PREFIX}/agents/:id/stream                   - Send message (SSE)`);
console.log(`  GET  ${API_PREFIX}/agents/:id/react-steps              - Get all ReActSteps`);
console.log(`  GET  ${API_PREFIX}/agents/:id/react-steps/stream       - Stream ReActSteps (SSE)`);
console.log(`  GET  ${API_PREFIX}/agents/:id/workflow                 - Get workflow`);
console.log(`  GET  ${API_PREFIX}/agents/:id/messages                 - Get conversation`);
console.log(`  POST ${API_PREFIX}/agents/:id/stop                     - Stop processing`);
console.log(`  POST ${API_PREFIX}/agents/:id/reset                    - Reset agent`);
console.log(`  POST ${API_PREFIX}/agents/:id/clear                    - Clear messages`);
console.log("");
console.log("Notes:");
console.log("  - Workflow changes are auto-persisted when agent has delegate config");
console.log("  - Pass userToken and workflowId when creating agent to enable delegation");
console.log("");
console.log("Environment:");
console.log(`  LLM_API_KEY: ${LLM_API_KEY === "dummy" ? "dummy (default)" : "set"}`);
console.log(`  MODEL: ${MODEL}`);
console.log(`  MODELS_ENDPOINT: ${getBackendConfig().modelsEndpoint}`);
console.log("=".repeat(60));

export default app;
