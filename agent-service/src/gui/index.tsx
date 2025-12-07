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
 * Texera Agent Service - Terminal GUI
 *
 * Ink-based terminal GUI for interacting with agents.
 * Commands:
 *   /list - List available agents
 *   /models - List available models
 *   /create <model> - Create a new agent with specified model
 *   /select <id> - Select an agent to chat with
 *   /workflow - Show current workflow
 *   /clear - Clear chat history
 *   /help - Show help
 */

import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { createOpenAI } from "@ai-sdk/openai";
import { TexeraAgent, type AgentMessageResult } from "../agent/texera-agent";
import { fetchModels, getBackendConfig, type ModelType } from "../api/backend-api";
import type { ReActStep } from "../types/agent";

// ============================================================================
// Types
// ============================================================================

interface AgentInfo {
  id: string;
  name: string;
  modelType: string;
  agent: TexeraAgent;
  createdAt: Date;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  steps?: ReActStep[];
}

type AppMode = "welcome" | "chat";

// ============================================================================
// Configuration
// ============================================================================

const LLM_API_KEY = process.env.LLM_API_KEY || "dummy";

// ============================================================================
// Components
// ============================================================================

function Header({ mode, selectedAgent }: { mode: AppMode; selectedAgent: AgentInfo | null }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        ══════════════════════════════════════════════════════════════
      </Text>
      <Text bold color="cyan">
        {"  "}Texera Agent Service - Terminal GUI
      </Text>
      {selectedAgent && (
        <Text color="green">
          {"  "}Agent: {selectedAgent.name} ({selectedAgent.modelType})
        </Text>
      )}
      <Text bold color="cyan">
        ══════════════════════════════════════════════════════════════
      </Text>
    </Box>
  );
}

function WorkflowDisplay({ agent }: { agent: TexeraAgent | null }) {
  if (!agent) {
    return (
      <Box borderStyle="single" borderColor="gray" padding={1} marginBottom={1}>
        <Text color="gray">No agent selected - workflow will appear here</Text>
      </Box>
    );
  }

  const workflow = agent.getWorkflowState();
  const operators = workflow.getAllOperators();
  const links = workflow.getAllLinks();

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="blue" padding={1} marginBottom={1}>
      <Text bold color="blue">
        Workflow ({operators.length} operators, {links.length} links)
      </Text>
      {operators.length === 0 ? (
        <Text color="gray">Empty workflow - ask the agent to add operators</Text>
      ) : (
        <>
          {operators.slice(0, 5).map((op) => (
            <Text key={op.operatorID} color="white">
              {"  "}• {op.operatorType} <Text color="gray">({op.operatorID.substring(0, 8)})</Text>
            </Text>
          ))}
          {operators.length > 5 && <Text color="gray">  ... and {operators.length - 5} more operators</Text>}
          {links.length > 0 && (
            <Box marginTop={1}>
              <Text color="cyan">Links:</Text>
            </Box>
          )}
          {links.slice(0, 3).map((link, idx) => (
            <Text key={idx} color="gray">
              {"  "}→ {link.source.operatorID.substring(0, 8)} → {link.target.operatorID.substring(0, 8)}
            </Text>
          ))}
          {links.length > 3 && <Text color="gray">  ... and {links.length - 3} more links</Text>}
        </>
      )}
    </Box>
  );
}

