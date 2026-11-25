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

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExecutionClient } from "@/lib/execution/client";
import { logicalPlan } from "@/lib/workflow/plan";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addComputingUnit, addExecutionRecord } from "@/testing/mock-api/execution";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { renderApp } from "@/testing/render";
import { sessionFor, signInAs } from "@/testing/session";
import { operator, workflowContent } from "@/testing/workflow";

const at = (minute: number) => Date.UTC(2026, 10, 18, 10, minute);

describe("the executions page of the administration", () => {
  it("lists the latest execution of every workflow, the most recently ended first, of the statuses asked for", async () => {
    const iris = addWorkflow(db, { name: "Iris" });
    const penguins = addWorkflow(db, { name: "Penguins", ownerUid: reader.uid });
    addExecutionRecord(db, { wid: iris.wid, name: "Old try", status: 4, startingTime: at(0), lastUpdateTime: at(1) });
    addExecutionRecord(db, { wid: iris.wid, name: "New try", status: 3, startingTime: at(5), lastUpdateTime: at(6) });
    addExecutionRecord(db, {
      wid: penguins.wid,
      name: "Theirs",
      uid: reader.uid,
      status: 4,
      startingTime: at(2),
      lastUpdateTime: at(9),
    });
    const { user } = renderApp("/admin/executions", { session: sessionFor(admin) });

    const table = await screen.findByRole("table", { name: "Executions" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map(row =>
        within(row)
          .getAllByRole("cell")
          .slice(0, 4)
          .map(cell => cell.textContent)
      )
    ).toEqual([
      ["Penguins", "Theirs", "reader", "Failed"],
      ["Iris", "New try", "texera", "Completed"],
    ]);

    await user.click(screen.getByRole("button", { name: "Completed" }));
    await waitFor(() =>
      expect(within(screen.getByRole("table", { name: "Executions" })).getAllByRole("row")).toHaveLength(2)
    );
  });

  it("stops an execution that is under way, on the unit it is executed on", async () => {
    db.executionMs = 60_000;
    const unit = addComputingUnit(db, { name: "Small unit" });
    const workflow = addWorkflow(db, {
      name: "Slow",
      content: workflowContent([operator("Limit", "limit", { limit: 1 })]),
    });
    signInAs(admin);
    const someone = new ExecutionClient(workflow.wid, unit.cuid);
    someone.connect();
    await waitFor(() => expect(someone.snapshot().connected).toBe(true));
    someone.start(logicalPlan(workflowContent([operator("Limit", "limit", { limit: 1 })])), {
      dataTransferBatchSize: 400,
    });
    await waitFor(() => expect(db.executions[workflow.wid]?.state).toBe("Running"));
    const { user } = renderApp("/admin/executions", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "Stop the execution of Slow" }));

    await waitFor(() => expect(db.executions[workflow.wid].state).toBe("Killed"));
    someone.close();
  });
});
