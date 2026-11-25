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

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { admin } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addExecutionRecord } from "@/testing/mock-api/execution";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { signInAs } from "@/testing/session";
import { executionHistoryQuery } from "./api";

describe("executionHistoryQuery", () => {
  it("names where each execution stands: one no unit has started yet, and one whose state was not read", async () => {
    signInAs(admin);
    const { wid } = addWorkflow(db, { name: "Iris" });
    // Oldest first: the history lists them the other way around.
    for (const status of [6, 0, 1, 2, 3, 4, 5, -1, 9]) addExecutionRecord(db, { wid, status });

    const executions = await new QueryClient().fetchQuery(executionHistoryQuery(wid));

    expect(executions.map(execution => execution.status)).toEqual([
      "Unknown",
      "Unknown",
      "Killed",
      "Failed",
      "Completed",
      "Paused",
      "Running",
      "Initializing",
      "Created",
    ]);
  });

  it("reads why an execution is in its status, and when it took it, also for one that is open", async () => {
    signInAs(admin);
    const { wid } = addWorkflow(db, { name: "Iris" });
    addExecutionRecord(db, { wid, status: 4, reason: "unit lost", startingTime: 1_000, lastUpdateTime: 5_000 });
    addExecutionRecord(db, { wid, status: 6, startingTime: 9_000, lastUpdateTime: null });

    const executions = await new QueryClient().fetchQuery(executionHistoryQuery(wid));

    expect(executions.map(({ status, reason, updatedAt }) => ({ status, reason, updatedAt }))).toEqual([
      { status: "Created", reason: undefined, updatedAt: 9_000 },
      { status: "Failed", reason: "unit lost", updatedAt: 5_000 },
    ]);
  });
});
