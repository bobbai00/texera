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

// What an administrator reads and changes across the deployment: its people (AdminUserResource.scala), the
// latest execution of every workflow (AdminExecutionResource.scala), every computing unit
// (ComputingUnitManagingResource.scala, /admin), and its settings (ConfigResource.scala).

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { type ComputingUnit, type ComputingUnitAnswer, fromComputingUnitAnswer } from "@/components/resource/api";
import type { Settings } from "@/components/settings/api";
import { api } from "@/lib/api-client";
import { ExecutionClient } from "@/lib/execution/client";
import type { Role } from "@/lib/session";

/** A person with an account, as an administrator sees them. */
export interface Member {
  id: number;
  name: string;
  email: string;
  role: Role;
  comment: string;
  /** Where they work and why they want to use Texera, as they said when they asked for access. */
  affiliation: string;
  joiningReason: string;
  /** In epoch milliseconds. */
  joinedAt: number;
  lastSignIn: number | null;
}

/** A user as the server lists them (UserInfo). Its times are in seconds. */
interface MemberAnswer {
  uid: number;
  name: string;
  email: string | null;
  role: Role;
  comment: string | null;
  affiliation: string | null;
  joiningReason: string | null;
  accountCreation: number;
  lastLogin: number | null;
}

export const membersKey = ["admin", "members"] as const;

export function memberListQuery() {
  return queryOptions({
    queryKey: membersKey,
    queryFn: async (): Promise<Member[]> =>
      (await api<MemberAnswer[]>("/admin/user/list")).map(answer => ({
        id: answer.uid,
        name: answer.name,
        email: answer.email ?? "",
        role: answer.role,
        comment: answer.comment ?? "",
        affiliation: answer.affiliation ?? "",
        joiningReason: answer.joiningReason ?? "",
        joinedAt: answer.accountCreation * 1000,
        lastSignIn: answer.lastLogin === null ? null : answer.lastLogin * 1000,
      })),
  });
}

/** Changes a person's name, email, role or comment. A change of role is emailed to them by the server. */
export function updateMember({ id, name, email, role, comment }: Member): Promise<void> {
  return api("/admin/user/update", {
    method: "PUT",
    json: { uid: id, name, email, role, comment },
    responseType: "void",
  });
}

/** Where the latest execution of a workflow stands, as the administration list names it. */
export type AdminExecutionStatus = "READY" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "KILLED" | "UNKNOWN";

/** The latest execution of one workflow. */
export interface AdminExecution {
  executionId: number;
  name: string;
  workflowId: number;
  workflowName: string;
  /** Whether the administrator may open the workflow. */
  canOpen: boolean;
  by: string;
  status: AdminExecutionStatus;
  /** In epoch milliseconds. */
  startedAt: number;
  endedAt: number | null;
}

interface AdminExecutionAnswer {
  executionId: number;
  executionName: string;
  workflowId: number;
  workflowName: string;
  access: boolean;
  userName: string;
  executionStatus: string;
  startTime: number;
  endTime: number | null;
}

const statuses = new Set<string>(["READY", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "KILLED"]);
const executionPageSize = 20;

/**
 * The latest execution of every workflow, the most recently ended first, of the statuses asked for (all, for
 * none), a page at a time. The server's count of them leaves the statuses out, so pages go on while they are full.
 */
export function adminExecutionsQuery(only: AdminExecutionStatus[]) {
  return infiniteQueryOptions({
    queryKey: ["admin", "executions", only.toSorted()],
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<AdminExecution[]> => {
      // Each status is a parameter of its own: the server reads each one, and not a list in one.
      const filter = only.map(status => `filter=${status}`).join("&");
      const answers = await api<AdminExecutionAnswer[]>(
        `/admin/execution/executionList/${executionPageSize}/${pageParam}/end_time/desc${filter && `?${filter}`}`
      );
      return answers.map(answer => ({
        executionId: answer.executionId,
        name: answer.executionName,
        workflowId: answer.workflowId,
        workflowName: answer.workflowName,
        canOpen: answer.access,
        by: answer.userName,
        status: statuses.has(answer.executionStatus) ? (answer.executionStatus as AdminExecutionStatus) : "UNKNOWN",
        startedAt: answer.startTime,
        endedAt: answer.endTime,
      }));
    },
    getNextPageParam: (last, pages) => (last.length === executionPageSize ? pages.length : undefined),
  });
}

/**
 * Stops the execution of a workflow that is under way. It is stopped where it is executed: on the computing
 * unit its latest execution names, through the unit's socket, as the person who started it would.
 */
export async function stopExecution(workflowId: number): Promise<void> {
  const { cuId } = await api<{ cuId: number | null }>(`/executions/${workflowId}/latest`);
  if (cuId === null) throw new Error("The execution names no computing unit to stop it on.");
  const client = new ExecutionClient(workflowId, cuId);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The computing unit did not answer.")), 10_000);
    const stop = client.subscribe(() => {
      if (!client.snapshot().connected) return;
      client.kill();
      clearTimeout(timer);
      stop();
      resolve();
    });
    client.connect();
  }).finally(() => setTimeout(() => client.close(), 1_000));
}

/** Every computing unit of the deployment, whoever owns it. */
export function adminComputingUnitsQuery() {
  return queryOptions({
    queryKey: ["admin", "computingUnits"],
    queryFn: async (): Promise<ComputingUnit[]> =>
      (await api<ComputingUnitAnswer[]>("/computing-unit/admin/list")).map(fromComputingUnitAnswer),
    refetchInterval: 5_000,
  });
}

export const allSettingsKey = ["admin", "settings"] as const;

/** Every setting of the deployment, public or not. */
export function allSettingsQuery() {
  return queryOptions({ queryKey: allSettingsKey, queryFn: () => api<Settings>("/config/settings") });
}

export function changeSetting(key: string, value: string): Promise<void> {
  return api(`/config/settings/${encodeURIComponent(key)}`, { method: "PUT", json: { value }, responseType: "void" });
}

/** Puts a setting back to what a new install has. */
export function resetSetting(key: string): Promise<void> {
  return api(`/config/settings/reset/${encodeURIComponent(key)}`, { method: "POST", responseType: "void" });
}
