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

import { ChangeDetectorRef, Component, Input, OnInit } from "@angular/core";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { TexeraCopilotManagerService } from "../../service/copilot/texera-copilot-manager.service";
import { WorkflowActionService } from "../../service/workflow-graph/model/workflow-action.service";
import { NotificationService } from "../../../common/service/notification/notification.service";

/**
 * AgentInteractionComponent provides a compact interface for users to send feedback
 * or messages to agents regarding a specific operator.
 * It consists of an agent dropdown and a text input area.
 */
@UntilDestroy()
@Component({
  selector: "texera-agent-interaction",
  templateUrl: "./agent-interaction.component.html",
  styleUrls: ["./agent-interaction.component.scss"],
})
export class AgentInteractionComponent implements OnInit {
  @Input() operatorId!: string;
  @Input() operatorDisplayName?: string;

  public availableAgents: Array<{ id: string; name: string; isConnected: boolean }> = [];
  public selectedAgentId: string | null = null;
  public feedbackMessage: string = "";

  constructor(
    private copilotManagerService: TexeraCopilotManagerService,
    private workflowActionService: WorkflowActionService,
    private notificationService: NotificationService,
    private changeDetectorRef: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadAvailableAgents();
    this.copilotManagerService.agentChange$.pipe(untilDestroyed(this)).subscribe(() => {
      this.loadAvailableAgents();
    });
  }

  private loadAvailableAgents(): void {
    this.copilotManagerService
      .getAllAgents()
      .pipe(untilDestroyed(this))
      .subscribe(agents => {
        const connectedAgentIds = new Set(this.copilotManagerService.getActivelyConnectedAgentIds());

        this.availableAgents = agents.map(agent => ({
          id: agent.id,
          name: agent.name,
          isConnected: connectedAgentIds.has(agent.id),
        }));

        // Auto-select: prefer connected agent, then first agent if only one
        const connectedAgent = this.availableAgents.find(a => a.isConnected);
        if (connectedAgent) {
          this.selectedAgentId = connectedAgent.id;
        } else if (this.availableAgents.length === 1) {
          this.selectedAgentId = this.availableAgents[0].id;
        }

        this.changeDetectorRef.detectChanges();
      });
  }

  public onAgentSelectionChange(): void {
    // No additional logic needed after simplification
  }

  public isSelectedAgentConnected(): boolean {
    if (!this.selectedAgentId) return false;
    return this.copilotManagerService.isAgentActivelyConnected(this.selectedAgentId);
  }

  public sendFeedbackToAgent(): void {
    if (!this.selectedAgentId || !this.feedbackMessage.trim() || !this.operatorId) {
      return;
    }

    if (!this.isSelectedAgentConnected()) {
      this.notificationService.error("Agent is not connected. Please open the agent chat panel first.");
      return;
    }

    const operatorName = this.operatorDisplayName || this.getOperatorName() || "this operator";
    const contextMessage = `Regarding operator "${operatorName}" (ID: ${this.operatorId}): ${this.feedbackMessage.trim()}`;

    this.copilotManagerService.sendMessage(this.selectedAgentId, contextMessage);

    this.notificationService.success("Message sent to agent successfully");
    this.feedbackMessage = "";
    this.changeDetectorRef.detectChanges();
  }

  private getOperatorName(): string | undefined {
    try {
      const operator = this.workflowActionService.getTexeraGraph().getOperator(this.operatorId);
      return operator?.customDisplayName || undefined;
    } catch {
      return undefined;
    }
  }

  public canSend(): boolean {
    return !!this.selectedAgentId && !!this.feedbackMessage.trim();
  }
}
