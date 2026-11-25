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

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { ExecutionClient } from "@/lib/execution/client";
import { defaultSettings } from "@/lib/workflow/model";
import { logicalPlan } from "@/lib/workflow/plan";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addComputingUnit, addExecutionRecord } from "@/testing/mock-api/execution";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { signInAs } from "@/testing/session";
import { operator, workflowContent } from "@/testing/workflow";
import { stopExecution } from "./api";

describe("stopExecution", () => {
  it("stops nothing of a workflow the administrator may not read, as the service does not say where it is", async () => {
    signInAs(admin);
    const theirs = addWorkflow(db, { name: "Theirs", ownerUid: reader.uid });
    const { eid } = addExecutionRecord(db, { wid: theirs.wid, uid: reader.uid, status: 1 });

    // A 401, which ends the session: the list offers no stop for such a workflow.
    await expect(stopExecution({ workflowId: theirs.wid, executionId: eid })).rejects.toEqual(
      new ApiError(401, "HTTP 401 Unauthorized", { code: 401, message: "HTTP 401 Unauthorized" })
    );
  });

  it("stops nothing when the workflow's latest execution is not the one asked for", async () => {
    signInAs(admin);
    const { wid } = addWorkflow(db, { name: "Iris" });
    const { eid } = addExecutionRecord(db, { wid, status: 1 });
    addExecutionRecord(db, { wid, status: 1 });

    await expect(stopExecution({ workflowId: wid, executionId: eid })).rejects.toThrow(
      "The workflow was executed again since the list was read, so nothing was stopped."
    );
  });

  it("says why the unit did not stop an execution that it does not hold, such as one its restart lost", async () => {
    signInAs(admin);
    const { wid } = addWorkflow(db, { name: "Iris" });
    const { cuid } = addComputingUnit(db, { name: "Small unit" });
    // The list shows it running until the closing job finds that its unit lost it.
    const { eid } = addExecutionRecord(db, { wid, cuid, status: 1 });

    await expect(stopExecution({ workflowId: wid, executionId: eid })).rejects.toThrow(
      `Execution ${eid} is not running here.`
    );
  });

  it("is done with an execution that had ended when the unit was asked to stop it", async () => {
    signInAs(admin);
    const { wid } = addWorkflow(db, { name: "Iris" });
    const { cuid } = addComputingUnit(db, { name: "Small unit" });
    const client = new ExecutionClient(wid, cuid);
    onTestFinished(() => client.close());
    client.connect();
    await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
    await client.start(logicalPlan(workflowContent([operator("Limit", "limit", { limit: 1 })])), defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));
    const { eid } = db.executionRecords.at(-1)!;

    await expect(stopExecution({ workflowId: wid, executionId: eid })).resolves.toBeUndefined();
    expect(db.executionRecords.at(-1)).toMatchObject({ eid, status: 3 });
  });
});
