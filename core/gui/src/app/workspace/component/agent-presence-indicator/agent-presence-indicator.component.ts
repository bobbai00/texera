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

import { Component, Input, OnInit } from "@angular/core";
import { AgentService, AgentStatus } from "../../service/agent/agent.service";
import { CoeditorPresenceService } from "../../service/workflow-graph/model/coeditor-presence.service";
import { Coeditor, Role } from "../../../common/type/user";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";

/**
 * Component to display AI agent presence in the workflow
 * Shows as a special coeditor icon with distinct styling
 */
@UntilDestroy()
@Component({
  selector: "texera-agent-presence-indicator",
  templateUrl: "./agent-presence-indicator.component.html",
  styleUrls: ["./agent-presence-indicator.component.scss"]
})
export class AgentPresenceIndicatorComponent implements OnInit {
  @Input() public compact: boolean = false;

  public agentCoeditor: Coeditor | null = null;
  public agentStatus: AgentStatus = AgentStatus.DISCONNECTED;
  public isTyping: boolean = false;
  public currentAction: string = "";

  constructor(
    public agentService: AgentService,
    private coeditorPresenceService: CoeditorPresenceService
  ) {}

  ngOnInit(): void {
    // The agent will appear in the coeditors list when it joins the workflow
    // We can identify it by a special marker (e.g., negative UID or specific name)
    // For now, we'll monitor the agent service status directly

    // Subscribe to agent status updates
    this.agentService.agentPresent$
      .pipe(untilDestroyed(this))
      .subscribe(present => {
        if (present) {
          const session = this.agentService.getCurrentSession();
          if (session) {
            this.agentStatus = session.status;
            // Create a virtual coeditor for the agent
            this.agentCoeditor = {
              uid: -1, // Special ID for AI agent
              name: this.getAgentDisplayName(),
              email: "agent@texera.ai",
              role: Role.REGULAR,
              color: "#7c3aed", // Purple color for AI
              clientId: "agent-" + session.agentUserId,
              comment: ""
            };
          }
        } else {
          this.agentCoeditor = null;
          this.agentStatus = AgentStatus.DISCONNECTED;
        }
      });
  }

  /**
   * Gets the status color for the agent indicator
   */
  public getStatusColor(): string {
    switch (this.agentStatus) {
      case AgentStatus.CONNECTED:
        return "#52c41a"; // Green
      case AgentStatus.ACTIVE:
        return "#1890ff"; // Blue
      case AgentStatus.CONNECTING:
        return "#faad14"; // Yellow
      case AgentStatus.ERROR:
        return "#ff4d4f"; // Red
      default:
        return "#d9d9d9"; // Gray
    }
  }

  /**
   * Gets the status text for tooltip
   */
  public getStatusText(): string {
    switch (this.agentStatus) {
      case AgentStatus.CONNECTED:
        return "AI Assistant is ready";
      case AgentStatus.ACTIVE:
        return this.currentAction || "AI Assistant is working";
      case AgentStatus.CONNECTING:
        return "AI Assistant is connecting";
      case AgentStatus.ERROR:
        return "AI Assistant connection error";
      default:
        return "AI Assistant is offline";
    }
  }

  /**
   * Gets the agent display name with model info
   */
  public getAgentDisplayName(): string {
    const session = this.agentService.getCurrentSession();
    if (session && session.modelConfig) {
      return `AI Assistant (${session.modelConfig.model})`;
    }
    return "AI Assistant";
  }
}
