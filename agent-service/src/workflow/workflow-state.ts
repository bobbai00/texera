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
 * Workflow State Manager - maintains the workflow graph state for the agent.
 * Uses RxJS for reactive state management, following the same patterns as the frontend.
 */

import { Subject, Observable, merge, Subscription } from "rxjs";
import type {
  OperatorPredicate,
  OperatorLink,
  WorkflowContent,
  LogicalPlan,
  LogicalOperator,
  LogicalLink,
  OperatorPortSchemaMap,
} from "../types/workflow";

// ============================================================================
// Local State Types (for internal workflow tracking)
// ============================================================================

/**
 * Workflow compilation states
 */
export enum CompilationState {
  Uninitialized = "Uninitialized",
  Succeeded = "Succeeded",
  Failed = "Failed",
}

/**
 * Compilation state info
 */
export interface CompilationStateInfo {
  state: CompilationState;
  operatorOutputSchemas?: Record<string, OperatorPortSchemaMap>;
  operatorErrors?: Record<string, { type: string; message: string }>;
}

// ============================================================================
// ID Generation
// ============================================================================

let operatorIdCounter = 0;
let linkIdCounter = 0;

export function generateOperatorId(): string {
  return `operator-${++operatorIdCounter}-${Date.now()}`;
}

export function generateLinkId(): string {
  return `link-${++linkIdCounter}-${Date.now()}`;
}

// ============================================================================
// Workflow State Class
// ============================================================================

/**
 * WorkflowState maintains the complete state of a workflow including:
 * - Operators and links (the graph structure)
 * - Compilation state and schemas
 *
 * Uses RxJS Subjects for reactive event streams, following the frontend pattern.
 */
export class WorkflowState {
  // Graph state
  private operators: Map<string, OperatorPredicate> = new Map();
  private links: Map<string, OperatorLink> = new Map();
  private operatorsToViewResult: Set<string> = new Set();

  // ============================================================================
  // RxJS Subjects for workflow change events (similar to frontend WorkflowGraph)
  // ============================================================================

  /** Emits when an operator is added */
  private readonly operatorAddSubject = new Subject<OperatorPredicate>();

  /** Emits when an operator is deleted */
  private readonly operatorDeleteSubject = new Subject<{ deletedOperatorID: string }>();

  /** Emits when an operator's properties are changed */
  private readonly operatorPropertyChangeSubject = new Subject<{ operator: OperatorPredicate }>();

  /** Emits when a link is added */
  private readonly linkAddSubject = new Subject<OperatorLink>();

  /** Emits when a link is deleted */
  private readonly linkDeleteSubject = new Subject<{ deletedLink: OperatorLink }>();

  /** Emits when disabled operators change */
  private readonly disabledOperatorChangedSubject = new Subject<{
    newDisabled: string[];
    newEnabled: string[];
  }>();

  /** Emits when view result operators change */
  private readonly viewResultOperatorChangedSubject = new Subject<{
    newViewResultOps: string[];
    newUnviewResultOps: string[];
  }>();

  // ============================================================================
  // Compilation state subjects
  // ============================================================================

  /** Current compilation state */
  private currentCompilationStateInfo: CompilationStateInfo = {
    state: CompilationState.Uninitialized,
  };

  /** Emits when compilation state changes */
  private readonly compilationStateChangedSubject = new Subject<CompilationStateInfo>();

  // Compilation schemas
  private operatorInputSchemas: Map<string, OperatorPortSchemaMap> = new Map();
  private operatorOutputSchemas: Map<string, OperatorPortSchemaMap> = new Map();

  // Track subscriptions for cleanup
  private subscriptions: Subscription[] = [];

  /**
   * Gets a merged stream of all workflow topology/property changes.
   * This is useful for triggering compilation or persistence.
   * Similar to the frontend's merge pattern in WorkflowCompilingService.
   */
  getWorkflowChangedStream(): Observable<unknown> {
    return merge(
      this.operatorAddSubject,
      this.operatorDeleteSubject,
      this.operatorPropertyChangeSubject,
      this.linkAddSubject,
      this.linkDeleteSubject,
      this.disabledOperatorChangedSubject
    );
  }

  // ============================================================================
  // Operator Operations
  // ============================================================================

  addOperator(operator: OperatorPredicate): void {
    this.operators.set(operator.operatorID, operator);
    this.operatorAddSubject.next(operator);
  }

  getOperator(operatorId: string): OperatorPredicate | undefined {
    return this.operators.get(operatorId);
  }

  getAllOperators(): OperatorPredicate[] {
    return Array.from(this.operators.values());
  }

  getAllEnabledOperators(): OperatorPredicate[] {
    return this.getAllOperators();
  }

  deleteOperator(operatorId: string): boolean {
    const operator = this.operators.get(operatorId);
    if (!operator) return false;

    // Also delete any links connected to this operator
    const linksToDelete = this.getLinksConnectedToOperator(operatorId);
    for (const link of linksToDelete) {
      this.links.delete(link.linkID);
      this.linkDeleteSubject.next({ deletedLink: link });
    }

    this.operatorsToViewResult.delete(operatorId);
    const deleted = this.operators.delete(operatorId);

    if (deleted) {
      this.operatorDeleteSubject.next({ deletedOperatorID: operatorId });
    }

    return deleted;
  }

