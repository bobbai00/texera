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
 * Texera Agent Service - HTTP Server
 *
 * Provides REST API endpoints for agent interaction.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { TexeraAgent } from "./agent/texera-agent";
import { getBackendConfig } from "./api/backend-api";

// ============================================================================
// Configuration
// ============================================================================

const PORT = parseInt(process.env.PORT || "3001");
const LLM_API_KEY = process.env.LLM_API_KEY || "dummy";
const MODEL = process.env.MODEL || "gpt-4-turbo";

// ============================================================================
// Agent Management
// ============================================================================

// Store for active agents
const agents = new Map<string, TexeraAgent>();

/**
 * Get or create an agent by ID
 */
async function getOrCreateAgent(agentId: string, modelType?: string): Promise<TexeraAgent> {
  let agent = agents.get(agentId);
  if (!agent) {
    const config = getBackendConfig();

    // Use models endpoint as baseURL with /api path (similar to frontend pattern)
    // The OpenAI SDK appends /chat/completions, so we need baseURL to be http://localhost:9096/api
    const openai = createOpenAI({
      baseURL: `${config.modelsEndpoint}/api`,
      apiKey: LLM_API_KEY,
    });

    agent = new TexeraAgent({
      model: openai.chat(modelType || MODEL),
      agentId,
      agentName: `Agent-${agentId}`,
    });

    // Initialize operators from backend
    try {
      await agent.getMetadataStore().initializeFromBackend();
    } catch (error) {
      console.warn(`[Server] Failed to load operators from backend for agent ${agentId}:`, error);
      // Continue without operators - they can be loaded later
    }

    agents.set(agentId, agent);
    console.log(`[Server] Created new agent: ${agentId}`);
  }
  return agent;
}

