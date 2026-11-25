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

// The calls the app makes about executions: the user's warehouses, and past executions
// (WorkflowExecutionsResource.scala). Executing a workflow on a unit goes over the unit's socket, in
// lib/execution/client.ts; the units themselves are resources (components/resource/api.ts).

import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/** A warehouse: where an execution keeps its results, on a deployment that gives each user their own. */
export interface Warehouse {
  id: number;
  name: string;
}

/** The user's warehouses. A deployment without warehouses has none, and its executions name none. */
export function warehouseListQuery() {
  return queryOptions({
    queryKey: ["warehouses"],
    queryFn: async (): Promise<Warehouse[]> => {
      const { enabled, warehouses } = await api<{ enabled: boolean; warehouses: { whid: number; name: string }[] }>(
        "/warehouse/status"
      );
      return enabled ? warehouses.map(({ whid, name }) => ({ id: whid, name })) : [];
    },
  });
}

/** How an execution ended, or where it stands, as its history keeps it. */
export type PastExecutionStatus = "Initializing" | "Running" | "Paused" | "Completed" | "Failed" | "Killed" | "Unknown";

/** An execution of a workflow, as its history keeps it. */
export interface PastExecution {
  id: number;
  /** The version of the workflow that was newest when it started. */
  versionId: number;
  unitId: number | null;
  name: string;
  /** Who started it. */
  by: string;
  status: PastExecutionStatus;
  /** In epoch milliseconds. */
  startedAt: number;
  /** When its status last changed: for one that ended, when it ended. */
  updatedAt: number | null;
  bookmarked: boolean;
}

/** The engine's codes for where an execution stands (Utils.maptoStatusCode); any other is unknown. */
const statuses: Record<number, PastExecutionStatus> = {
  0: "Initializing",
  1: "Running",
  2: "Paused",
  3: "Completed",
  4: "Failed",
  5: "Killed",
};

/** An execution as the server lists it (WorkflowExecutionEntry), with the fields the app reads. */
interface PastExecutionAnswer {
  eId: number;
  vId: number;
  cuId: number | null;
  userName: string;
  status: number;
  startingTime: number;
  completionTime: number | null;
  bookmarked: boolean;
  name: string;
}

/** The key of a workflow's executions, under which each one's statistics are kept too. */
export const executionsKey = (workflowId: number) => ["executions", workflowId] as const;

/** A workflow's executions, newest first. Someone who may not see the workflow is told of none. */
export function executionHistoryQuery(workflowId: number) {
  return queryOptions({
    queryKey: executionsKey(workflowId),
    queryFn: async (): Promise<PastExecution[]> =>
      (await api<PastExecutionAnswer[]>(`/executions/${workflowId}`)).map(answer => ({
        id: answer.eId,
        versionId: answer.vId,
        unitId: answer.cuId,
        name: answer.name,
        by: answer.userName,
        status: statuses[answer.status] ?? "Unknown",
        startedAt: answer.startingTime,
        updatedAt: answer.completionTime,
        bookmarked: answer.bookmarked,
      })),
  });
}

export function renameExecution(workflowId: number, executionId: number, name: string): Promise<void> {
  return api("/executions/update_execution_name", {
    method: "POST",
    json: { wid: workflowId, eId: executionId, executionName: name },
    responseType: "void",
  });
}

/** Bookmarks an execution, or takes its bookmark away. */
export function bookmarkExecution(workflowId: number, executionId: number, bookmarked: boolean): Promise<void> {
  return api("/executions/set_execution_bookmarks", {
    method: "PUT",
    // The server reads isBookmarked as what the execution was before, and makes it the other.
    json: { wid: workflowId, eIds: [executionId], isBookmarked: !bookmarked },
    responseType: "void",
  });
}

/** Deletes an execution from the history, with its results and statistics. */
export function deleteExecution(workflowId: number, executionId: number): Promise<void> {
  return api("/executions/delete_executions", {
    method: "PUT",
    json: { wid: workflowId, eIds: [executionId] },
    responseType: "void",
  });
}

/** What one operator did in an execution. */
export interface OperatorStatistics {
  operatorId: string;
  inputRows: number;
  outputRows: number;
  /** The time its workers spent on data, in milliseconds. */
  processingMs: number;
  workers: number;
  /** How many rows it had put out by each moment it was sampled, in epoch milliseconds. */
  samples: { at: number; rows: number }[];
}

/** A sample of an operator's running totals (WorkflowRuntimeStatistics). Times are in nanoseconds. */
interface StatisticsAnswer {
  operatorId: string;
  timestamp: number;
  inputTupleCount: number;
  outputTupleCount: number;
  dataProcessingTime: number;
  numWorkers: number;
}

/**
 * What each operator did in an execution: its totals as last sampled. An execution whose statistics were not
 * kept has none: the server answers it with an error, which reads here as no statistics.
 */
export function executionStatisticsQuery(workflowId: number, executionId: number) {
  return queryOptions({
    queryKey: [...executionsKey(workflowId), executionId, "statistics"],
    queryFn: async (): Promise<OperatorStatistics[]> => {
      const samples = await api<StatisticsAnswer[]>(`/executions/${workflowId}/stats/${executionId}`).catch(
        () => [] as StatisticsAnswer[]
      );
      const byOperator = new Map<string, StatisticsAnswer[]>();
      for (const sample of samples.toSorted((a, b) => a.timestamp - b.timestamp)) {
        byOperator.set(sample.operatorId, [...(byOperator.get(sample.operatorId) ?? []), sample]);
      }
      return [...byOperator].map(([operatorId, taken]) => {
        const last = taken.at(-1)!;
        return {
          operatorId,
          inputRows: last.inputTupleCount,
          outputRows: last.outputTupleCount,
          processingMs: last.dataProcessingTime / 1e6,
          workers: last.numWorkers,
          samples: taken.map(sample => ({ at: sample.timestamp, rows: sample.outputTupleCount })),
        };
      });
    },
    staleTime: Infinity,
  });
}
