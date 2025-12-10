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
 * This is a simplified version of the frontend WorkflowActionService.
 */

import type {
  OperatorPredicate,
  OperatorLink,
  WorkflowContent,
  LogicalPlan,
  LogicalOperator,
  LogicalLink,
  OperatorPortSchemaMap,
} from "../types/workflow";
import {
  ExecutionState,
  CompilationState,
  type ExecutionStateInfo,
  type CompilationStateInfo,
  type OperatorStatistics,
  type OperatorResultInfo,
  type ConsoleMessage,
} from "../types/execution";

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
// Change Listener Types
// ============================================================================

export type WorkflowChangeType = "add" | "modify" | "delete";

export interface WorkflowChangeEvent {
  type: WorkflowChangeType;
  operatorIds?: string[];
  linkIds?: string[];
}

export type WorkflowChangeListener = (event: WorkflowChangeEvent) => void;

// ============================================================================
// Workflow State Class
// ============================================================================

/**
 * WorkflowState maintains the complete state of a workflow including:
 * - Operators and links (the graph structure)
 * - Execution state
 * - Compilation state and schemas
 * - Results and console logs
 */
export class WorkflowState {
  // Graph state
  private operators: Map<string, OperatorPredicate> = new Map();
  private links: Map<string, OperatorLink> = new Map();
  private operatorsToViewResult: Set<string> = new Set();
  private disabledOperators: Set<string> = new Set();

  // Change listeners for auto-persistence
  private changeListeners: Set<WorkflowChangeListener> = new Set();

  // Execution state
  private executionState: ExecutionStateInfo = { state: ExecutionState.Uninitialized };
  private operatorStatistics: Map<string, OperatorStatistics> = new Map();
  private operatorResults: Map<string, OperatorResultInfo> = new Map();
  private consoleLogs: Map<string, ConsoleMessage[]> = new Map();

  // Compilation state
  private compilationState: CompilationStateInfo = { state: CompilationState.Uninitialized };
  private operatorInputSchemas: Map<string, OperatorPortSchemaMap> = new Map();
  private operatorOutputSchemas: Map<string, OperatorPortSchemaMap> = new Map();

  // ============================================================================
  // Change Listener Management
  // ============================================================================

  /**
   * Register a listener to be called when the workflow changes
   */
  addChangeListener(listener: WorkflowChangeListener): void {
    this.changeListeners.add(listener);
  }

  /**
   * Remove a registered listener
   */
  removeChangeListener(listener: WorkflowChangeListener): void {
    this.changeListeners.delete(listener);
  }

