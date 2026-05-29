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

import { Inject, Injectable } from "@angular/core";
import { ModelMessage, stepCountIs, streamText } from "ai";
import { DashboardAgentToolsService } from "../tools/dashboard-agent-tools.service";
import { DASHBOARD_AGENT_MODEL_FACTORY, DashboardAgentModelFactory } from "../model/dashboard-agent-model";
import {
  DASHBOARD_AGENT_DEFAULT_MODEL_ID,
  DeepChatFile,
  DeepChatRequestBody,
  DeepChatSignals,
} from "../../type/dashboard-agent.type";

/** Caps the agent's tool-use loop so a turn always terminates. */
const MAX_AGENT_STEPS = 8;

const DASHBOARD_AGENT_SYSTEM_PROMPT = `You are the Texera Dashboard Agent, an assistant embedded in the Texera data-analytics platform. You help the signed-in user manage their Texera datasets and workflows.

You have tools to:
- listDatasets: list the datasets the user can access.
- listWorkflows: list the user's workflows.
- createWorkflow: create a new, empty workflow.
- createDataset: create a new dataset.
- searchResources: search the user's workflows, datasets and projects by keyword.

Guidelines:
- Always call the appropriate tool to read or change real data. Never invent datasets, workflows, ids or links.
- Each tool returns a "link" field with the direct dashboard route to the resource. Whenever you mention a resource you created or found, include that link as a Markdown link (e.g. [Open workflow](/dashboard/user/workflow/42)) so the user can click straight through.
- After creating a resource, confirm what you created and give its link.
- If a tool returns an "error" field, briefly tell the user it failed and suggest a next step; do not retry endlessly.
- Be concise and friendly.
- Uploaded files can only be read by models with file/vision support; if you cannot read an attachment, say so.`;

/**
 * Runs the Texera Dashboard Agent's reasoning loop entirely in the browser
 * using the Vercel AI SDK, and bridges it to the deep-chat UI.
 *
 * For each user turn it maps the deep-chat request body to AI SDK messages,
 * streams the model output (executing the frontend tools defined by
 * {@link DashboardAgentToolsService} as the model calls them), and forwards the
 * streamed text to deep-chat via the `signals` callbacks.
 */
@Injectable({
  providedIn: "root",
})
export class DashboardAgentRuntimeService {
  private modelId = DASHBOARD_AGENT_DEFAULT_MODEL_ID;

  constructor(
    @Inject(DASHBOARD_AGENT_MODEL_FACTORY) private modelFactory: DashboardAgentModelFactory,
    private toolsService: DashboardAgentToolsService
  ) {}

  /** The currently selected gateway model id. */
  public getModelId(): string {
    return this.modelId;
  }

  /** Selects the gateway model used for subsequent turns. */
  public setModel(modelId: string): void {
    this.modelId = modelId;
  }

  /**
   * Handles one chat turn. Intended to be wired to deep-chat's
   * `connect.handler`. Streams text deltas back through `signals.onResponse`
   * and finalizes with `signals.onClose`; on failure it emits a single
   * `signals.onResponse({ error })`.
   */
  public async runTurn(body: DeepChatRequestBody, signals: DeepChatSignals): Promise<void> {
    const messages = this.toModelMessages(body);
    try {
      const result = streamText({
        model: this.modelFactory(this.modelId),
        system: DASHBOARD_AGENT_SYSTEM_PROMPT,
        messages,
        tools: this.toolsService.all(),
        stopWhen: stepCountIs(MAX_AGENT_STEPS),
      });

      let streamedText = false;
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          streamedText = true;
          await signals.onResponse({ text: part.text });
        } else if (part.type === "error") {
          await signals.onResponse({ error: this.toErrorMessage(part.error) });
          return;
        }
      }

      if (!streamedText) {
        await signals.onResponse({
          text: "I wasn't able to produce a response. Please try rephrasing your request.",
        });
      }
      signals.onClose?.();
    } catch (e) {
      await signals.onResponse({ error: this.toErrorMessage(e) });
    }
  }

  /**
   * Maps deep-chat's message history to AI SDK `ModelMessage`s. Attachments are
   * only carried on the most recent user message, as text/image/file parts.
   */
  private toModelMessages(body: DeepChatRequestBody): ModelMessage[] {
    const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
    const messages: ModelMessage[] = [];

    rawMessages.forEach((message, index) => {
      const text = message.text ?? "";
      const isAssistant = message.role === "ai" || message.role === "assistant";

      if (isAssistant) {
        if (text) {
          messages.push({ role: "assistant", content: text });
        }
        return;
      }

      const fileParts = index === rawMessages.length - 1 ? this.toFileParts(message.files) : [];
      if (fileParts.length > 0) {
        const content: AgentUserContentPart[] = [];
        if (text) {
          content.push({ type: "text", text });
        }
        content.push(...fileParts);
        messages.push({ role: "user", content });
      } else {
        messages.push({ role: "user", content: text });
      }
    });

    if (messages.length === 0) {
      messages.push({ role: "user", content: "" });
    }
    return messages;
  }

  private toFileParts(files?: DeepChatFile[]): AgentFilePart[] {
    if (!files) {
      return [];
    }
    const parts: AgentFilePart[] = [];
    for (const file of files) {
      const src = file.src;
      // Only files deep-chat provides as a data URL / URL can be forwarded synchronously.
      if (!src) {
        continue;
      }
      if (file.type === "image" || src.startsWith("data:image/")) {
        parts.push({ type: "image", image: src });
      } else {
        parts.push({ type: "file", data: src, mediaType: this.mediaTypeOf(src) });
      }
    }
    return parts;
  }

  private mediaTypeOf(src: string): string {
    const match = /^data:([^;]+)/.exec(src);
    return match?.[1] ?? "application/octet-stream";
  }

  private toErrorMessage(e: unknown): string {
    if (e instanceof Error) {
      return e.message;
    }
    if (typeof e === "string") {
      return e;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
}

type AgentFilePart = { type: "image"; image: string } | { type: "file"; data: string; mediaType: string };

type AgentUserContentPart = { type: "text"; text: string } | AgentFilePart;
