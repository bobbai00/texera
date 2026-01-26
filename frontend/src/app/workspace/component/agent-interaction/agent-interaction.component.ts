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

import { ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges } from "@angular/core";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { TexeraCopilotManagerService } from "../../service/copilot/texera-copilot-manager.service";
import { WorkflowActionService } from "../../service/workflow-graph/model/workflow-action.service";
import { NotificationService } from "../../../common/service/notification/notification.service";
import { ReActStep } from "../../service/copilot/copilot-types";
import { WorkflowGraphReadonly } from "../../service/workflow-graph/model/workflow-graph";

/**
 * Event emitted when context highlight should change.
 * Contains the operators to highlight and the relevant steps.
 */
export interface ContextHighlightEvent {
  operatorIds: string[];
  steps: ReActStep[];
}

/**
 * AgentInteractionComponent provides a compact interface for users to send feedback
 * or messages to agents regarding a specific operator. It can be embedded in various
 * panels like inline-code-panel, inline-property-panel, or operator-property-edit-frame.
 */
@UntilDestroy()
@Component({
  selector: "texera-agent-interaction",
  templateUrl: "./agent-interaction.component.html",
  styleUrls: ["./agent-interaction.component.scss"],
})
export class AgentInteractionComponent implements OnInit, OnChanges {
  @Input() operatorId!: string;
  @Input() operatorDisplayName?: string;
  @Input() compact: boolean = true;
  @Input() showContextExpanded: boolean = false; // When true, shows context inline without popover

  /** Emitted when operators should be highlighted (on panel open) or unhighlighted (on panel close) */
  @Output() contextHighlightChange = new EventEmitter<ContextHighlightEvent | null>();

  public availableAgents: Array<{ id: string; name: string; isConnected: boolean }> = [];
  public selectedAgentId: string | null = null;
  public feedbackMessage: string = "";

  // Context preview fields
  public upstreamOperatorIds: string[] = [];
  public relevantSteps: ReActStep[] = [];
  public isLoadingContext: boolean = false;
  public showContextPreview: boolean = false;

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

    // If showContextExpanded is true, load context immediately
    if (this.showContextExpanded) {
      this.computeUpstreamOperators();
      this.loadRelevantContext();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["operatorId"] || changes["selectedAgentId"]) {
      this.computeUpstreamOperators();
      this.loadRelevantContext();
    }
    // When showContextExpanded changes to true, load context
    if (changes["showContextExpanded"]?.currentValue === true) {
      this.computeUpstreamOperators();
      this.loadRelevantContext();
    }
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

        // Load context for newly selected agent
        this.computeUpstreamOperators();
        this.loadRelevantContext();

