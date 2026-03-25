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

import { Injectable } from "@angular/core";
import { BehaviorSubject, Observable } from "rxjs";
import { WorkflowActionService } from "../workflow-graph/model/workflow-action.service";
import { WorkflowVersionService } from "../../../dashboard/service/user/workflow-version/workflow-version.service";
import { UndoRedoService } from "../undo-redo/undo-redo.service";
import { WorkflowPersistService } from "../../../common/service/workflow-persist/workflow-persist.service";
import { Workflow, WorkflowContent } from "../../../common/type/workflow";
import { WorkflowMetadata } from "../../../dashboard/type/workflow-metadata.interface";

/**
 * Preview state for agent actions
 */
export interface AgentActionPreviewState {
  agentAction: AgentAction;
}

/**
 * Diff structure for operators (reusing workflow-version.service structure)
 */
type DifferentOpIDsList = {
  [key in "modified" | "added" | "deleted"]: string[];
};

/**
 * Operations performed in an agent action
 */
export interface AgentActionOperations {
  add: {
    operatorIds: string[];
    linkIds: string[];
  };
  modify: {
    operatorIds: string[];
  };
  delete: {
    operatorIds: string[];
    linkIds: string[];
  };
}

/**
 * Complete Agent Action data structure
 */
export interface AgentAction {
  id: string; // Unique identifier for the agent action
  agentId: string; // ID of the agent that created this action
  agentName: string; // Name of the agent
  executorAgentId: string; // ID of the agent that will execute/handle feedback for this action (can be different from creator)
  summary: string; // Overall summary of the agent action
  operations: AgentActionOperations; // Operations performed (add/modify/delete)
  createdAt: Date; // Creation timestamp
  toolCallId?: string; // The tool call ID that produced this action
  parentId?: string; // Parent action ID in the action tree
  operatorIds: string[]; // For highlighting
  linkIds: string[]; // For highlighting
  workflowMetadata: WorkflowMetadata; // Workflow metadata (wid, name, etc.)
  beforeWorkflowContent: WorkflowContent; // Workflow content before the agent action was applied
  afterWorkflowContent: WorkflowContent; // Workflow content after the agent action was applied
}

/**
 * Service to manage agent action preview rendering.
 * This service is responsible ONLY for showing/hiding previews on the canvas.
 * Agent actions are stored in TexeraCopilotManagerService per agent.
 */
@Injectable({
  providedIn: "root",
})
export class AgentActionService {
  // Preview state
  private previewStateSubject = new BehaviorSubject<AgentActionPreviewState | null>(null);

  // Diff preview state
  private currentDiff: DifferentOpIDsList | null = null;

  // Saved workflow content before starting a preview (for cancel/restore)
  private savedWorkflowContentBeforePreview: WorkflowContent | null = null;

  constructor(
    private workflowVersionService: WorkflowVersionService,
    private undoRedoService: UndoRedoService,
    private workflowPersistService: WorkflowPersistService,
    private workflowActionService: WorkflowActionService
  ) {}

  /**
   * Get the preview state stream.
   * Emits when an agent action is being previewed.
   */
  public getPreviewStateStream(): Observable<AgentActionPreviewState | null> {
    return this.previewStateSubject.asObservable();
  }

  /**
   * Get the current preview state (synchronous access)
   */
  public getPreviewState(): AgentActionPreviewState | null {
    return this.previewStateSubject.getValue();
  }

  /**
   * Check if currently in preview mode
   */
  public isPreviewActive(): boolean {
    return this.previewStateSubject.getValue() !== null;
  }

  /**
   * Start previewing an agent action.
   * Shows the diff between before and after workflow content.
   */
  public startPreview(agentAction: AgentAction): void {
    // Save the current workflow content BEFORE showing the preview
    // This is what we'll restore to if the user cancels
    this.savedWorkflowContentBeforePreview = this.workflowActionService.getWorkflowContent();

    this.showPreviewDiff(agentAction);
    this.previewStateSubject.next({ agentAction });
    console.log(`[AgentActionService] Started preview for agent action: ${agentAction.id}`);
  }

  /**
   * End the current preview.
   * @param accept If true, apply the agent action's afterWorkflowContent; if false, restore to saved content.
   */
  public endPreview(accept: boolean): void {
    const previewState = this.previewStateSubject.getValue();
    if (!previewState) {
      console.warn("[AgentActionService] No active preview to end");
      return;
    }

    // Determine which content to load
    const contentToLoad = accept
      ? previewState.agentAction.afterWorkflowContent
      : this.savedWorkflowContentBeforePreview!;

    this.loadWorkflowContent(previewState.agentAction.workflowMetadata, contentToLoad);

    // Clear state
    this.savedWorkflowContentBeforePreview = null;
    this.previewStateSubject.next(null);
    console.log(`[AgentActionService] Ended preview, accept=${accept}`);
  }

  // ===== PREVIEW INTERNAL METHODS =====

  /**
   * Display agent action diff on canvas.
   * Shows the AFTER content with highlights indicating what changed from BEFORE.
   */
  private showPreviewDiff(agentAction: AgentAction): void {
    // Calculate diff between BEFORE and AFTER
    const diff = this.workflowVersionService.getWorkflowsDifference(
      agentAction.beforeWorkflowContent,
      agentAction.afterWorkflowContent
    );

    // Create AFTER workflow
    const afterWorkflow: Workflow = { ...agentAction.workflowMetadata, content: agentAction.afterWorkflowContent };

    // Save modification state
    this.workflowVersionService.saveModificationState();

    // Disable persist and undo/redo before reloading
    this.workflowPersistService.setWorkflowPersistFlag(false);
    this.undoRedoService.disableWorkFlowModification();

    // Display the AFTER content on canvas as readonly, preserving the current viewport
    this.workflowActionService.reloadWorkflow(afterWorkflow, undefined, true);
    this.workflowActionService.disableWorkflowModification();

    // Render highlights with beforeWorkflowContent for deleted operator brackets
    this.workflowVersionService.highlightOpVersionDiffSimple(diff, agentAction.beforeWorkflowContent);

    // Store the current diff
    this.currentDiff = diff;
  }

  /**
   * Load workflow content and restore normal editing state.
   * Clears highlights, loads the specified content, and re-enables modifications.
   */
  private loadWorkflowContent(metadata: WorkflowMetadata, content: WorkflowContent): void {
    // Clear highlights
    if (this.currentDiff) {
      this.workflowVersionService.unhighlightOpVersionDiff(this.currentDiff);
      this.currentDiff = null;
    }

    // Clear undo/redo stacks
    this.undoRedoService.clearRedoStack();
    this.undoRedoService.clearUndoStack();

    // Enable modifications to allow reloading
    this.workflowActionService.enableWorkflowModification();

    // Disable undo/redo to not capture the reload as an action
    this.undoRedoService.disableWorkFlowModification();

    // Reload the workflow content, preserving the current viewport
    const workflow: Workflow = { ...metadata, content };
    this.workflowActionService.reloadWorkflow(workflow, undefined, true);

    // Re-enable undo/redo
    this.undoRedoService.enableWorkFlowModification();

    // Re-enable persist to DB
    this.workflowPersistService.setWorkflowPersistFlag(true);

    // Restore modification state
    this.workflowVersionService.restoreModificationState();
  }
}
