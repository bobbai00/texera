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

// The calls the app makes for workflows, beyond what every kind of resource shares (finding workflows and
// sharing them go through components/resource/api.ts): the Dashboard Service's /workflow endpoints
// (WorkflowResource.scala), its list of operator types, and the compiling service.

import { queryOptions } from "@tanstack/react-query";
import { resourceKey } from "@/components/resource/api";
import { api } from "@/lib/api-client";
import type { ResourceDeletion } from "@/lib/resource";
import { type CompilationAnswer, type Compilation, readCompilation } from "@/lib/workflow/compilation";
import { emptyContent, parseContent, type WorkflowContent } from "@/lib/workflow/model";
import type { OperatorMetadata } from "@/lib/workflow/operator-schema";
import type { LogicalPlan } from "@/lib/workflow/plan";
import { historyOf, type VersionRecord, type WorkflowHistory } from "@/lib/workflow/versions";

/** A workflow as its editor opens it. */
export interface Workflow {
  id: number;
  name: string;
  description: string;
  content: WorkflowContent;
  /** The signed-in user may look at the workflow but not change it. */
  readonly: boolean;
}

/** A workflow as the server sends it (WorkflowWithPrivilege). Its content is JSON in a string. */
interface WorkflowAnswer {
  wid: number;
  name: string;
  description: string | null;
  content: string | null;
  readonly: boolean;
}

/** One workflow, with everything on its canvas. */
export function workflowQuery(id: number) {
  return queryOptions({
    queryKey: resourceKey({ kind: "workflow", id }),
    queryFn: async (): Promise<Workflow> => {
      const { wid, name, description, content, readonly } = await api<WorkflowAnswer>(`/workflow/${id}`);
      return { id: wid, name, description: description ?? "", content: parseContent(content), readonly };
    },
  });
}

/** Saves a workflow's name, description and content. Each save that changes the content makes a version. */
export function saveWorkflow({ id, name, description, content }: Omit<Workflow, "readonly">): Promise<void> {
  return api("/workflow/persist", {
    method: "POST",
    json: { wid: id, name, description, content: JSON.stringify(content) },
    responseType: "void",
  });
}

/** Creates a workflow owned by the signed-in user, empty or with what is given, and returns its id. */
export async function createWorkflow(name: string, content: WorkflowContent = emptyContent): Promise<number> {
  const created = await api<{ workflow: { wid: number } }>("/workflow/create", {
    method: "POST",
    json: { name, content: JSON.stringify(content) },
  });
  return created.workflow.wid;
}

/** Every version of a workflow, newest first, rebuilt from what is saved of it (WorkflowVersionResource.scala). */
export function workflowHistoryQuery(id: number) {
  return queryOptions({
    queryKey: [...resourceKey({ kind: "workflow", id }), "history"],
    queryFn: () => readHistory(id),
  });
}

/**
 * The versions are rebuilt from the saved workflow back, so the two must be read as of the same save. A save
 * between reading one and the other would set them apart, so both are read until the saved workflow is the same
 * before the versions are read and after.
 */
async function readHistory(id: number): Promise<WorkflowHistory> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await api<WorkflowAnswer>(`/workflow/${id}`);
    const records = await api<VersionRecord[]>(`/version/${id}`);
    const after = await api<WorkflowAnswer>(`/workflow/${id}`);
    if (before.content === after.content) return historyOf(after.content ?? "{}", records);
  }
  throw new Error("The workflow kept changing while its versions were read. Try again in a moment.");
}

/**
 * Deletes a workflow with its versions and the results of its executions. Only its owner may: the server
 * answers anyone else as if it had deleted the workflow, so the app offers "Delete" to the owner alone.
 */
export const workflowDeletion: ResourceDeletion = {
  run: id => api("/workflow/delete", { method: "POST", json: { wids: [id] }, responseType: "void" }),
  consequence: "Its versions and the results of its executions are deleted too.",
};

/** Every operator type the backend offers. It is the same for everyone until the backend is deployed again. */
export function operatorMetadataQuery() {
  return queryOptions({
    queryKey: ["operatorMetadata"],
    queryFn: () => api<OperatorMetadata>("/resources/operator-metadata"),
    staleTime: Infinity,
  });
}

/** Compiles a plan: the columns each operator puts out, and why an operator does not compile. */
export async function compile(plan: LogicalPlan): Promise<Compilation> {
  const { operators, links } = plan;
  const answer = await api<CompilationAnswer>("/compile", {
    method: "POST",
    json: { operators, links, opsToReuseResult: [], opsToViewResult: [] },
  });
  return readCompilation(answer);
}

/** The workflow as a Python script that does what it does, as far as the compiling service can translate it. */
export async function workflowToPython(plan: LogicalPlan): Promise<string> {
  const { operators, links } = plan;
  const answer = await api<{ type: "success"; pythonCode: string } | { type: "failure"; errorMessage: string }>(
    "/workflow-to-python",
    { method: "POST", json: { operators, links, opsToReuseResult: [], opsToViewResult: [] } }
  );
  if (answer.type === "failure") throw new Error(answer.errorMessage);
  return answer.pythonCode;
}