        this.changeDetectorRef.detectChanges();
      });
  }

  /**
   * Compute upstream operator IDs for the current operator.
   * This includes the operator itself and all operators that feed into it.
   */
  private computeUpstreamOperators(): void {
    if (!this.operatorId) {
      this.upstreamOperatorIds = [];
      return;
    }

    try {
      const graph = this.workflowActionService.getTexeraGraph();
      this.upstreamOperatorIds = this.getUpstreamOperatorIds(graph, this.operatorId);
    } catch {
      this.upstreamOperatorIds = [this.operatorId];
    }
  }

  /**
   * Get upstream operator IDs using BFS traversal.
   * Includes the starting operator and all operators that feed into it.
   */
  private getUpstreamOperatorIds(workflowGraph: WorkflowGraphReadonly, operatorId: string): string[] {
    const visited = new Set<string>();
    const queue = [operatorId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      try {
        const inputLinks = workflowGraph.getInputLinksByOperatorId(current);
        inputLinks.forEach(link => queue.push(link.source.operatorID));
      } catch {
        // Operator might not exist or have no links, just continue
      }
    }

    return Array.from(visited);
  }

  /**
   * Load relevant ReActSteps from the backend.
   */
  private loadRelevantContext(): void {
    if (!this.operatorId || !this.selectedAgentId) {
      this.relevantSteps = [];
      this.emitContextHighlight();
      return;
    }

    // Check if agent is connected before making API call
    if (!this.copilotManagerService.isAgentActivelyConnected(this.selectedAgentId)) {
      this.relevantSteps = [];
      this.emitContextHighlight();
      return;
    }

    this.isLoadingContext = true;
    this.copilotManagerService
      .getStepsByOperatorIds(this.selectedAgentId, this.upstreamOperatorIds)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: response => {
          // Sort steps by stepId in ascending order (oldest first)
          this.relevantSteps = [...response.steps].sort((a, b) => a.stepId - b.stepId);
          this.isLoadingContext = false;
          this.emitContextHighlight();
          this.changeDetectorRef.detectChanges();
        },
        error: () => {
          this.relevantSteps = [];
          this.isLoadingContext = false;
          this.emitContextHighlight();
          this.changeDetectorRef.detectChanges();
        },
      });
  }

  /**
   * Emit context highlight event when in expanded mode.
   */
  private emitContextHighlight(): void {
    if (this.showContextExpanded && this.upstreamOperatorIds.length > 0) {
      this.contextHighlightChange.emit({
        operatorIds: this.upstreamOperatorIds,
        steps: this.relevantSteps,
      });
    }
  }

  /**
   * Clear the context highlight (call when panel closes).
   */
  public clearContextHighlight(): void {
    this.contextHighlightChange.emit(null);
  }

  /**
   * Get the step label for display (messageId.stepId format).
   */
  public getStepLabel(step: ReActStep): string {
    // Show abbreviated messageId (first 8 chars) + stepId
    const shortMessageId = step.messageId.substring(0, 8);
    return `${shortMessageId}#${step.stepId}`;
  }

  /**
   * Called when popover visibility changes.
   * Loads context when opened.
   */
  public onPopoverVisibleChange(visible: boolean): void {
    this.showContextPreview = visible;
    if (visible) {
      this.loadRelevantContext();
    }
  }

  /**
   * Called when agent selection changes.
   */
  public onAgentSelectionChange(): void {
    this.computeUpstreamOperators();
    this.loadRelevantContext();
  }

  /**
   * Check if the selected agent is connected.
   */
  public isSelectedAgentConnected(): boolean {
    if (!this.selectedAgentId) return false;
    return this.copilotManagerService.isAgentActivelyConnected(this.selectedAgentId);
  }

  public sendFeedbackToAgent(): void {
    if (!this.selectedAgentId || !this.feedbackMessage.trim() || !this.operatorId) {
      return;
    }

    // Check if agent is connected before sending
    if (!this.isSelectedAgentConnected()) {
      this.notificationService.error("Agent is not connected. Please open the agent chat panel first.");
      return;
    }

    const operatorName = this.operatorDisplayName || this.getOperatorName() || "this operator";
    const contextMessage = `Regarding operator "${operatorName}" (ID: ${this.operatorId}): ${this.feedbackMessage.trim()}`;

    // Pass the upstream operator IDs for context filtering
    // This ensures only relevant conversation history is included as context
    this.copilotManagerService.sendMessage(this.selectedAgentId, contextMessage, this.upstreamOperatorIds);

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

  /**
   * Get a summary of a ReActStep for display.
   * Shows more content for better readability.
   */
  public getStepSummary(step: ReActStep): string {
    if (step.role === "user") {
      return step.content || "(empty message)";
    }
    // Agent step - show thinking and tool calls with more detail
    const parts: string[] = [];
    if (step.content) {
      // Show up to 500 characters for better context
      const maxLen = 500;
      parts.push(step.content.substring(0, maxLen) + (step.content.length > maxLen ? "..." : ""));
    }
    if (step.toolCalls && step.toolCalls.length > 0) {
      const toolNames = step.toolCalls.map(tc => tc.toolName).join(", ");
      parts.push(`Tools: ${toolNames}`);
    }
    return parts.join("\n\n") || "(no content)";
  }

  /**
   * Get the count of tool calls in a step.
   */
  public getToolCallCount(step: ReActStep): number {
    return step.toolCalls?.length || 0;
  }
}