  updateOperatorProperties(operatorId: string, properties: Record<string, any>): boolean {
    const operator = this.operators.get(operatorId);
    if (!operator) return false;

    const updatedOperator: OperatorPredicate = {
      ...operator,
      operatorProperties: { ...operator.operatorProperties, ...properties },
    };
    this.operators.set(operatorId, updatedOperator);
    this.operatorPropertyChangeSubject.next({ operator: updatedOperator });
    return true;
  }

  // ============================================================================
  // Link Operations
  // ============================================================================

  addLink(link: OperatorLink): void {
    this.links.set(link.linkID, link);
    this.linkAddSubject.next(link);
  }

  getLink(linkId: string): OperatorLink | undefined {
    return this.links.get(linkId);
  }

  getAllLinks(): OperatorLink[] {
    return Array.from(this.links.values());
  }

  deleteLink(linkId: string): boolean {
    const link = this.links.get(linkId);
    if (!link) return false;

    const deleted = this.links.delete(linkId);
    if (deleted) {
      this.linkDeleteSubject.next({ deletedLink: link });
    }
    return deleted;
  }

  getLinksConnectedToOperator(operatorId: string): OperatorLink[] {
    return this.getAllLinks().filter(
      (link) => link.source.operatorID === operatorId || link.target.operatorID === operatorId
    );
  }

  // ============================================================================
  // Compilation State
  // ============================================================================

  getCompilationState(): CompilationStateInfo {
    return this.currentCompilationStateInfo;
  }

  setCompilationState(state: CompilationStateInfo): void {
    this.currentCompilationStateInfo = state;
    this.compilationStateChangedSubject.next(state);
  }

  getOperatorInputSchema(operatorId: string): OperatorPortSchemaMap | undefined {
    return this.operatorInputSchemas.get(operatorId);
  }

  getOperatorOutputSchema(operatorId: string): OperatorPortSchemaMap | undefined {
    return this.operatorOutputSchemas.get(operatorId);
  }

  // ============================================================================
  // Workflow Content (Serialization)
  // ============================================================================

  getWorkflowContent(): WorkflowContent {
    return {
      operators: this.getAllOperators(),
      links: this.getAllLinks(),
    };
  }

  setWorkflowContent(content: WorkflowContent): void {
    // Clear existing state without emitting events
    this.operators.clear();
    this.links.clear();

    // Add new content (no events emitted for bulk load)
    for (const op of content.operators) {
      this.operators.set(op.operatorID, op);
    }
    for (const link of content.links) {
      this.links.set(link.linkID, link);
    }
  }

  /**
   * Convert to backend LogicalPlan format
   */
  toLogicalPlan(targetOperatorId?: string): LogicalPlan {
    const enabledOperators = this.getAllEnabledOperators();

    // If targetOperatorId specified, get subgraph up to that operator
    // For now, simplified: just use all enabled operators
    const operators: LogicalOperator[] = enabledOperators.map((op) => ({
      operatorID: op.operatorID,
      operatorType: op.operatorType,
      ...op.operatorProperties,
      inputPorts: op.inputPorts,
      outputPorts: op.outputPorts,
    }));

    const operatorIds = new Set(operators.map((op) => op.operatorID));

    const links: LogicalLink[] = this.getAllLinks()
      .filter((link) => operatorIds.has(link.source.operatorID) && operatorIds.has(link.target.operatorID))
      .map((link) => {
        const sourceOp = this.getOperator(link.source.operatorID)!;
        const targetOp = this.getOperator(link.target.operatorID)!;

        const fromPortIdx = sourceOp.outputPorts.findIndex((p) => p.portID === link.source.portID);
        const toPortIdx = targetOp.inputPorts.findIndex((p) => p.portID === link.target.portID);

        return {
          fromOpId: link.source.operatorID,
          fromPortId: { id: fromPortIdx >= 0 ? fromPortIdx : 0, internal: false },
          toOpId: link.target.operatorID,
          toPortId: { id: toPortIdx >= 0 ? toPortIdx : 0, internal: false },
        };
      });

    return {
      operators,
      links,
      opsToViewResult: Array.from(this.operatorsToViewResult).filter((id) => operatorIds.has(id)),
      opsToReuseResult: [],
    };
  }

  // ============================================================================
  // Subscription Management
  // ============================================================================

  /**
   * Add a subscription to be tracked for cleanup.
   */
  addSubscription(subscription: Subscription): void {
    this.subscriptions.push(subscription);
  }

  // ============================================================================
  // Reset and Cleanup
  // ============================================================================

  reset(): void {
    this.operators.clear();
    this.links.clear();
    this.operatorsToViewResult.clear();
    this.currentCompilationStateInfo = { state: CompilationState.Uninitialized };
    this.operatorInputSchemas.clear();
    this.operatorOutputSchemas.clear();
  }

  /**
   * Cleanup all subscriptions and complete all subjects.
   * Call this when the WorkflowState is no longer needed.
   */
  destroy(): void {
    // Unsubscribe all tracked subscriptions
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    // Complete all subjects
    this.operatorAddSubject.complete();
    this.operatorDeleteSubject.complete();
    this.operatorPropertyChangeSubject.complete();
    this.linkAddSubject.complete();
    this.linkDeleteSubject.complete();
    this.disabledOperatorChangedSubject.complete();
    this.viewResultOperatorChangedSubject.complete();
    this.compilationStateChangedSubject.complete();

    // Clear all state
    this.reset();
  }
}
