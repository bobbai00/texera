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
 * Shared types for the Texera Dashboard Agent chat page.
 *
 * The Dashboard Agent is a frontend-only AI agent (built on the Vercel AI SDK)
 * whose tools are defined and executed in the browser. The structures below are
 * the values the tools return to the model and the minimal contract the runtime
 * needs from the chat UI (deep-chat), kept independent from deep-chat's own
 * types so the runtime stays UI-agnostic and easy to unit test.
 */

/** A model the user can pick from in the chat page. The ids must match what the LLM gateway serves. */
export interface DashboardAgentModelOption {
  id: string;
  label: string;
}

/**
 * Default model menu. These ids correspond to the models exposed by Texera's
 * LLM gateway (LiteLLM). They can be changed without touching the agent logic.
 */
export const DASHBOARD_AGENT_MODELS: DashboardAgentModelOption[] = [
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
];

export const DASHBOARD_AGENT_DEFAULT_MODEL_ID = DASHBOARD_AGENT_MODELS[0].id;

/** Summary of a dataset returned by the `listDatasets` tool. */
export interface AgentDatasetSummary {
  did: number | undefined;
  name: string;
  description: string;
  isPublic: boolean;
  /** Direct dashboard route to the dataset, or null when the id is unknown. */
  link: string | null;
}

/** Summary of a workflow returned by the `listWorkflows` tool. */
export interface AgentWorkflowSummary {
  wid: number | undefined;
  name: string;
  description: string | undefined;
  /** Direct dashboard route to the workflow editor, or null when the id is unknown. */
  link: string | null;
}

/** A resource created by the `createWorkflow` / `createDataset` tools. */
export interface AgentCreatedResource {
  id: number | undefined;
  name: string;
  /** Direct dashboard route to the created resource, or null when the id is unknown. */
  link: string | null;
}

/** A single hit returned by the `searchResources` tool. */
export interface AgentSearchHit {
  type: string;
  id: number | undefined;
  name: string;
  link: string | null;
}

/** Returned by any tool when the underlying service call fails, so the model can apologize gracefully. */
export interface AgentToolError {
  error: string;
}

/**
 * Minimal subset of the deep-chat `signals` object that the runtime uses to
 * stream a response back to the chat UI. See deep-chat's Connect/Handler docs.
 */
export interface DeepChatSignals {
  /** In streaming mode, called repeatedly with text deltas; on failure called once with `error`. */
  onResponse: (response: { text?: string; error?: string; overwrite?: boolean }) => void | Promise<void>;
  /** Signals the end of a successful stream. */
  onClose?: () => void;
  /** Optional: signals the connection is ready (clears the loading indicator). */
  onOpen?: () => void;
}

/** A file attached to a deep-chat message. `src` is typically a base64 data URL. */
export interface DeepChatFile {
  src?: string;
  name?: string;
  type?: string;
  ref?: File;
}

/** A single message in the deep-chat request body. */
export interface DeepChatMessage {
  role?: string;
  text?: string;
  files?: DeepChatFile[];
}

/** The body deep-chat passes to a custom `connect.handler`. */
export interface DeepChatRequestBody {
  messages?: DeepChatMessage[];
}
