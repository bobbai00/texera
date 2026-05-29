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

import { AfterViewInit, Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, NgZone, ViewChild } from "@angular/core";
import { UntilDestroy } from "@ngneat/until-destroy";
import { DashboardAgentRuntimeService } from "../../service/runtime/dashboard-agent-runtime.service";
import { DASHBOARD_AGENT_MODELS, DashboardAgentModelOption } from "../../type/dashboard-agent.type";

/**
 * Standalone chat page hosting the Texera Dashboard Agent.
 *
 * Renders the deep-chat web component (an out-of-the-box, OpenAI-style chat UI
 * with file upload + streaming) and drives it with the Vercel-AI-SDK-powered
 * {@link DashboardAgentRuntimeService}. deep-chat is imported lazily so its
 * bundle (and the AI SDK) only load when the user opens this page. The
 * `CUSTOM_ELEMENTS_SCHEMA` is scoped to this component so the unknown
 * `<deep-chat>` element does not relax template checking app-wide.
 */
@UntilDestroy()
@Component({
  selector: "texera-dashboard-agent-page",
  templateUrl: "./dashboard-agent-page.component.html",
  styleUrls: ["./dashboard-agent-page.component.scss"],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  imports: [],
})
export class DashboardAgentPageComponent implements AfterViewInit {
  @ViewChild("chat") chatRef!: ElementRef<HTMLElement>;

  protected readonly models: DashboardAgentModelOption[] = DASHBOARD_AGENT_MODELS;
  protected selectedModelId: string;

  constructor(
    private runtime: DashboardAgentRuntimeService,
    private zone: NgZone
  ) {
    this.selectedModelId = this.runtime.getModelId();
  }

  async ngAfterViewInit(): Promise<void> {
    // Lazily register the <deep-chat> custom element only when this page opens.
    await import("deep-chat");
    this.configureChat();
  }

  protected onModelChange(modelId: string): void {
    this.selectedModelId = modelId;
    this.runtime.setModel(modelId);
  }

  /**
   * Configures the deep-chat element: a custom streaming handler that runs the
   * agent loop (re-entering Angular's zone so streamed updates are detected),
   * an intro message, an input placeholder, and file-upload support.
   */
  private configureChat(): void {
    const chat = this.chatRef?.nativeElement as DeepChatElement | undefined;
    if (!chat) {
      return;
    }
    chat.connect = {
      stream: true,
      handler: (body: unknown, signals: unknown) =>
        this.zone.run(() => this.runtime.runTurn(body as never, signals as never)),
    };
    chat.introMessage = {
      text: "Hi! I'm the Texera Dashboard Agent. Ask me to list, search, or create your datasets and workflows — I'll hand you direct links to anything I find or create.",
    };
    chat.textInput = { placeholder: { text: "Message the Texera Dashboard Agent…" } };
    // Allow attaching images and arbitrary files to a message.
    chat.images = true;
    chat.mixedFiles = true;
  }
}

/** The deep-chat properties this component assigns. */
interface DeepChatElement extends HTMLElement {
  connect: unknown;
  introMessage: unknown;
  textInput: unknown;
  images: boolean;
  mixedFiles: boolean;
}
