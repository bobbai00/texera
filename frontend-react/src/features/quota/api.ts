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

// What the user has made and what their executions keep (UserQuotaResource.scala). The backend reports every
// dataset's size as 0 (DatasetStatisticsUtils.scala), so no size of datasets is read here.

import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/** What the executions of one of the user's workflows keep: its results, its statistics and its logs. */
export interface KeptByExecution {
  executionId: number;
  workflowId: number;
  workflowName: string;
  resultBytes: number;
  statisticsBytes: number;
  logBytes: number;
}

export interface Quota {
  workflowsMade: number;
  /** The workflows the user may open, their own and those shared with them. */
  workflowsReachable: number;
  datasetsMade: number;
  /** Largest first. */
  kept: KeptByExecution[];
}

interface KeptAnswer {
  eid: number;
  workflowId: number;
  workflowName: string;
  resultBytes: number;
  runTimeStatsBytes: number;
  logBytes: number;
}

export const quotaKey = ["quota"] as const;

export function quotaQuery() {
  return queryOptions({
    queryKey: quotaKey,
    queryFn: async (): Promise<Quota> => {
      const [workflows, reachable, datasets, kept] = await Promise.all([
        api<unknown[]>("/quota/created_workflows"),
        api<number[]>("/quota/access_workflows"),
        api<unknown[]>("/quota/created_datasets"),
        api<KeptAnswer[]>("/quota/user_quota_size"),
      ]);
      return {
        workflowsMade: workflows.length,
        workflowsReachable: reachable.length,
        datasetsMade: datasets.length,
        kept: kept
          .map(answer => ({
            executionId: answer.eid,
            workflowId: answer.workflowId,
            workflowName: answer.workflowName,
            resultBytes: answer.resultBytes,
            statisticsBytes: answer.runTimeStatsBytes,
            logBytes: answer.logBytes,
          }))
          .toSorted((a, b) => total(b) - total(a)),
      };
    },
  });
}

/** All that one execution keeps. */
export function total({ resultBytes, statisticsBytes, logBytes }: KeptByExecution): number {
  return resultBytes + statisticsBytes + logBytes;
}

/** Deletes what an execution keeps: its results, statistics and logs. The execution stays in the history. */
export function deleteKept(executionId: number): Promise<void> {
  return api(`/quota/deleteCollection/${executionId}`, { method: "DELETE", responseType: "void" });
}