  /**
   * Emit a change event to all listeners
   */
  private emitChange(event: WorkflowChangeEvent): void {
    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[WorkflowState] Error in change listener:", error);
      }
    }
  }

  // ============================================================================
  // Operator Operations
  // ============================================================================

  addOperator(operator: OperatorPredicate): void {
    this.operators.set(operator.operatorID, operator);
    this.emitChange({ type: "add", operatorIds: [operator.operatorID] });
  }

  getOperator(operatorId: string): OperatorPredicate | undefined {
    return this.operators.get(operatorId);
  }

  getAllOperators(): OperatorPredicate[] {
    return Array.from(this.operators.values());
  }

  getAllEnabledOperators(): OperatorPredicate[] {
    return this.getAllOperators().filter((op) => !this.disabledOperators.has(op.operatorID));
  }

  deleteOperator(operatorId: string): boolean {
    // Also delete any links connected to this operator
    const linksToDelete = this.getLinksConnectedToOperator(operatorId);
    const deletedLinkIds: string[] = [];
    for (const link of linksToDelete) {
      this.links.delete(link.linkID);
      deletedLinkIds.push(link.linkID);
    }
    this.operatorsToViewResult.delete(operatorId);
    this.disabledOperators.delete(operatorId);
    const deleted = this.operators.delete(operatorId);
    if (deleted) {
      this.emitChange({ type: "delete", operatorIds: [operatorId], linkIds: deletedLinkIds });
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
    this.emitChange({ type: "modify", operatorIds: [operatorId] });
    return true;
  }

  setOperatorDisabled(operatorId: string, disabled: boolean): void {
    if (disabled) {
      this.disabledOperators.add(operatorId);
    } else {
      this.disabledOperators.delete(operatorId);
    }
  }

  // ============================================================================
  // Link Operations
  // ============================================================================

  addLink(link: OperatorLink): void {
    this.links.set(link.linkID, link);
    this.emitChange({ type: "add", linkIds: [link.linkID] });
  }

  getLink(linkId: string): OperatorLink | undefined {
    return this.links.get(linkId);
  }

  getAllLinks(): OperatorLink[] {
    return Array.from(this.links.values());
  }

  deleteLink(linkId: string): boolean {
    const deleted = this.links.delete(linkId);
    if (deleted) {
      this.emitChange({ type: "delete", linkIds: [linkId] });
    }
    return deleted;
  }

  getLinksConnectedToOperator(operatorId: string): OperatorLink[] {
    return this.getAllLinks().filter(
      (link) => link.source.operatorID === operatorId || link.target.operatorID === operatorId
    );
  }

  getInputLinks(operatorId: string): OperatorLink[] {
    return this.getAllLinks().filter((link) => link.target.operatorID === operatorId);
  }

  getOutputLinks(operatorId: string): OperatorLink[] {
    return this.getAllLinks().filter((link) => link.source.operatorID === operatorId);
  }

  // ============================================================================
  // View Results
  // ============================================================================

  setViewResult(operatorId: string, viewResult: boolean): void {
    if (viewResult) {
      this.operatorsToViewResult.add(operatorId);
    } else {
      this.operatorsToViewResult.delete(operatorId);
    }
  }

  getOperatorsToViewResult(): string[] {
    return Array.from(this.operatorsToViewResult);
  }

  // ============================================================================
  // Execution State
  // ============================================================================

  getExecutionState(): ExecutionStateInfo {
    return this.executionState;
  }

  setExecutionState(state: ExecutionStateInfo): void {
    this.executionState = state;
  }

  getOperatorStatistics(operatorId: string): OperatorStatistics | undefined {
    return this.operatorStatistics.get(operatorId);
  }

  setOperatorStatistics(operatorId: string, stats: OperatorStatistics): void {
    this.operatorStatistics.set(operatorId, stats);
  }

  getAllOperatorStatistics(): Map<string, OperatorStatistics> {
    return new Map(this.operatorStatistics);
  }

  // ============================================================================
  // Results
  // ============================================================================

  getOperatorResult(operatorId: string): OperatorResultInfo | undefined {
    return this.operatorResults.get(operatorId);
  }

  setOperatorResult(operatorId: string, result: OperatorResultInfo): void {
    this.operatorResults.set(operatorId, result);
  }

  hasOperatorResult(operatorId: string): boolean {
    return this.operatorResults.has(operatorId);
  }

  clearResults(): void {
    this.operatorResults.clear();
    this.consoleLogs.clear();
    this.operatorStatistics.clear();
  }

  // ============================================================================
  // Console Logs
  // ============================================================================

  getConsoleLogs(operatorId: string): ConsoleMessage[] {
    return this.consoleLogs.get(operatorId) || [];
  }

  addConsoleLog(operatorId: string, message: ConsoleMessage): void {
    const logs = this.consoleLogs.get(operatorId) || [];
    logs.push(message);
    this.consoleLogs.set(operatorId, logs);
  }

  getAllConsoleLogs(): Map<string, ConsoleMessage[]> {
    return new Map(this.consoleLogs);
  }

  // ============================================================================
  // Compilation State
  // ============================================================================

  getCompilationState(): CompilationStateInfo {
    return this.compilationState;
  }

  setCompilationState(state: CompilationStateInfo): void {
    this.compilationState = state;
  }

  getOperatorInputSchema(operatorId: string): OperatorPortSchemaMap | undefined {
    return this.operatorInputSchemas.get(operatorId);
  }

  setOperatorInputSchema(operatorId: string, schema: OperatorPortSchemaMap): void {
    this.operatorInputSchemas.set(operatorId, schema);
  }

  getOperatorOutputSchema(operatorId: string): OperatorPortSchemaMap | undefined {
    return this.operatorOutputSchemas.get(operatorId);
  }

  setOperatorOutputSchema(operatorId: string, schema: OperatorPortSchemaMap): void {
    this.operatorOutputSchemas.set(operatorId, schema);
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
    this.operators.clear();
    this.links.clear();
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
  // Reset
  // ============================================================================

  reset(): void {
    this.operators.clear();
    this.links.clear();
    this.operatorsToViewResult.clear();
    this.disabledOperators.clear();
    this.executionState = { state: ExecutionState.Uninitialized };
    this.compilationState = { state: CompilationState.Uninitialized };
    this.clearResults();
    this.operatorInputSchemas.clear();
    this.operatorOutputSchemas.clear();
  }
}
