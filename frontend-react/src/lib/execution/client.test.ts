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

import { ws } from "msw";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { logicalPlan } from "@/lib/workflow/plan";
import { defaultSettings } from "@/lib/workflow/model";
import { admin } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { server } from "@/testing/server";
import { signInAs } from "@/testing/session";
import { link, operator, workflowContent } from "@/testing/workflow";
import { ExecutionClient } from "./client";

const penguins = {
  columns: [
    { attributeName: "species", attributeType: "string" },
    { attributeName: "mass", attributeType: "integer" },
  ],
  rows: [
    { species: "Adelie", mass: 3750 },
    { species: "Gentoo", mass: 5000 },
    { species: "Chinstrap", mass: 3500 },
  ],
};

/** scan -> filter (mass > 3600) -> limit: the limit's two rows are kept as the result. */
const plan = logicalPlan(
  workflowContent(
    [
      operator("CSVFileScan", "scan", { fileName: "penguins.csv" }),
      operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: "3600" }] }),
      operator("Limit", "limit", { limit: 5 }),
    ],
    [link("scan", "filter"), link("filter", "limit")]
  )
);

/** A client of workflow 7 on unit 1, connected, which closes when the test ends. */
async function connect() {
  const client = new ExecutionClient(7, 1);
  onTestFinished(() => client.close());
  client.connect();
  await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
  return client;
}

beforeEach(() => {
  signInAs(admin);
  db.files["penguins.csv"] = penguins;
});
afterEach(() => vi.useRealTimers());

describe("ExecutionClient", () => {
  it("is told that nothing has been executed yet when it connects", async () => {
    const client = await connect();

    expect(client.snapshot()).toMatchObject({ state: "Uninitialized", operators: {}, results: {}, errors: [] });
  });

  it("follows an execution to its end: each operator's rows, and the results that were kept", async () => {
    const client = await connect();

    client.start(plan, defaultSettings);
    expect(client.snapshot().state).toBe("Initializing");

    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));
    expect(client.snapshot().operators).toEqual({
      scan: { state: "Completed", inputRows: 0, outputRows: 3 },
      filter: { state: "Completed", inputRows: 3, outputRows: 2 },
      limit: { state: "Completed", inputRows: 2, outputRows: 2 },
    });
    expect(client.snapshot().results).toEqual({ limit: { kind: "table", totalRows: 2, revision: 1 } });
  });

  it("pages through an operator's result", async () => {
    const client = await connect();
    client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));

    await expect(client.page("limit", 1, 1)).resolves.toEqual({
      rows: [{ species: "Adelie", mass: 3750 }],
      columns: penguins.columns,
    });
    await expect(client.page("limit", 2, 1)).resolves.toEqual({
      rows: [{ species: "Gentoo", mass: 5000 }],
      columns: penguins.columns,
    });
  });

  it("says why an execution failed, and which operator it was about", async () => {
    const client = await connect();
    db.files = {};

    client.start(plan, defaultSettings);

    await vi.waitFor(() => expect(client.snapshot().state).toBe("Failed"));
    expect(client.snapshot().errors).toEqual([
      { message: "java.io.FileNotFoundException: penguins.csv", operatorId: "scan" },
    ]);
  });

  it("names the warehouse an execution keeps its results in, which a deployment with warehouses asks for", async () => {
    db.warehouses = [{ whid: 4, name: "default" }];
    const client = await connect();

    client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Failed"));
    expect(client.snapshot().errors).toEqual([
      { message: "java.lang.IllegalArgumentException: a warehouse must be selected for this execution" },
    ]);

    client.start(plan, defaultSettings, 4);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));
  });

  it("pauses, resumes and stops an execution that is under way", async () => {
    db.executionMs = 60_000;
    const client = await connect();
    client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
    expect(client.snapshot().operators.scan).toEqual({ state: "Running", inputRows: 0, outputRows: 0 });

    client.pause();
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Paused"));
    client.resume();
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
    client.kill();
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Killed"));
  });

  it("shows two people the same execution, and tells whoever connects later where it stands", async () => {
    db.executionMs = 60_000;
    const mine = await connect();
    const theirs = await connect();

    mine.start(plan, defaultSettings);
    await vi.waitFor(() => expect(theirs.snapshot().state).toBe("Running"));

    const latecomer = await connect();
    await vi.waitFor(() => expect(latecomer.snapshot().state).toBe("Running"));
    expect(latecomer.snapshot().operators.scan.state).toBe("Running");

    db.executions[7].finish();
    await vi.waitFor(() => expect(latecomer.snapshot().state).toBe("Completed"));
    expect(theirs.snapshot().results).toEqual(mine.snapshot().results);
  });

  it("takes every operator as completed once the execution has, whatever the engine last said of it", async () => {
    const running = { operatorState: "Running", aggregatedInputRowCount: 2, aggregatedOutputRowCount: 2 };
    // The test speaks for the engine, beside what the fake engine says when someone connects.
    let say: (event: object) => void = () => {};
    server.use(
      ws.link(`ws://${window.location.host}/wsapi/workflow-websocket`).addEventListener("connection", ({ client }) => {
        say = event => client.send(JSON.stringify(event));
      })
    );
    const client = await connect();

    // The engine's last word on the operator comes before its last word on the execution, and again after it.
    say({ type: "OperatorStatisticsUpdateEvent", operatorStatistics: { limit: running } });
    say({ type: "WorkflowStateEvent", state: "Completed" });
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));
    expect(client.snapshot().operators).toEqual({ limit: { state: "Completed", inputRows: 2, outputRows: 2 } });

    say({
      type: "OperatorStatisticsUpdateEvent",
      operatorStatistics: { limit: { ...running, aggregatedOutputRowCount: 3 } },
    });
    await vi.waitFor(() => expect(client.snapshot().operators.limit.outputRows).toBe(3));
    expect(client.snapshot().operators.limit.state).toBe("Completed");
  });

  it("tells its listeners of every change, and refuses a page while it is not connected", async () => {
    const client = new ExecutionClient(7, 1);
    const listener = vi.fn();
    client.subscribe(listener);

    await expect(client.page("limit", 1, 20)).rejects.toThrow("Not connected to the computing unit.");
    client.connect();
    onTestFinished(() => client.close());

    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  });
});
