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

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComputingUnit } from "@/components/resource/api";
import { ExecutionClient, type ExecutionSnapshot } from "@/lib/execution/client";
import { admin } from "@/testing/fixtures";
import { renderWithProviders } from "@/testing/render";
import { sessionFor } from "@/testing/session";
import { operator, workflowContent } from "@/testing/workflow";
import type { Execution } from "../use-execution";
import { ExecutionControls } from "./execution-controls";

const unit: ComputingUnit = {
  kind: "computing-unit",
  id: 1,
  name: "Small unit",
  description: "",
  owner: "texera",
  createdAt: Date.UTC(2026, 10, 12),
  access: "owner",
  status: "Running",
  type: "local",
};

const content = workflowContent([operator("Limit", "limit", { limit: 5 })]);

/** The controls of an execution that is as the snapshot says, on a client whose requests are only counted. */
function renderControls(snapshot: Partial<ExecutionSnapshot>, { warehouseMissing = false } = {}) {
  const client = new ExecutionClient(7, unit.id);
  const calls = {
    start: vi.spyOn(client, "start").mockResolvedValue(undefined),
    pause: vi.spyOn(client, "pause").mockImplementation(() => {}),
    kill: vi.spyOn(client, "kill").mockImplementation(() => {}),
  };
  const execution: Execution = {
    units: [unit],
    unit,
    chooseUnit: () => {},
    warehouses: [],
    warehouse: undefined,
    chooseWarehouse: () => {},
    warehouseMissing,
    client,
    snapshot: { ...client.snapshot(), connected: true, ...snapshot },
  };
  const rendered = renderWithProviders(
    <ExecutionControls
      execution={execution}
      content={content}
      executable
    />,
    { session: sessionFor(admin) }
  );
  return { ...rendered, calls };
}

describe("ExecutionControls", () => {
  it("pauses and stops an execution that its unit shows under way", async () => {
    const { user, calls } = renderControls({ state: "Running", executionId: 4 });

    await user.click(screen.getByRole("button", { name: "Pause" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(calls.pause).toHaveBeenCalledOnce();
    expect(calls.kill).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Execute" })).not.toBeInTheDocument();
  });

  it("offers no pause or stop for an execution its unit does not show, and executes another once connected", async () => {
    const { user, calls } = renderControls({ state: "Running", followedAtDashboard: true });

    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Execute" }));

    expect(calls.start).toHaveBeenCalledOnce();
  });

  it("executes nothing while the unit cannot be reached, and says so", () => {
    renderControls({ state: "Running", followedAtDashboard: true, connected: false });

    const execute = screen.getByRole("button", { name: "Execute" });
    expect(execute).toBeDisabled();
    expect(execute).toHaveAttribute("title", "Connecting to the computing unit…");
  });

  it("executes nothing, and keeps what is shown, on a deployment that requires a warehouse the user does not have", () => {
    renderControls({ state: "Completed", executionId: 4 }, { warehouseMissing: true });

    const execute = screen.getByRole("button", { name: "Execute" });
    expect(execute).toBeDisabled();
    expect(execute).toHaveAttribute(
      "title",
      "This deployment keeps each execution's results in a warehouse: create one first."
    );
  });

  it("says beside the controls why the unit did not do what was asked, without calling it a failure", () => {
    renderControls({ state: "Running", executionId: 4, notice: "Execution 3 is not running here." });

    expect(screen.getByRole("alert")).toHaveTextContent("Execution 3 is not running here.");
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });
});
