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

import type { APIRequest, APIRequestContext } from "@playwright/test";

/** The gateway of the test backend (e2e/stack/): it serves the API, the Angular app at / and this app at /alpha/. */
export const gateway = process.env.E2E_GATEWAY ?? "http://127.0.0.1:18080";

export interface Credentials {
  username: string;
  password: string;
}

/** The administrator the Dashboard Service creates on its first start. Its email is "texera" too. */
export const admin: Credentials = { username: "texera", password: "texera" };

/** A second person to share datasets with. global-setup.ts registers the account. */
export const reader = { username: "e2e-reader", email: "e2e-reader@example.com", password: "e2e-reader-password" };

export interface Dataset {
  did: number;
  name: string;
  ownerEmail: string;
}

export type Privilege = "READ" | "WRITE";

/** A file to upload, in the form Playwright's setInputFiles takes. */
export interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** A small text file to upload. */
export function textFile(name: string, text: string): FilePayload {
  return { name, mimeType: "text/plain", buffer: Buffer.from(text) };
}

/** A workflow, as a test needs to know it. */
export interface Workflow {
  wid: number;
  name: string;
}

/** The parts of a saved workflow that the tests check. */
export interface WorkflowContent {
  operators: {
    operatorID: string;
    operatorType: string;
    customDisplayName?: string;
    operatorProperties: Record<string, unknown>;
  }[];
  links: unknown[];
  commentBoxes: { commentBoxID: string; comments: { content: string; creatorName: string }[] }[];
}

/** Every dataset and workflow a test makes has a name that starts with this, so that the tests can delete them all. */
const testDatasetPrefix = "e2e-";

/**
 * The Texera API, signed in as one user. Tests use it to set up what a scenario starts from and to check what
 * the apps do not show. A test deletes no dataset itself, as the Angular app's dataset list fails when a dataset
 * goes while it loads, and tests run in parallel: global-setup.ts deletes them all once the tests are done.
 */
export class Backend {
  /** The user's sign-in token, which the browser can use too. */
  readonly token: string;
  private readonly api: APIRequestContext;

  private constructor(api: APIRequestContext, token: string) {
    this.api = api;
    this.token = token;
  }

