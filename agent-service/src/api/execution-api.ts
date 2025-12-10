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
 * Execution API client for Texera Agent Service.
 * Uses synchronous HTTP REST API for workflow execution.
 */

import { getBackendConfig } from "./backend-api";
import type { SyncExecutionResult } from "../types/execution";

// ============================================================================
// Types matching the backend SyncExecutionResource
// ============================================================================

export interface LogicalLink {
  fromOpId: string;
  fromPortId: { id: number; internal: boolean };
  toOpId: string;
  toPortId: { id: number; internal: boolean };
}

export interface LogicalOperator {
  operatorID: string;
  operatorType: string;
  [key: string]: any;
}

export interface LogicalPlan {
  operators: LogicalOperator[];
  links: LogicalLink[];
  opsToViewResult?: string[];
  opsToReuseResult?: string[];
}

export interface WorkflowSettings {
  dataTransferBatchSize?: number;
  outputPortsNeedingStorage?: string[];
}

/** Request body for the sync execution API */
export interface SyncExecutionRequest {
  executionName: string;
  logicalPlan: {
    operators: LogicalOperator[];
    links: LogicalLink[];
    opsToViewResult?: string[];
    opsToReuseResult?: string[];
  };
  workflowSettings?: WorkflowSettings;
  targetOperatorIds: string[];
  timeoutSeconds?: number;
  maxResultRows?: number;
}

// ============================================================================
// Execution Client Config
// ============================================================================

export interface ExecutionClientConfig {
  /** User JWT token for authentication */
  userToken: string;
  /** Workflow ID */
  workflowId: number;
  /** Optional computing unit ID (defaults to 0) */
  computingUnitId?: number;
  /** Execution timeout in seconds (default: 300) */
  timeoutSeconds?: number;
  /** Maximum result rows to return (default: 200) */
  maxResultRows?: number;
}

// ============================================================================
// Execution Client - HTTP Based
// ============================================================================

/**
 * HTTP client for synchronous workflow execution.
 * Uses the backend REST API for blocking execution.
 */
export class ExecutionClient {
  private config: ExecutionClientConfig;

  constructor(config: ExecutionClientConfig) {
    this.config = {
      computingUnitId: 0,
      timeoutSeconds: 300,
      maxResultRows: 200,
      ...config,
    };
  }

  /**
   * Execute a workflow with the given logical plan.
   * This is a blocking call that waits for execution to complete.
   * Returns the backend response directly without transformation.
   */
  async executeWorkflow(logicalPlan: LogicalPlan, executionName?: string): Promise<SyncExecutionResult> {
    const backendConfig = getBackendConfig();
    const executionEndpoint = backendConfig.executionEndpoint || "http://localhost:8085";

    const url = `${executionEndpoint}/api/execution/${this.config.workflowId}/${this.config.computingUnitId}/run`;

    // Get sink operators (operators without outgoing links)
    const operatorsWithOutgoingLinks = new Set(logicalPlan.links.map(link => link.fromOpId));
    const sinkOperatorIds = logicalPlan.operators
      .filter(op => !operatorsWithOutgoingLinks.has(op.operatorID))
      .map(op => op.operatorID);

    const request: SyncExecutionRequest = {
      executionName: executionName || `agent-execution-${Date.now()}`,
      logicalPlan: {
        operators: logicalPlan.operators,
        links: logicalPlan.links,
        opsToViewResult: sinkOperatorIds,
        opsToReuseResult: [],
      },
      targetOperatorIds: sinkOperatorIds,
      timeoutSeconds: this.config.timeoutSeconds,
      maxResultRows: this.config.maxResultRows,
    };

    console.log(`[ExecutionClient] Executing workflow via HTTP: ${url}`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.userToken}`,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Execution request failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      // Return the backend response directly - no transformation needed
      const result: SyncExecutionResult = await response.json();
      return result;
    } catch (error) {
      console.error("[ExecutionClient] Execution failed:", error);
      // Return an error result in the same format as the backend
      return {
        success: false,
        state: "Error",
        operators: {},
        errors: [error instanceof Error ? error.message : "Unknown error"],
      };
    }
  }

  /**
   * Get the current configuration.
   */
  getConfig(): ExecutionClientConfig {
    return { ...this.config };
  }
}
