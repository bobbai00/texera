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

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { admin } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addExecutionRecord } from "@/testing/mock-api/execution";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { renderWithProviders } from "@/testing/render";
import { sessionFor } from "@/testing/session";
import { ExecutionHistory } from "./execution-history";

/** An operator's totals as the engine last sampled them, with the time its workers spent on data. */
const sampled = (operatorId: string, inputTupleCount: number, outputTupleCount: number, seconds: number) => ({
  operatorId,
  timestamp: Date.UTC(2026, 10, 18, 10, 0, 12),
  inputTupleCount,
  outputTupleCount,
  dataProcessingTime: seconds * 1e9,
  controlProcessingTime: 0,
  idleTime: 0,
  numWorkers: 1,
  status: 3,
});

describe("ExecutionHistory", () => {
  it("says what each operator of an execution did: the rows it took and put out, and its time", async () => {
    const { wid } = addWorkflow(db, { name: "Heavy penguins" });
    addExecutionRecord(db, {
      wid,
      statistics: [sampled("scan", 0, 5265, 1), sampled("filter", 5265, 3, 2), sampled("limit", 3, 1, 0)],
    });
    const { user } = renderWithProviders(
      <ExecutionHistory
        workflowId={wid}
        canChange={false}
        operatorNames={{ scan: "CSV File Scan", filter: "Filter", limit: "Limit" }}
        state="Completed"
        onOpenVersion={() => {}}
      />,
      { session: sessionFor(admin) }
    );

    await user.click(await screen.findByRole("button", { name: "Statistics" }));

    const statistics = await screen.findByRole("table", { name: "Statistics" });
    expect(
      within(statistics)
        .getAllByRole("row")
        .map(row => row.textContent)
    ).toEqual([
      "OperatorRowsTimeRows as they came",
      "CSV File Scan5,265 rows1 s",
      "Filter5,265 → 3 rows2 s",
      "Limit3 → 1 row0 ms",
    ]);
  });
});
