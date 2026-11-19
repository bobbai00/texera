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

// A fake Texera backend in memory, for unit and component tests. Its handlers answer like the real
// services (each cites the server code it follows), and its records reset before each test, so a
// test can change something and then see it, as on the real backend.

import { type TestUser, users } from "../fixtures";
import { accessHandlers, type MockResource } from "./access";
import { authHandlers } from "./auth";
import { configHandlers, defaultSettings } from "./config";
import { datasetHandlers, type MockDataset } from "./dataset";
import type { MockTable } from "./engine";
import { adminHandlers } from "./admin";
import { hubHandlers, type MockLike } from "./hub";
import { type MockEnvironment, quotaHandlers } from "./quota";
import { executionHandlers, type MockComputingUnit, type MockExecution, type MockExecutionRecord } from "./execution";
import { type MockModel, modelHandlers } from "./model";
import { searchHandlers } from "./search";
import { languageServerHandlers, sharedEditingHandlers } from "./shared-editing";
import { type MockWorkflow, workflowHandlers } from "./workflow";

/** The records of the fake backend. Handlers read and change them, and tests may too. */
export interface MockDb {
  users: TestUser[];
  /** Who owns each resource, whether it is public, and who it is shared with. */
  resources: MockResource[];
  /** The datasets, with their versions and files. A test adds one with addDataset() from ./dataset. */
  datasets: MockDataset[];
  /** A test adds one with addWorkflow() from ./workflow. */
  workflows: MockWorkflow[];
  /** A test adds one with addModel() from ./model. */
  models: MockModel[];
  /** The tables that a scan operator reads, by the file name it is given. */
  files: Record<string, MockTable>;
  /** A test adds one with addComputingUnit() from ./execution. */
  computingUnits: MockComputingUnit[];
  /** The latest execution of each workflow, by the workflow's id. */
  executions: Record<number, MockExecution>;
  /** Every execution the backend keeps a record of. A test adds one with addExecutionRecord() from ./execution. */
  executionRecords: MockExecutionRecord[];
  /** The users' Python environments. */
  environments: MockEnvironment[];
  /** Who likes what in the hub. */
  likes: MockLike[];
  /** The id of the public workflow each copy was made of. */
  clones: number[];
  /** How long an execution stays in "Running" before it completes. 0 completes it at once. */
  executionMs: number;
  /** Whether people may make their own accounts, and whether a code is emailed to them first. */
  signUp: { local: boolean; emailCode: boolean };
  /** The kinds of computing unit the deployment makes: a single-node one makes local units only. */
  unitTypes: ("kubernetes" | "local")[];
  /** The user's warehouses on a deployment that has them, or undefined on one that does not. */
  warehouses: { whid: number; name: string }[] | undefined;
  /** The settings an admin can change, such as the largest file a dataset takes. */
  settings: typeof defaultSettings;
}

export const db: MockDb = {
  users: [],
  resources: [],
  datasets: [],
  workflows: [],
  models: [],
  files: {},
  computingUnits: [],
  executions: {},
  executionRecords: [],
  environments: [],
  likes: [],
  clones: [],
  executionMs: 0,
  unitTypes: ["local"],
  signUp: { local: true, emailCode: false },
  warehouses: undefined,
  settings: defaultSettings,
};

/** Puts the records back to the fixtures; testing/setup.ts calls it before each test. */
export function resetMockApi(): void {
  db.users = structuredClone(users);
  db.resources = [];
  db.datasets = [];
  db.workflows = [];
  db.models = [];
  db.files = {};
  db.computingUnits = [];
  db.executions = {};
  db.executionRecords = [];
  db.environments = [];
  db.likes = [];
  db.clones = [];
  db.executionMs = 0;
  db.unitTypes = ["local"];
  db.signUp = { local: true, emailCode: false };
  db.warehouses = undefined;
  db.settings = { ...defaultSettings };
}

export const handlers = [
  ...authHandlers(db),
  ...accessHandlers(db),
  ...configHandlers(db),
  ...searchHandlers(db),
  ...datasetHandlers(db),
  ...workflowHandlers(db),
  ...executionHandlers(db),
  ...quotaHandlers(db),
  ...adminHandlers(db),
  ...hubHandlers(db),
  ...sharedEditingHandlers(),
  ...languageServerHandlers(),
  ...modelHandlers(db),
];
