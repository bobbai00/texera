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
 * Agent Action Manager - manages agent actions (workflow modifications with before/after state).
 * Similar to the frontend AgentActionService but for the agent-service.
 */

import { Subject, Observable } from "rxjs";
import type { AgentAction, AgentActionOperations } from "../types/agent";
import type { WorkflowContent } from "../types/workflow";

// ============================================================================
// Agent Action Manager
// ============================================================================

/**
 * Manages agent actions for tracking workflow modifications.
 * Each action captures the before and after workflow state.
 */
export class AgentActionManager {
  /** All agent actions */
  private agentActions = new Map<string, AgentAction>();

  /** Counter for generating unique IDs */
  private actionCounter = 0;

  /** Subject for streaming agent actions */
  private readonly agentActionSubject = new Subject<AgentAction>();

  /**
   * Get stream of agent actions (for WebSocket streaming).
   */
  getAgentActionStream(): Observable<AgentAction> {
    return this.agentActionSubject.asObservable();
  }

  /**
   * Create a new agent action.
   */
  createAgentAction(
    agentId: string,
    agentName: string,
    summary: string,
    operations: AgentActionOperations,
    workflowMetadata: { wid?: number; name?: string },
    beforeWorkflowContent: WorkflowContent,
    afterWorkflowContent: WorkflowContent,
    executorAgentId?: string
  ): AgentAction {
    const id = this.generateId();

    const agentAction: AgentAction = {
      id,
      agentId,
      agentName,
      executorAgentId: executorAgentId || agentId,
      summary,
      operations,
      createdAt: new Date(),
      workflowMetadata,
      beforeWorkflowContent,
      afterWorkflowContent,
    };

    this.agentActions.set(id, agentAction);

    // Emit the action for streaming
    this.agentActionSubject.next(agentAction);

    console.log(`[AgentActionManager] Created agent action: ${id} - ${summary}`);

    return agentAction;
  }

  /**
   * Get an agent action by ID.
   */
  getAgentAction(id: string): AgentAction | undefined {
    return this.agentActions.get(id);
  }

  /**
   * Get all agent actions.
   */
  getAllAgentActions(): AgentAction[] {
    return Array.from(this.agentActions.values());
  }

  /**
   * Delete an agent action.
   */
  deleteAgentAction(id: string): boolean {
    return this.agentActions.delete(id);
  }

  /**
   * Clear all agent actions.
   */
  clearAllAgentActions(): void {
    this.agentActions.clear();
  }

  /**
   * Generate a unique ID for agent actions.
   */
  private generateId(): string {
    return `agent-action-${++this.actionCounter}-${Date.now()}`;
  }

  /**
   * Cleanup - complete the subject.
   */
  destroy(): void {
    this.agentActionSubject.complete();
    this.agentActions.clear();
  }
}