  static async signIn(request: APIRequest, user: Credentials): Promise<Backend> {
    const anonymous = await request.newContext({ baseURL: gateway, failOnStatusCode: true });
    const response = await anonymous.post("/api/auth/login", { data: user });
    const { accessToken } = (await response.json()) as { accessToken: string };
    await anonymous.dispose();
    const api = await request.newContext({
      baseURL: gateway,
      // Every call that fails throws, with the status and the server's message.
      failOnStatusCode: true,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    return new Backend(api, accessToken);
  }

  /** A dataset name that no other test uses, e2e-<task>-<random>. */
  datasetName(task: string): string {
    return `${testDatasetPrefix}${task}-${crypto.randomUUID().slice(0, 8)}`;
  }

  /** Creates a private dataset with no versions. */
  async createDataset(name: string): Promise<Dataset> {
    const response = await this.api.post("/api/dataset/create", {
      data: { datasetName: name, datasetDescription: "", isDatasetPublic: false, isDatasetDownloadable: true },
    });
    const { dataset, ownerEmail } = (await response.json()) as DashboardDataset;
    return { did: dataset.did, name: dataset.name, ownerEmail };
  }

  /**
   * Stages a file in the dataset, as the apps do: start a multipart upload, send the file as its one part,
   * finish. The File Service decodes the path twice on start and finish, so keep file names to letters,
   * digits, ".", "_" and "-", which need no encoding.
   */
  async uploadFile(dataset: Dataset, file: FilePayload): Promise<void> {
    const upload = { ownerEmail: dataset.ownerEmail, datasetName: dataset.name, filePath: file.name };
    const size = file.buffer.length;
    await this.api.post("/api/dataset/multipart-upload", {
      params: { type: "init", ...upload, fileSizeBytes: size, partSizeBytes: size },
      data: {},
    });
    await this.api.post("/api/dataset/multipart-upload/part", {
      params: { ...upload, partNumber: 1 },
      headers: { "Content-Type": "application/octet-stream" },
      data: file.buffer,
    });
    await this.api.post("/api/dataset/multipart-upload", { params: { type: "finish", ...upload }, data: {} });
  }

  /** Makes a version of everything staged in the dataset. The server names it "v<n> - <description>". */
  async createVersion(dataset: Dataset, description: string): Promise<void> {
    await this.api.post(`/api/dataset/${dataset.did}/version/create`, {
      headers: { "Content-Type": "text/plain" },
      data: description,
    });
  }

  /** A workflow name that no other test uses, e2e-<task>-<random>. */
  workflowName(task: string): string {
    return `${testDatasetPrefix}${task}-${crypto.randomUUID().slice(0, 8)}`;
  }

  /** Creates a workflow with nothing on its canvas. */
  async createWorkflow(name: string): Promise<Workflow> {
    const content = {
      operators: [],
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    };
    const response = await this.api.post("/api/workflow/create", { data: { name, content: JSON.stringify(content) } });
    const { workflow } = (await response.json()) as { workflow: Workflow };
    return { wid: workflow.wid, name: workflow.name };
  }

  /** What is saved of a workflow. */
  async workflowContent({ wid }: Workflow): Promise<WorkflowContent> {
    const response = await this.api.get(`/api/workflow/${wid}`);
    return JSON.parse(((await response.json()) as { content: string }).content) as WorkflowContent;
  }

  /** Lets someone else open a workflow: to look at it ("READ"), or to change it too ("WRITE"). */
  async shareWorkflow({ wid }: Workflow, email: string, privilege: Privilege): Promise<void> {
    await this.api.put(`/api/access/workflow/grant/${wid}/${encodeURIComponent(email)}/${privilege}`);
  }

  /** Deletes every workflow of this user's that a test made, as its name tells. */
  async deleteTestWorkflows(): Promise<void> {
    const response = await this.api.get("/api/workflow/list");
    const workflows = (await response.json()) as { workflow: Workflow; isOwner: boolean }[];
    const wids = workflows
      .filter(({ workflow, isOwner }) => isOwner && workflow.name.startsWith(testDatasetPrefix))
      .map(({ workflow }) => workflow.wid);
    if (wids.length > 0) await this.api.post("/api/workflow/delete", { data: { wids } });
  }

  /** Deletes every dataset of this user's that a test made, as its name tells. */
  async deleteTestDatasets(): Promise<void> {
    const response = await this.api.get("/api/dataset/list");
    for (const { dataset, isOwner } of (await response.json()) as DashboardDataset[]) {
      if (isOwner && dataset.name.startsWith(testDatasetPrefix)) await this.api.delete(`/api/dataset/${dataset.did}`);
    }
  }

  /** The people the dataset is shared with. The owner is not one of them. */
  async accessList(dataset: Dataset): Promise<Access[]> {
    const response = await this.api.get(`/api/access/dataset/list/${dataset.did}`);
    return (await response.json()) as Access[];
  }

  /** Registers an account, which starts inactive. An account that exists already is fine. */
  async registerUser(user: { username: string; email: string; password: string }): Promise<void> {
    const response = await this.api.post("/api/auth/register", { data: user, failOnStatusCode: false });
    if (response.ok()) return;
    const message = await response.text();
    // The server answers 406 with "Username exists already." or "Email exists already.".
    if (response.status() !== 406 || !message.includes("exists already")) {
      throw new Error(`Could not register ${user.username}: ${response.status()} ${message}`);
    }
  }

  /**
   * Lets an account that has just registered use Texera, on a backend where an admin has to say so first. Only
   * an admin can call this.
   */
  async activateUser(username: string): Promise<void> {
    const response = await this.api.get("/api/admin/user/list");
    const users = (await response.json()) as {
      uid: number;
      name: string;
      email: string;
      role: string;
      comment: string | null;
    }[];
    const user = users.find(candidate => candidate.name === username);
    if (!user) throw new Error(`There is no account named ${username} to activate.`);
    if (user.role !== "INACTIVE") return;
    const { uid, name, email, comment } = user;
    await this.api.put("/api/admin/user/update", { data: { uid, name, email, comment, role: "REGULAR" } });
  }

  /** Closes the connection. */
  async dispose(): Promise<void> {
    await this.api.dispose();
  }
}

/** A person a dataset is shared with, as the API lists them. */
interface Access {
  email: string;
  name: string;
  privilege: Privilege;
}

/** How the API returns a dataset, with the fields used here. */
interface DashboardDataset {
  dataset: { did: number; name: string };
  ownerEmail: string;
  isOwner: boolean;
}
