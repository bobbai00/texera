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

import {
  Component,
  ViewChild,
  ElementRef,
  Input,
  OnInit,
  AfterViewChecked,
  ChangeDetectorRef,
  OnDestroy,
} from "@angular/core";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { distinctUntilChanged, filter, pairwise, startWith } from "rxjs/operators";
import { CopilotState, ReActStep, CopilotMessageStats } from "../../../service/copilot/texera-copilot";
import { AgentInfo, TexeraCopilotManagerService } from "../../../service/copilot/texera-copilot-manager.service";
import {
  AgentAction,
  AgentActionService,
  AgentActionPreviewState,
} from "../../../service/agent-action/agent-action.service";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
import { NotificationService } from "../../../../common/service/notification/notification.service";
import { WorkflowVersionService } from "../../../../dashboard/service/user/workflow-version/workflow-version.service";
import { WorkflowPersistService } from "../../../../common/service/workflow-persist/workflow-persist.service";
import {
  ToolGroup,
  TOOL_GROUP_CONFIGS,
  getToolGroup,
  getToolColor,
  getToolGroupConfig,
} from "../../../service/copilot/tool/tool-groups";

/**
 * Represents a single node in the tool call timeline.
 */
export interface TimelineNode {
  id: string;
  toolName: string;
  toolGroup: ToolGroup;
  color: string;
  stepIndex: number;
  toolCallIndex: number;
  messageId: string;
  timestamp: Date;
}

@UntilDestroy()
@Component({
  selector: "texera-agent-chat",
  templateUrl: "agent-chat.component.html",
  styleUrls: ["agent-chat.component.scss"],
})
export class AgentChatComponent implements OnInit, AfterViewChecked, OnDestroy {
  @Input() agentInfo!: AgentInfo;
  @ViewChild("messageContainer", { static: false }) messageContainer?: ElementRef;
  @ViewChild("messageInput", { static: false }) messageInput?: ElementRef;
  @ViewChild("timelineContainer", { static: false }) timelineContainer?: ElementRef;

  public agentResponses: ReActStep[] = [];
  public currentMessage = "";
  private shouldScrollToBottom = false;
  public planningMode = false;
  public isDetailsModalVisible = false;
  public selectedResponse: ReActStep | null = null;
  public hoveredMessageIndex: number | null = null;
  public isSystemInfoModalVisible = false;
  public systemPrompt: string = "";
  public availableTools: Array<{ name: string; description: string; inputSchema: any; enabled: boolean }> = [];
  public agentState: CopilotState = CopilotState.UNAVAILABLE;
  public isStatsModalVisible = false;
  public messageStats: CopilotMessageStats[] = [];

  // Timeline-related properties
  public timelineNodes: TimelineNode[] = [];
  public hoveredTimelineNodeId: string | null = null;
  public toolGroupConfigs = TOOL_GROUP_CONFIGS;
  public ToolGroup = ToolGroup;

  // Unified agent action preview state
  public previewState: AgentActionPreviewState | null = null;

  // System info modal state (with editing capabilities)
  public isEditingSystemPrompt = false;
  public editingSystemPrompt = "";
  public settingsMaxTokenLimit = 1000;
  public settingsToolTimeoutSeconds = 120; // 2 minutes default
  public settingsExecutionTimeoutMinutes = 10; // 10 minutes default
  public agentInternalState: object | null = null;
  public isLoadingAgentState = false;

  // Tool panel state
  public expandedToolName: string | null = null;

  // Track if we disabled auto-persist so we can re-enable it on destroy
  private disabledAutoPersist = false;

  constructor(
    private agentActionService: AgentActionService,
    private copilotManagerService: TexeraCopilotManagerService,
    private workflowActionService: WorkflowActionService,
    private notificationService: NotificationService,
    private cdr: ChangeDetectorRef,
    private workflowVersionService: WorkflowVersionService,
    private workflowPersistService: WorkflowPersistService
  ) {}

