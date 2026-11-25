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
import type { ExecutionState } from "@/lib/execution/protocol";
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

/**
 * Where the latest execution of a workflow stands, as the administration list names it: CREATED for one the
 * Dashboard service created and no computing unit has started yet.
 */
export type AdminExecutionStatus =
  "CREATED" | "READY" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "KILLED" | "UNKNOWN";

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
  /** Why it is in its status, when the service says, such as "unit lost" or "killed by the user". */
  reason?: string;
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
  /** In epoch milliseconds, and 0 while the execution is open. */
  endTime: number;
  reason: string | null;
}

const statuses = new Set<string>(["CREATED", "READY", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "KILLED"]);
const executionPageSize = 20;
/** The states of an execution on a unit that has ended, which a stop leaves as they are. */
const endedStates = new Set<ExecutionState>(["Completed", "Failed", "Killed"]);

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
        reason: answer.reason || undefined,
        startedAt: answer.startTime,
        endedAt: answer.endTime || null,
      }));
    },
    getNextPageParam: (last, pages) => (last.length === executionPageSize ? pages.length : undefined),
  });
}

/**
 * Stops an execution that is under way, as the list shows it. It is stopped where it is executed: on the computing
 * unit that its workflow's latest execution names, through the unit's socket, as the person who started it would.
 * The stop names the execution, so that the unit stops no other one in its place. One that is no longer its
 * workflow's latest, because the workflow was executed again since the list was read, is not stopped: where it is
 * executed is not known. Only an execution of a workflow the administrator may open can be stopped: the service
 * tells no one else where its latest execution is.
 *
 * It is done once the unit shows the execution ended, by this stop or before it. It fails with the unit's reason
 * when the unit does not stop it, such as for an administrator who may only read the unit, and when the unit does
 * not answer.
 */
export async function stopExecution({
  workflowId,
  executionId,
}: Pick<AdminExecution, "workflowId" | "executionId">): Promise<void> {
  const { eId, cuId } = await api<{ eId: number; cuId: number | null }>(`/executions/${workflowId}/latest`);
  if (eId !== executionId) {
    throw new Error("The workflow was executed again since the list was read, so nothing was stopped.");
  }
  if (cuId === null) throw new Error("The execution names no computing unit to stop it on.");
  const client = new ExecutionClient(workflowId, cuId);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The computing unit did not answer.")), 10_000);
    let asked = false;
    const stop = client.subscribe(() => {
      const { connected, executionId: shown, state, notice } = client.snapshot();
      if (!asked) {
        if (!connected) return;
        asked = true;
        client.kill(executionId);
        return;
      }
      if (notice === undefined && !(shown === executionId && endedStates.has(state))) return;
      clearTimeout(timer);
      stop();
      if (notice === undefined) resolve();
      else reject(new Error(notice));
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