function StepsDisplay({ steps }: { steps: ReActStep[] }) {
  if (steps.length === 0) return null;

  // Show only last 3 steps
  const recentSteps = steps.slice(-3);

  return (
    <Box flexDirection="column" marginLeft={2}>
      {recentSteps.map((step, index) => (
        <Box key={index}>
          {step.type === "tool-call" && (
            <Text color="yellow">
              {"  "}[Tool] {step.toolName}
            </Text>
          )}
          {step.type === "tool-result" && (
            <Text color={step.isError ? "red" : "green"}>{"  "}[Result] {step.isError ? "Error" : "OK"}</Text>
          )}
          {step.type === "text" && step.content && (
            <Text color="gray">{"  "}{step.content.substring(0, 60)}...</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

function MessageDisplay({ message }: { message: ChatMessage }) {
  const roleColor = message.role === "user" ? "green" : message.role === "assistant" ? "cyan" : "gray";
  const roleLabel = message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : "System";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={roleColor} bold>
        [{roleLabel}]
      </Text>
      <Text wrap="wrap">{message.content}</Text>
      {message.steps && message.steps.length > 0 && <StepsDisplay steps={message.steps} />}
    </Box>
  );
}

function ChatPanel({ messages, isProcessing }: { messages: ChatMessage[]; isProcessing: boolean }) {
  // Show last 6 messages
  const recentMessages = messages.slice(-6);

  return (
    <Box flexDirection="column" height={20}>
      <Text bold>Chat</Text>
      <Box flexDirection="column" flexGrow={1}>
        {recentMessages.length === 0 ? (
          <Text color="gray">
            Type a message or use commands: /list, /models, /create, /select, /workflow, /help
          </Text>
        ) : (
          recentMessages.map((msg) => <MessageDisplay key={msg.id} message={msg} />)
        )}
        {isProcessing && (
          <Box>
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
            <Text color="yellow"> Processing...</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function AgentListPanel({ agents }: { agents: AgentInfo[] }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="magenta" padding={1}>
      <Text bold color="magenta">
        Agents ({agents.length})
      </Text>
      {agents.length === 0 ? (
        <Text color="gray">No agents. Use /create to create one.</Text>
      ) : (
        agents.map((agent) => (
          <Text key={agent.id}>
            {" "}
            {agent.id}: {agent.name} ({agent.modelType})
          </Text>
        ))
      )}
    </Box>
  );
}

function SelectedAgentInfo({ agent }: { agent: AgentInfo | null }) {
  if (!agent) {
    return (
      <Box borderStyle="single" borderColor="gray" padding={1} marginBottom={1}>
        <Text color="gray">No agent selected - Use /create or /select to choose an agent</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="single" borderColor="green" padding={1} marginBottom={1}>
      <Box flexDirection="column">
        <Text bold color="green">Selected Agent</Text>
        <Text>  ID: <Text color="cyan">{agent.id}</Text></Text>
        <Text>  Model: <Text color="yellow">{agent.modelType}</Text></Text>
      </Box>
    </Box>
  );
}

function InputArea({
  value,
  onChange,
  onSubmit,
  disabled,
  selectedAgent,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  selectedAgent: AgentInfo | null;
}) {
  const hasAgent = selectedAgent !== null;
  const borderColor = hasAgent ? "green" : "gray";
  const promptColor = hasAgent ? "green" : "gray";
  const agentLabel = hasAgent ? selectedAgent.id : "None";

  return (
    <Box borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Text color={promptColor}>[{agentLabel}] {">"} </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={disabled ? "Processing..." : hasAgent ? "Type message or /help" : "Use /create or /select first"}
      />
    </Box>
  );
}

function HelpText() {
  return (
    <Box marginTop={1}>
      <Text color="gray">Ctrl+C to exit | /help for commands</Text>
    </Box>
  );
}

// ============================================================================
// Main App
// ============================================================================

function App() {
  const { exit } = useApp();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [models, setModels] = useState<ModelType[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Load models on mount
  useEffect(() => {
    fetchModels()
      .then(setModels)
      .catch((err) => console.warn("Failed to load models:", err));
  }, []);

  // Handle Ctrl+C
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    }
  });

  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `sys-${Date.now()}`,
        role: "system",
        content,
        timestamp: new Date(),
      },
    ]);
  }, []);

  const handleCommand = useCallback(
    async (cmd: string) => {
      const parts = cmd.trim().split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      switch (command) {
        case "/help":
          addSystemMessage(
            "Commands:\n" +
              "  /list - List agents\n" +
              "  /models - List available models\n" +
              "  /create <model> - Create agent\n" +
              "  /select <id> - Select agent\n" +
              "  /workflow - Show workflow\n" +
              "  /clear - Clear chat\n" +
              "  /help - Show this help"
          );
          break;

        case "/list":
          if (agents.length === 0) {
            addSystemMessage("No agents created. Use /create <model> to create one.");
          } else {
            const list = agents.map((a) => `  ${a.id}: ${a.name} (${a.modelType})`).join("\n");
            addSystemMessage(`Agents:\n${list}`);
          }
          break;

        case "/models":
          if (models.length === 0) {
            addSystemMessage(
              "No models available from backend. Using default: gpt-4-turbo\n" +
                "Make sure the models API is running at localhost:9096"
            );
          } else {
            const list = models.map((m) => `  ${m.id}: ${m.name}`).join("\n");
            addSystemMessage(`Available models:\n${list}`);
          }
          break;

        case "/create":
          const modelType = args[0] || "gpt-4-turbo";
          try {
            setIsProcessing(true);
            const config = getBackendConfig();
            // Use models endpoint as baseURL with /api path
            // The OpenAI SDK appends /chat/completions, so we need baseURL to be http://localhost:9096/api
            const openai = createOpenAI({
              baseURL: `${config.modelsEndpoint}/api`,
              apiKey: LLM_API_KEY,
            });
            const agentId = `agent-${agents.length + 1}`;
            const agent = new TexeraAgent({
              model: openai.chat(modelType),
              agentId,
              agentName: `Agent ${agents.length + 1}`,
            });

            // Initialize operators from backend
            try {
              await agent.getMetadataStore().initializeFromBackend();
            } catch {
              addSystemMessage("Warning: Could not load operators from backend. Agent will have limited functionality.");
            }

            const newAgent: AgentInfo = {
              id: agentId,
              name: `Agent ${agents.length + 1}`,
              modelType,
              agent,
              createdAt: new Date(),
            };

            setAgents((prev) => [...prev, newAgent]);
            setSelectedAgent(newAgent);
            addSystemMessage(`Created and selected agent: ${agentId} (${modelType})`);
          } catch (err: any) {
            addSystemMessage(`Error creating agent: ${err.message}`);
          } finally {
            setIsProcessing(false);
          }
          break;

        case "/select":
          if (!args[0]) {
            addSystemMessage("Usage: /select <agent-id>");
            break;
          }
          const targetAgent = agents.find((a) => a.id === args[0]);
          if (targetAgent) {
            setSelectedAgent(targetAgent);
            addSystemMessage(`Selected agent: ${targetAgent.id}`);
          } else {
            addSystemMessage(`Agent not found: ${args[0]}`);
          }
          break;

        case "/workflow":
          if (!selectedAgent) {
            addSystemMessage("No agent selected. Use /select <id> first.");
          } else {
            const wf = selectedAgent.agent.getWorkflowState();
            const ops = wf.getAllOperators();
            const links = wf.getAllLinks();
            if (ops.length === 0) {
              addSystemMessage("Workflow is empty.");
            } else {
              const opList = ops.map((o) => `  ${o.operatorID}: ${o.operatorType}`).join("\n");
              const linkList =
                links.length > 0
                  ? links.map((l) => `  ${l.source.operatorID} -> ${l.target.operatorID}`).join("\n")
                  : "  (none)";
              addSystemMessage(`Operators (${ops.length}):\n${opList}\n\nLinks (${links.length}):\n${linkList}`);
            }
          }
          break;

        case "/clear":
          setMessages([]);
          addSystemMessage("Chat cleared.");
          break;

        default:
          addSystemMessage(`Unknown command: ${command}. Type /help for available commands.`);
      }
    },
    [agents, models, selectedAgent, addSystemMessage]
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      if (!value.trim() || isProcessing) return;

      setInput("");

      // Handle commands
      if (value.startsWith("/")) {
        await handleCommand(value);
        return;
      }

      // Regular message - needs selected agent
      if (!selectedAgent) {
        addSystemMessage("No agent selected. Use /create to create one or /select to select one.");
        return;
      }

      // Add user message
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: value,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Process with agent
      setIsProcessing(true);
      try {
        const result = await selectedAgent.agent.sendMessage(value);

        const assistantMsg: ChatMessage = {
          id: `asst-${Date.now()}`,
          role: "assistant",
          content: result.response || "(no response)",
          steps: result.steps,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, assistantMsg]);

        if (result.error) {
          addSystemMessage(`Error: ${result.error}`);
        }
      } catch (err: any) {
        addSystemMessage(`Error: ${err.message}`);
      } finally {
        setIsProcessing(false);
      }
    },
    [selectedAgent, isProcessing, handleCommand, addSystemMessage]
  );

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header mode="welcome" selectedAgent={null} />
        <Text color="red">Error: {error}</Text>
        <Text color="gray">Press Ctrl+C to exit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Header mode="chat" selectedAgent={selectedAgent} />

      <Box flexDirection="row" marginBottom={1}>
        {/* Left: Selected Agent Info */}
        <Box width="50%" marginRight={1}>
          <SelectedAgentInfo agent={selectedAgent} />
        </Box>

        {/* Right: Agents list */}
        <Box width="50%">
          <AgentListPanel agents={agents} />
        </Box>
      </Box>

      {/* Workflow visualization (shown when agent is selected) */}
      <WorkflowDisplay agent={selectedAgent?.agent || null} />

      {/* Chat dialogue (ReActStep display) */}
      <ChatPanel messages={messages} isProcessing={isProcessing} />

      {/* Input box */}
      <InputArea
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={isProcessing}
        selectedAgent={selectedAgent}
      />

      <HelpText />
    </Box>
  );
}

// ============================================================================
// Entry Point
// ============================================================================

console.clear();
render(<App />);