  ngOnInit(): void {
    if (!this.agentInfo) {
      return;
    }

    this.planningMode = this.copilotManagerService.getPlanningMode(this.agentInfo.id);

    // Get the current state from manager service
    this.copilotManagerService
      .getAgentState(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(state => {
        this.agentState = state;
        // Immediately trigger change detection to show the current state
        this.cdr.detectChanges();
      });

    // Then subscribe to agent state changes (BehaviorSubject will immediately emit current value)
    this.copilotManagerService
      .getAgentStateObservable(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(state => {
        this.agentState = state;
        // Force immediate change detection
        this.cdr.detectChanges();
      });

    // Subscribe to ReActSteps
    this.copilotManagerService
      .getReActStepsObservable(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(steps => {
        const previousLength = this.agentResponses.length;
        this.agentResponses = steps;
        this.shouldScrollToBottom = true;

        // Rebuild timeline nodes whenever responses change
        this.buildTimelineNodes();

        // Automatically highlight the latest ReAct step
        if (steps.length > 0) {
          const latestIndex = steps.length - 1;
          const previousLatestIndex = previousLength - 1;

          // Auto-highlight the latest if:
          // 1. No message is currently hovered, OR
          // 2. We were hovering the previous latest (so update to new latest)
          if (
            this.hoveredMessageIndex === null ||
            this.hoveredMessageIndex === previousLatestIndex ||
            this.hoveredMessageIndex >= steps.length
          ) {
            this.setHoveredMessage(latestIndex);
          }
        }

        // Trigger change detection
        this.cdr.detectChanges();
      });

    // Subscribe to unified preview state
    this.agentActionService
      .getPreviewStateStream()
      .pipe(untilDestroyed(this))
      .subscribe(state => {
        // Only show preview UI if the agent action belongs to this agent
        if (state && state.agentAction.agentId === this.agentInfo.id) {
          this.previewState = state;
          this.shouldScrollToBottom = true;
          console.log("[Agent Chat] Preview state updated", state);
        } else {
          this.previewState = null;
        }
        this.cdr.detectChanges();
      });

    // Subscribe to message stats changes
    this.copilotManagerService
      .getMessageStatsObservable(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(statsMap => {
        this.messageStats = Array.from(statsMap.values());
        this.cdr.detectChanges();
      });

    // Subscribe to agent state changes to manage auto-persist
    // Disable auto-persist when agent is GENERATING, re-enable when AVAILABLE
    this.copilotManagerService
      .getAgentStateObservable(this.agentInfo.id)
      .pipe(
        startWith(CopilotState.UNAVAILABLE),
        pairwise(),
        untilDestroyed(this)
      )
      .subscribe(([previousState, currentState]) => {
        // When agent starts generating, disable auto-persist
        if (currentState === CopilotState.GENERATING && previousState !== CopilotState.GENERATING) {
          this.workflowPersistService.setWorkflowPersistFlag(false);
          this.disabledAutoPersist = true;
          console.log("[AgentChat] Disabled auto-persist during agent generation");
        }

        // When agent finishes (becomes AVAILABLE from GENERATING/STOPPING), re-enable auto-persist
        if (
          currentState === CopilotState.AVAILABLE &&
          (previousState === CopilotState.GENERATING || previousState === CopilotState.STOPPING)
        ) {
          this.workflowPersistService.setWorkflowPersistFlag(true);
          this.disabledAutoPersist = false;
          console.log("[AgentChat] Re-enabled auto-persist after agent finished");
        }
      });

    // Subscribe to workflow changes from agent and reload the workspace
    // This polls the workflow from backend database and updates the workspace display
    this.copilotManagerService
      .getWorkflowObservable(this.agentInfo.id)
      .pipe(
        filter(workflow => workflow !== null),
        distinctUntilChanged((prev, curr) => {
          // Compare workflow content to avoid unnecessary reloads
          if (!prev || !curr) return false;
          return JSON.stringify(prev.content) === JSON.stringify(curr.content);
        }),
        untilDestroyed(this)
      )
      .subscribe(workflow => {
        if (workflow) {
          // Reload the workflow in the workspace with preserveViewport=true
          // to keep the user's current view position
          console.log("[AgentChat] Reloading workflow from backend");
          this.workflowActionService.reloadWorkflow(workflow, false, true);
        }
      });
  }

  ngOnDestroy(): void {
    // Re-enable auto-persist if we disabled it
    if (this.disabledAutoPersist) {
      this.workflowPersistService.setWorkflowPersistFlag(true);
      console.log("[AgentChat] Re-enabled auto-persist on component destroy");
    }
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom) {
      this.scrollToBottom();
      this.shouldScrollToBottom = false;
    }
  }

  public setHoveredMessage(index: number | null): void {
    // When unhovered (null), automatically revert to latest step
    if (index === null && this.agentResponses.length > 0) {
      index = this.agentResponses.length - 1;
    }

    this.hoveredMessageIndex = index;
    // Notify the copilot service about the hovered message
    const hoveredStep = index !== null && index >= 0 ? this.agentResponses[index] : null;
    this.copilotManagerService.setHoveredMessage(this.agentInfo.id, hoveredStep);
  }

  public showResponseDetails(response: ReActStep): void {
    this.selectedResponse = response;
    this.isDetailsModalVisible = true;
  }

  public closeDetailsModal(): void {
    this.isDetailsModalVisible = false;
    this.selectedResponse = null;
  }

  public showSystemInfo(): void {
    this.refreshSystemInfo();
    this.isSystemInfoModalVisible = true;
  }

  /**
   * Refresh system info from the agent.
   */
  private refreshSystemInfo(): void {
    this.copilotManagerService
      .getSystemInfo(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(systemInfo => {
        this.systemPrompt = systemInfo.systemPrompt;
        this.availableTools = systemInfo.tools;
        // Settings are managed server-side, use default values
        this.settingsMaxTokenLimit = 1000;
        this.settingsToolTimeoutSeconds = 120;
        this.settingsExecutionTimeoutMinutes = 10;
        this.isEditingSystemPrompt = false;
        this.editingSystemPrompt = "";
        this.expandedToolName = null;
      });

    // Also load agent internal state
    this.loadAgentInternalState();
  }

  /**
   * Load agent internal state from the server.
   */
  public loadAgentInternalState(): void {
    this.isLoadingAgentState = true;
    this.copilotManagerService
      .getAgentInternalState(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(state => {
        this.agentInternalState = state;
        this.isLoadingAgentState = false;
      });
  }

  public closeSystemInfoModal(): void {
    this.isSystemInfoModalVisible = false;
    this.isEditingSystemPrompt = false;
  }

  public showStatsModal(): void {
    this.isStatsModalVisible = true;
  }

  public closeStatsModal(): void {
    this.isStatsModalVisible = false;
  }

  public formatJson(data: any): string {
    return JSON.stringify(data, null, 2);
  }

  public getExecutionTime(stat: CopilotMessageStats): string {
    if (!stat.endTime) {
      return "Running...";
    }
    const duration = stat.endTime.getTime() - stat.startTime.getTime();
    const seconds = Math.floor(duration / 1000);
    const ms = duration % 1000;
    return `${seconds}.${ms.toString().padStart(3, "0")}s`;
  }

  public getStatusColor(status: string): string {
    switch (status) {
      case "completed":
        return "#52c41a";
      case "running":
        return "#1890ff";
      case "error":
        return "#ff4d4f";
      case "stopped":
        return "#faad14";
      default:
        return "#8c8c8c";
    }
  }

  public getToolResult(response: ReActStep, toolCallIndex: number): any {
    if (!response.toolResults || toolCallIndex >= response.toolResults.length) {
      return null;
    }
    const toolResult = response.toolResults[toolCallIndex];
    return toolResult.output || toolResult.result || toolResult;
  }

  public getToolOperatorAccess(
    response: ReActStep,
    toolCallIndex: number
  ): { viewedOperatorIds: string[]; modifiedOperatorIds: string[] } | null {
    if (!response.operatorAccess) {
      return null;
    }
    return response.operatorAccess.get(toolCallIndex) || null;
  }

  public hasOperatorAccess(response: ReActStep): boolean {
    return !!response.operatorAccess && response.operatorAccess.size > 0;
  }

  public getTotalInputTokens(): number {
    for (let i = this.agentResponses.length - 1; i >= 0; i--) {
      const response = this.agentResponses[i];
      if (response.usage?.inputTokens !== undefined) {
        return response.usage.inputTokens;
      }
    }
    return 0;
  }

  public getTotalOutputTokens(): number {
    for (let i = this.agentResponses.length - 1; i >= 0; i--) {
      const response = this.agentResponses[i];
      if (response.usage?.outputTokens !== undefined) {
        return response.usage.outputTokens;
      }
    }
    return 0;
  }

  /**
   * Send a message to the agent via the copilot manager service.
   */
  public sendMessage(): void {
    if (!this.currentMessage.trim() || !this.canSendMessage()) {
      return;
    }

    const userMessage = this.currentMessage.trim();
    this.currentMessage = "";

    // Send to copilot via manager service (fire-and-forget)
    this.copilotManagerService.sendMessage(this.agentInfo.id, userMessage);
  }

  /**
   * Check if messages can be sent (only when agent is available).
   */
  public canSendMessage(): boolean {
    return this.agentState === CopilotState.AVAILABLE;
  }

  /**
   * Get the NG-ZORRO icon type based on current agent state.
   */
  public getStateIcon(): string {
    switch (this.agentState) {
      case CopilotState.AVAILABLE:
        return "check-circle";
      case CopilotState.GENERATING:
      case CopilotState.STOPPING:
        return "sync";
      case CopilotState.UNAVAILABLE:
      default:
        return "close-circle";
    }
  }

  /**
   * Get the icon color based on current agent state.
   */
  public getStateIconColor(): string {
    switch (this.agentState) {
      case CopilotState.AVAILABLE:
        return "#52c41a";
      case CopilotState.GENERATING:
      case CopilotState.STOPPING:
        return "#1890ff";
      case CopilotState.UNAVAILABLE:
      default:
        return "#ff4d4f";
    }
  }

  /**
   * Get the tooltip text for the state icon.
   */
  public getStateTooltip(): string {
    switch (this.agentState) {
      case CopilotState.AVAILABLE:
        return "Agent is ready";
      case CopilotState.GENERATING:
        return "Agent is generating response...";
      case CopilotState.STOPPING:
        return "Agent is stopping...";
      case CopilotState.UNAVAILABLE:
        return "Agent is unavailable";
      default:
        return "Agent status unknown";
    }
  }

  public onEnterPress(event: KeyboardEvent): void {
    if (!event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  private scrollToBottom(): void {
    if (this.messageContainer) {
      const element = this.messageContainer.nativeElement;
      element.scrollTop = element.scrollHeight;
    }
  }

  public stopGeneration(): void {
    this.copilotManagerService.stopGeneration(this.agentInfo.id);
  }

  public clearMessages(): void {
    this.copilotManagerService.clearMessages(this.agentInfo.id);
  }

  /**
   * Export the model messages as a JSON file.
   */
  public exportMessages(): void {
    try {
      const messages = this.copilotManagerService.getMessages(this.agentInfo.id);
      const jsonString = JSON.stringify(messages, null, 2);
      const blob = new Blob([jsonString], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      // Create a temporary link and trigger download
      const link = document.createElement("a");
      link.href = url;
      link.download = `${this.agentInfo.name}-messages-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Clean up the URL object
      URL.revokeObjectURL(url);

      this.notificationService.success("Messages exported successfully");
    } catch (error) {
      console.error("Failed to export messages:", error);
      this.notificationService.error("Failed to export messages");
    }
  }

  public isGenerating(): boolean {
    return this.agentState === CopilotState.GENERATING;
  }

  public isAvailable(): boolean {
    return this.agentState === CopilotState.AVAILABLE;
  }

  public isConnected(): boolean {
    return this.agentState !== CopilotState.UNAVAILABLE;
  }

  public isStopping(): boolean {
    return this.agentState === CopilotState.STOPPING;
  }

  public onPlanningModeChange(value: boolean): void {
    this.copilotManagerService.setPlanningMode(this.agentInfo.id, value);
  }

  /**
   * Accept the agent action (for pending mode) or Apply (for historical mode)
   */
  public onAcceptAgentAction(): void {
    if (!this.previewState) {
      return;
    }

    // End preview and apply the changes
    this.agentActionService.endPreview(true);

    // In pending mode, send approval message to continue the agent
    if (this.previewState.isPending) {
      const feedback = this.currentMessage.trim();
      const message = feedback
        ? `I approve this agent action. Additional feedback: ${feedback}`
        : "I approve this agent action. Please proceed with execution.";
      this.copilotManagerService.sendMessage(this.agentInfo.id, message);
      this.currentMessage = "";
    }
  }

  /**
   * Reject the agent action (for pending mode) or Cancel (for historical mode)
   */
  public onRejectAgentAction(): void {
    if (!this.previewState) {
      return;
    }

    // End preview and reject the changes (restore to before state)
    this.agentActionService.endPreview(false);

    // In pending mode, send rejection message to the agent
    if (this.previewState.isPending) {
      const feedback = this.currentMessage.trim();
      const message = feedback
        ? `I reject this agent action. Reason: ${feedback}`
        : "I reject this agent action. Please revise your approach.";
      this.copilotManagerService.sendMessage(this.agentInfo.id, message);
      this.currentMessage = "";
    }
  }

  // =====================
  // Timeline Methods
  // =====================

  /**
   * Build timeline nodes from agent responses.
   * Each tool call becomes a node in the timeline.
   */
  private buildTimelineNodes(): void {
    const nodes: TimelineNode[] = [];

    this.agentResponses.forEach((step, stepIndex) => {
      if (step.toolCalls && step.toolCalls.length > 0) {
        step.toolCalls.forEach((toolCall, toolCallIndex) => {
          const toolName = toolCall.toolName || "unknown";
          const toolGroup = getToolGroup(toolName);
          const node: TimelineNode = {
            id: `${step.messageId}-${stepIndex}-${toolCallIndex}`,
            toolName,
            toolGroup,
            color: getToolColor(toolName),
            stepIndex,
            toolCallIndex,
            messageId: step.messageId,
            timestamp: step.timestamp,
          };
          nodes.push(node);
        });
      }
    });

    this.timelineNodes = nodes;
  }

  /**
   * Check if a timeline node belongs to the currently hovered message.
   */
  public isNodeHighlighted(node: TimelineNode): boolean {
    if (this.hoveredMessageIndex === null) {
      return false;
    }
    return node.stepIndex === this.hoveredMessageIndex;
  }

  /**
   * Handle mouse enter on timeline node.
   * Scrolls chat to the corresponding message on hover.
   */
  public onTimelineNodeHover(node: TimelineNode): void {
    this.hoveredTimelineNodeId = node.id;
    // Highlight the corresponding message
    this.setHoveredMessage(node.stepIndex);
    // Scroll chat to the message
    this.scrollToMessage(node.stepIndex);
  }

  /**
   * Handle mouse leave on timeline node.
   */
  public onTimelineNodeLeave(): void {
    this.hoveredTimelineNodeId = null;
  }

  /**
   * Get the icon for a timeline node based on its group.
   */
  public getTimelineNodeIcon(node: TimelineNode): string {
    return getToolGroupConfig(node.toolGroup).icon;
  }

  /**
   * Handle click on a timeline node.
   * Shows agent action preview for Modify group nodes.
   */
  public onTimelineNodeClick(node: TimelineNode): void {
    // For Modify group nodes, show the agent action preview
    if (node.toolGroup === ToolGroup.MODIFY) {
      this.showAgentActionPreviewForNode(node);
    }
  }

  /**
   * Scroll chat messages to a specific step index.
   */
  private scrollToMessage(stepIndex: number): void {
    if (!this.messageContainer) {
      return;
    }

    const container = this.messageContainer.nativeElement;
    const messages = container.querySelectorAll(".message");

    if (stepIndex >= 0 && stepIndex < messages.length) {
      messages[stepIndex].scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  /**
   * Show agent action preview for a Modify group timeline node.
   * Finds the agent action associated with the tool call and displays diff preview.
   */
  private showAgentActionPreviewForNode(node: TimelineNode): void {
    const step = this.agentResponses[node.stepIndex];
    if (!step || !step.toolCalls || node.toolCallIndex >= step.toolCalls.length) {
      console.log("[Timeline] No step or tool calls found for node", node);
      return;
    }

    const toolCall = step.toolCalls[node.toolCallIndex];
    const toolResult = step.toolResults?.[node.toolCallIndex];

    console.log("[Timeline] Looking for agent action in tool call:", toolCall.toolName, {
      toolCall,
      toolResult,
      nodeTimestamp: node.timestamp,
    });

    // Try to extract agent action ID from the tool result
    let agentActionId: string | null = null;

    if (toolResult) {
      // Check if result contains agent action ID directly
      if (typeof toolResult === "object" && toolResult.agentActionId) {
        agentActionId = toolResult.agentActionId;
      } else if (typeof toolResult === "object" && toolResult.id) {
        agentActionId = toolResult.id;
      } else if (typeof toolResult === "string") {
        // Try to parse JSON result
        try {
          const parsed = JSON.parse(toolResult);
          agentActionId = parsed.agentActionId || parsed.id;
        } catch {
          // Not JSON, check for ID pattern in string
          const match = toolResult.match(/agent-action-[\w-]+/);
          if (match) {
            agentActionId = match[0];
          }
        }
      }
    }

    // Also check tool call input for agent action ID
    if (!agentActionId && toolCall.input) {
      try {
        const input = typeof toolCall.input === "string" ? JSON.parse(toolCall.input) : toolCall.input;
        agentActionId = input.agentActionId || input.id;
      } catch {
        // Ignore parse errors
      }
    }

    // Fallback: Find agent action by matching timestamp (closest before or at the node timestamp)
    if (!agentActionId) {
      const allActions = this.agentActionService.getAllAgentActions();
      console.log("[Timeline] No agent action ID found, matching by timestamp. Actions:", allActions.length);

      if (allActions.length > 0) {
        const nodeTime = node.timestamp.getTime();

        // Sort actions by creation time (oldest first)
        const sortedActions = [...allActions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        // Find actions created before or at the node timestamp
        const actionsBeforeNode = sortedActions.filter(a => a.createdAt.getTime() <= nodeTime);

        if (actionsBeforeNode.length > 0) {
          // Get the latest action that was created before or at the node timestamp
          agentActionId = actionsBeforeNode[actionsBeforeNode.length - 1].id;
        } else {
          // If no actions before, use the first (oldest) action
          agentActionId = sortedActions[0].id;
        }

        console.log("[Timeline] Found agent action by timestamp:", agentActionId);
      }
    }

    if (agentActionId) {
      console.log("[Timeline] Previewing agent action:", agentActionId);
      this.previewAgentAction(agentActionId);
    } else {
      console.log("[Timeline] No agent action found to preview");
      this.notificationService.warning("No agent action found for this operation");
    }
  }

  /**
   * Preview an agent action by ID (historical mode - from timeline click).
   */
  public previewAgentAction(agentActionId: string): void {
    try {
      this.agentActionService.startHistoricalPreview(agentActionId);
    } catch (err) {
      console.error("Failed to preview agent action:", err);
      this.notificationService.error("Failed to preview agent action");
    }
  }

  // =====================
  // Agent Action Navigation
  // =====================

  /**
   * Get all agent actions for this agent sorted by creation time (chronological order).
   */
  private getAgentActionsForAgent(): AgentAction[] {
    return this.agentActionService
      .getAllAgentActions()
      .filter(action => action.agentId === this.agentInfo.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * Get the index of the current preview agent action in the sorted list.
   */
  private getCurrentAgentActionIndex(): number {
    if (!this.previewState) {
      return -1;
    }
    const actions = this.getAgentActionsForAgent();
    return actions.findIndex(a => a.id === this.previewState!.agentAction.id);
  }

  /**
   * Check if there is a previous agent action to navigate to.
   */
  public hasPreviousAgentAction(): boolean {
    return this.getCurrentAgentActionIndex() > 0;
  }

  /**
   * Check if there is a next agent action to navigate to.
   */
  public hasNextAgentAction(): boolean {
    const actions = this.getAgentActionsForAgent();
    const currentIndex = this.getCurrentAgentActionIndex();
    return currentIndex >= 0 && currentIndex < actions.length - 1;
  }

  /**
   * Navigate to the previous agent action in chronological order.
   */
  public navigateToPreviousAgentAction(): void {
    if (!this.hasPreviousAgentAction()) {
      return;
    }
    const actions = this.getAgentActionsForAgent();
    const currentIndex = this.getCurrentAgentActionIndex();
    const previousAction = actions[currentIndex - 1];

    // End current preview without applying changes, then start new preview
    this.agentActionService.endPreview(false);
    this.agentActionService.startHistoricalPreview(previousAction.id);
  }

  /**
   * Navigate to the next agent action in chronological order.
   */
  public navigateToNextAgentAction(): void {
    if (!this.hasNextAgentAction()) {
      return;
    }
    const actions = this.getAgentActionsForAgent();
    const currentIndex = this.getCurrentAgentActionIndex();
    const nextAction = actions[currentIndex + 1];

    // End current preview without applying changes, then start new preview
    this.agentActionService.endPreview(false);
    this.agentActionService.startHistoricalPreview(nextAction.id);
  }

  /**
   * Get the current agent action position string (e.g., "2 / 5").
   */
  public getAgentActionPositionLabel(): string {
    const actions = this.getAgentActionsForAgent();
    const currentIndex = this.getCurrentAgentActionIndex();
    if (currentIndex < 0 || actions.length === 0) {
      return "";
    }
    return `${currentIndex + 1} / ${actions.length}`;
  }

  // =====================
  // System Info Modal Editing Methods
  // =====================

  /**
   * Start editing the system prompt.
   */
  public startEditingSystemPrompt(): void {
    this.editingSystemPrompt = this.systemPrompt;
    this.isEditingSystemPrompt = true;
  }

  /**
   * Cancel editing the system prompt.
   */
  public cancelEditingSystemPrompt(): void {
    this.isEditingSystemPrompt = false;
    this.editingSystemPrompt = "";
  }

  /**
   * Save the edited system prompt.
   * Note: System prompt is managed server-side in API mode.
   */
  public saveSystemPrompt(): void {
    // In API mode, system prompt is managed server-side
    this.systemPrompt = this.editingSystemPrompt;
    this.isEditingSystemPrompt = false;
    this.notificationService.info("System prompt editing is managed server-side");
  }

  /**
   * Reset system prompt to default.
   * Note: System prompt is managed server-side in API mode.
   */
  public resetSystemPromptToDefault(): void {
    // In API mode, system prompt is managed server-side
    this.refreshSystemInfo();
    this.notificationService.info("System prompt is managed server-side");
  }

  /**
   * Toggle a specific tool's enabled state.
   * Note: Tool settings are managed server-side in API mode.
   */
  public toggleToolEnabled(tool: { name: string; enabled: boolean }): void {
    // In API mode, tool settings are managed server-side
    this.notificationService.info("Tool settings are managed server-side");
  }

  /**
   * Enable all tools.
   * Note: Tool settings are managed server-side in API mode.
   */
  public enableAllTools(): void {
    // In API mode, tool settings are managed server-side
    this.notificationService.info("Tool settings are managed server-side");
  }

  /**
   * Disable all tools.
   * Note: Tool settings are managed server-side in API mode.
   */
  public disableAllTools(): void {
    // In API mode, tool settings are managed server-side
    this.notificationService.info("Tool settings are managed server-side");
  }

  /**
   * Get count of enabled tools.
   */
  public getEnabledToolsCount(): number {
    return this.availableTools.filter(t => t.enabled).length;
  }

  /**
   * Save the max token limit.
   * Note: Settings are managed server-side in API mode.
   */
  public saveMaxTokenLimit(): void {
    // In API mode, settings are managed server-side
    this.notificationService.info("Settings are managed server-side");
  }

  /**
   * Save the tool execution timeout.
   * Note: Settings are managed server-side in API mode.
   */
  public saveToolTimeout(): void {
    // In API mode, settings are managed server-side
    this.notificationService.info("Settings are managed server-side");
  }

  /**
   * Save the workflow execution timeout.
   * Note: Settings are managed server-side in API mode.
   */
  public saveExecutionTimeout(): void {
    // In API mode, settings are managed server-side
    this.notificationService.info("Settings are managed server-side");
  }

  /**
   * Handle tool panel expand/collapse.
   */
  public onToolPanelChange(toolName: string, expanded: boolean): void {
    this.expandedToolName = expanded ? toolName : null;
  }

  /**
   * Format tool input schema for display.
   * Handles Zod schemas by extracting their JSON schema representation.
   */
  public formatToolSchema(schema: any): string {
    try {
      // Check if it's a Zod schema (has _def property)
      if (schema && schema._def) {
        // Extract the shape from Zod object schema
        if (schema._def.typeName === "ZodObject" && schema._def.shape) {
          const shape = typeof schema._def.shape === "function" ? schema._def.shape() : schema._def.shape;
          const properties: Record<string, any> = {};

          for (const [key, value] of Object.entries(shape)) {
            properties[key] = this.extractZodSchemaInfo(value);
          }

          return JSON.stringify({ type: "object", properties }, null, 2);
        }
        // For other Zod types, try to extract basic info
        return JSON.stringify(this.extractZodSchemaInfo(schema), null, 2);
      }

      // If it's already a plain object (JSON schema), stringify directly
      return JSON.stringify(schema, null, 2);
    } catch (e) {
      return "Unable to display schema";
    }
  }

  /**
   * Extract schema information from a Zod schema definition.
   */
  private extractZodSchemaInfo(zodSchema: any): any {
    if (!zodSchema || !zodSchema._def) {
      return { type: "unknown" };
    }

    const def = zodSchema._def;
    const result: any = {};

    // Add description if available
    if (def.description) {
      result.description = def.description;
    }

    switch (def.typeName) {
      case "ZodString":
        result.type = "string";
        break;
      case "ZodNumber":
        result.type = "number";
        break;
      case "ZodBoolean":
        result.type = "boolean";
        break;
      case "ZodArray":
        result.type = "array";
        if (def.type) {
          result.items = this.extractZodSchemaInfo(def.type);
        }
        break;
      case "ZodObject":
        result.type = "object";
        if (def.shape) {
          const shape = typeof def.shape === "function" ? def.shape() : def.shape;
          result.properties = {};
          for (const [key, value] of Object.entries(shape)) {
            result.properties[key] = this.extractZodSchemaInfo(value);
          }
        }
        break;
      case "ZodOptional":
        const innerOptional = this.extractZodSchemaInfo(def.innerType);
        return { ...innerOptional, optional: true };
      case "ZodDefault":
        const innerDefault = this.extractZodSchemaInfo(def.innerType);
        return { ...innerDefault, default: def.defaultValue?.() };
      case "ZodEnum":
        result.type = "enum";
        result.values = def.values;
        break;
      default:
        result.type = def.typeName?.replace("Zod", "").toLowerCase() || "unknown";
    }

    return result;
  }
}