// ============================================================================
// HTTP Server using Bun
// ============================================================================

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ========================================
      // Health check
      // ========================================
      if (path === "/health" && method === "GET") {
        return Response.json(
          { status: "ok", timestamp: new Date().toISOString() },
          { headers: corsHeaders }
        );
      }

      // ========================================
      // List agents
      // ========================================
      if (path === "/api/agents" && method === "GET") {
        const agentList = Array.from(agents.entries()).map(([id, agent]) => ({
          id,
          name: agent.agentName,
          state: agent.getState(),
          operatorCount: agent.getWorkflowState().getAllOperators().length,
          linkCount: agent.getWorkflowState().getAllLinks().length,
        }));
        return Response.json({ agents: agentList }, { headers: corsHeaders });
      }

      // ========================================
      // Create/Get agent
      // ========================================
      if (path.match(/^\/api\/agents\/[\w-]+$/) && method === "GET") {
        const agentId = path.split("/").pop()!;
        const agent = await getOrCreateAgent(agentId);
        return Response.json(
          {
            id: agentId,
            name: agent.agentName,
            state: agent.getState(),
            workflow: agent.getWorkflowState().getWorkflowContent(),
            messageCount: agent.getMessages().length,
          },
          { headers: corsHeaders }
        );
      }

      // ========================================
      // Send message to agent
      // ========================================
      if (path.match(/^\/api\/agents\/[\w-]+\/message$/) && method === "POST") {
        const agentId = path.split("/")[3];
        const body = await req.json();
        const message = body.message;

        if (!message || typeof message !== "string") {
          return Response.json(
            { error: "Message is required" },
            { status: 400, headers: corsHeaders }
          );
        }

        const agent = await getOrCreateAgent(agentId);
        console.log(`[Server] Agent ${agentId} received message: ${message.substring(0, 50)}...`);

        const result = await agent.sendMessage(message);

        console.log(`[Server] Agent ${agentId} completed with ${result.steps.length} steps`);

        return Response.json(
          {
            response: result.response,
            steps: result.steps,
            usage: result.usage,
            stats: result.stats,
            stopped: result.stopped,
            error: result.error,
            workflow: agent.getWorkflowState().getWorkflowContent(),
          },
          { headers: corsHeaders }
        );
      }

      // ========================================
      // Stream message to agent (SSE)
      // ========================================
      if (path.match(/^\/api\/agents\/[\w-]+\/stream$/) && method === "POST") {
        const agentId = path.split("/")[3];
        const body = await req.json();
        const message = body.message;

        if (!message || typeof message !== "string") {
          return Response.json(
            { error: "Message is required" },
            { status: 400, headers: corsHeaders }
          );
        }

        const agent = await getOrCreateAgent(agentId);

        // Create a readable stream for SSE
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();

            const sendEvent = (event: string, data: any) => {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            };

            try {
              // Send initial event
              sendEvent("start", { agentId, message });

              // Process message with step callbacks
              const result = await agent.sendMessage(message);

              // Send each step
              for (const step of result.steps) {
                sendEvent("step", step);
              }

              // Send final result
              sendEvent("complete", {
                response: result.response,
                usage: result.usage,
                stats: result.stats,
                workflow: agent.getWorkflowState().getWorkflowContent(),
              });

              controller.close();
            } catch (error: any) {
              sendEvent("error", { error: error.message });
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // ========================================
      // Get workflow
      // ========================================
      if (path.match(/^\/api\/agents\/[\w-]+\/workflow$/) && method === "GET") {
        const agentId = path.split("/")[3];
        const agent = agents.get(agentId);
        if (!agent) {
          return Response.json(
            { error: "Agent not found" },
            { status: 404, headers: corsHeaders }
          );
        }
        return Response.json(
          { workflow: agent.getWorkflowState().getWorkflowContent() },
          { headers: corsHeaders }
        );
      }

      // ========================================
      // Get messages
      // ========================================
      if (path.match(/^\/api\/agents\/[\w-]+\/messages$/) && method === "GET") {
        const agentId = path.split("/")[3];
        const agent = agents.get(agentId);
        if (!agent) {
          return Response.json(
            { error: "Agent not found" },
            { status: 404, headers: corsHeaders }
          );
        }
        return Response.json(
          { messages: agent.getMessages() },
          { headers: corsHeaders }
        );
      }

      // ========================================
      // Stop agent
      // ========================================
      if (path.match(/^\/api\/agents\/[\w-]+\/stop$/) && method === "POST") {
        const agentId = path.split("/")[3];
        const agent = agents.get(agentId);
        if (!agent) {
          return Response.json(
            { error: "Agent not found" },
            { status: 404, headers: corsHeaders }
          );
        }
        agent.stop();
        return Response.json({ status: "stopping" }, { headers: corsHeaders });
      }

      // ========================================
      // Reset agent
      // ========================================
      if (path.match(/^\/api\/agents\/[\w-]+\/reset$/) && method === "POST") {
        const agentId = path.split("/")[3];
        const agent = agents.get(agentId);
        if (!agent) {
          return Response.json(
            { error: "Agent not found" },
            { status: 404, headers: corsHeaders }
          );
        }
        agent.reset();
        return Response.json({ status: "reset" }, { headers: corsHeaders });
      }

      // ========================================
      // Delete agent
      // ========================================
      if (path.match(/^\/api\/agents\/[\w-]+$/) && method === "DELETE") {
        const agentId = path.split("/").pop()!;
        const deleted = agents.delete(agentId);
        return Response.json(
          { deleted },
          { status: deleted ? 200 : 404, headers: corsHeaders }
        );
      }

      // ========================================
      // 404 Not Found
      // ========================================
      return Response.json(
        { error: "Not found", path },
        { status: 404, headers: corsHeaders }
      );
    } catch (error: any) {
      console.error("[Server] Error:", error);
      return Response.json(
        { error: error.message || "Internal server error" },
        { status: 500, headers: corsHeaders }
      );
    }
  },
});

console.log("=".repeat(60));
console.log("Texera Agent Service");
console.log("=".repeat(60));
console.log(`Server running at http://localhost:${PORT}`);
console.log("");
console.log("API Endpoints:");
console.log("  GET  /health                      - Health check");
console.log("  GET  /api/agents                  - List all agents");
console.log("  GET  /api/agents/:id              - Get/create agent");
console.log("  POST /api/agents/:id/message      - Send message");
console.log("  POST /api/agents/:id/stream       - Send message (SSE)");
console.log("  GET  /api/agents/:id/workflow     - Get workflow");
console.log("  GET  /api/agents/:id/messages     - Get conversation");
console.log("  POST /api/agents/:id/stop         - Stop processing");
console.log("  POST /api/agents/:id/reset        - Reset agent");
console.log("  DELETE /api/agents/:id            - Delete agent");
console.log("");
console.log("Environment:");
console.log(`  LLM_API_KEY: ${LLM_API_KEY === "dummy" ? "dummy (default)" : "set"}`);
console.log(`  MODEL: ${MODEL}`);
console.log(`  MODELS_ENDPOINT: ${getBackendConfig().modelsEndpoint}`);
console.log("=".repeat(60));

export default server;
