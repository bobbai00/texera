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

// What the service asks of Texera's backend, each time as the user it is working for: a workflow as it is saved,
// and saving one. Both are the Dashboard Service's /workflow endpoints (WorkflowResource.scala).

import { parseContent, type WorkflowContent } from "@/lib/workflow/model";

export interface Backend {
  /**
   * The workflow as it is saved, and whether this user may only look at it. It rejects for a user who may not
   * open the workflow, and for a token the backend does not accept.
   */
  open(workflowId: number, token: string): Promise<{ content: WorkflowContent; readonly: boolean }>;
  /** Saves a workflow's content, in the name of the user whose token it is. */
  save(workflowId: number, content: WorkflowContent, token: string): Promise<void>;
}

/** The backend did not do what it was asked: it refused the user (4xx), or it failed (5xx). */
export class BackendError extends Error {
  readonly status: number;

  constructor(status: number, path: string) {
    super(`The backend answered ${status} to ${path}.`);
    this.status = status;
  }

  /** Whether asking again cannot change the answer: the backend refused this user, as for a deleted workflow. */
  get final(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/** A workflow as the backend sends it (WorkflowWithPrivilege). Its content is JSON in a string. */
interface WorkflowAnswer {
  name: string;
  description: string | null;
  content: string | null;
  readonly: boolean;
}

/** Texera's backend, reached through its gateway at `url`. */
export function texeraBackend(url: string): Backend {
  async function call(path: string, token: string, json?: unknown): Promise<Response> {
    const response = await fetch(new URL(`/api${path}`, url), {
      method: json === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(json !== undefined && { "Content-Type": "application/json" }) },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    if (!response.ok) throw new BackendError(response.status, path);
    return response;
  }
  const workflow = async (workflowId: number, token: string) =>
    (await (await call(`/workflow/${workflowId}`, token)).json()) as WorkflowAnswer;

  return {
    async open(workflowId, token) {
      const { content, readonly } = await workflow(workflowId, token);
      return { content: parseContent(content), readonly };
    },
    async save(workflowId, content, token) {
      // The endpoint saves the name and the description along with the content. The service knows only the
      // content, so it reads the other two first: someone may have renamed the workflow since the room opened.
      const { name, description } = await workflow(workflowId, token);
      await call("/workflow/persist", token, { wid: workflowId, name, description, content: JSON.stringify(content) });
    },
  };
}
