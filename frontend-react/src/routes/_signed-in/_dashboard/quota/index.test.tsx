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
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addExecutionRecord } from "@/testing/mock-api/execution";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { renderApp } from "@/testing/render";
import { sessionFor } from "@/testing/session";

describe("the quota page", () => {
  it("counts what the user made, and lists what their executions keep, the most first", async () => {
    const iris = addWorkflow(db, { name: "Iris" });
    addWorkflow(db, { name: "Shared with me", ownerUid: reader.uid, grants: [{ uid: admin.uid, privilege: "READ" }] });
    addExecutionRecord(db, { wid: iris.wid, kept: { resultBytes: 1024, runTimeStatsBytes: 512, logBytes: 0 } });
    addExecutionRecord(db, { wid: iris.wid, kept: { resultBytes: 4 * 1024 ** 2, runTimeStatsBytes: 0, logBytes: 0 } });

    renderApp("/quota", { session: sessionFor(admin) });

    expect(await screen.findByText("Workflows you made")).toBeInTheDocument();
    expect(screen.getByText("Workflows you can open").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Kept by your executions").nextElementSibling).toHaveTextContent("4 MB");
    const rows = within(screen.getByRole("table", { name: "What your executions keep" })).getAllByRole("row");
    expect(rows.slice(1).map(row => row.textContent)).toEqual([
      "Iris · execution 24 MB0 B0 B",
      "Iris · execution 11 KB512 B0 B",
    ]);
  });

  it("deletes what an execution keeps", async () => {
    const iris = addWorkflow(db, { name: "Iris" });
    const { eid } = addExecutionRecord(db, {
      wid: iris.wid,
      kept: { resultBytes: 2048, runTimeStatsBytes: 0, logBytes: 0 },
    });
    const { user } = renderApp("/quota", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: `Delete what execution ${eid} keeps` }));

    await waitFor(() =>
      expect(screen.getByText("Kept by your executions").nextElementSibling).toHaveTextContent("0 B")
    );
    expect(db.executionRecords[0].kept.resultBytes).toBe(0);
  });
});
