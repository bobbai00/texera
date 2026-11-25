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

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComputingUnit } from "@/components/resource/api";
import { ExecutionClient, type ExecutionSnapshot } from "@/lib/execution/client";
import type { WorkflowContent } from "@/lib/workflow/model";
import { logicalPlan } from "@/lib/workflow/plan";
import { link, operator, workflowContent } from "@/testing/workflow";
import type { Execution } from "./use-execution";
import { useExecutionUpTo } from "./use-execution-up-to";

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

/** scan -> filter -> limit, with the scan marked to keep its result. */
const content = workflowContent(
  [
    { ...operator("CSVFileScan", "scan", { fileName: "penguins.csv" }), viewResult: true },
    operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: "3600" }] }),
    operator("Limit", "limit", { limit: 5 }),
  ],
  [link("scan", "filter"), link("filter", "limit")]
);

interface Setup {
  snapshot?: Partial<ExecutionSnapshot>;
  /** Without a client, as when no unit is running. */
  client?: false;
  warehouseMissing?: boolean;
  content?: WorkflowContent;
  problems?: Record<string, string>;
}

/** Executing up to an operator of a workflow as the setup says, on a client whose starts are only counted. */
function executionUpTo({ snapshot = {}, client: withClient, warehouseMissing = false, ...setup }: Setup = {}) {
  const client = new ExecutionClient(7, unit.id);
  const start = vi.spyOn(client, "start").mockResolvedValue(undefined);
  const execution: Execution = {
    units: [unit],
    unit,
    chooseUnit: () => {},
    warehouses: [{ id: 4, name: "default" }],
    warehouse: { id: 4, name: "default" },
    chooseWarehouse: () => {},
    warehouseMissing,
    client: withClient === false ? undefined : client,
    snapshot: { ...client.snapshot(), connected: true, ...snapshot },
  };
  const { result } = renderHook(() => useExecutionUpTo(execution, setup.content ?? content, setup.problems ?? {}));
  return { upTo: result.current, start };
}

describe("useExecutionUpTo", () => {
  it("executes the operator and what it needs, never naming a target, so that each kept result is kept", () => {
    const { upTo, start } = executionUpTo();

    const filter = upTo("filter");
    expect(filter.problem).toBeUndefined();
    filter.start();

    expect(start).toHaveBeenCalledExactlyOnceWith(logicalPlan(content, "filter"), content.settings, 4);
    const [plan] = start.mock.calls[0];
    expect(plan.operators.map(each => each.operatorID)).toEqual(["scan", "filter"]);
    expect(plan.opsToViewResult).toEqual(["scan"]);
    expect(plan).not.toHaveProperty("targetOperatorId");
  });

  it.each<[string, Setup, string]>([
    ["there is no unit to execute on", { client: false }, "Start a computing unit to execute."],
    ["the unit cannot be reached yet", { snapshot: { connected: false } }, "Connecting to the computing unit…"],
    ["an execution is under way on the unit", { snapshot: { state: "Running" } }, "An execution is under way."],
    [
      "the deployment requires a warehouse the user does not have",
      { warehouseMissing: true },
      "This deployment keeps each execution's results in a warehouse: create one first.",
    ],
    // The reason that comes first is the one the toolbar's Execute gives too: what the user must do, before what
    // passes by itself.
    [
      "a warehouse is missing and the unit cannot be reached yet",
      { warehouseMissing: true, snapshot: { connected: false } },
      "This deployment keeps each execution's results in a warehouse: create one first.",
    ],
    [
      "there is no unit, on a deployment whose warehouse the user does not have",
      { client: false, warehouseMissing: true },
      "Start a computing unit to execute.",
    ],
  ])("executes nothing while %s, and says so", (_, setup, problem) => {
    const { upTo, start } = executionUpTo(setup);

    const filter = upTo("filter");
    expect(filter.problem).toBe(problem);
    filter.start();

    expect(start).not.toHaveBeenCalled();
  });

  it("executes again while an execution its unit does not show is followed at the Dashboard service", () => {
    const { upTo } = executionUpTo({ snapshot: { state: "Running", followedAtDashboard: true } });

    expect(upTo("filter").problem).toBeUndefined();
  });

  it("executes nothing up to an operator that is left out of executions", () => {
    const left = { ...content, operators: content.operators.map(each => ({ ...each, isDisabled: true })) };
    const { upTo, start } = executionUpTo({ content: left });

    const filter = upTo("filter");
    expect(filter.problem).toBe("It is left out of executions.");
    filter.start();

    expect(start).not.toHaveBeenCalled();
  });

  it("says what is wrong with the operator, or with one it needs, and minds no operator it does not need", () => {
    const { upTo, start } = executionUpTo({
      problems: { filter: "Predicates is not set.", limit: "Limit is not set." },
    });

    expect(upTo("filter").problem).toBe("Predicates is not set.");
    expect(upTo("limit").problem).toBe("Limit is not set.");
    upTo("filter").start();
    expect(start).not.toHaveBeenCalled();

    const before = executionUpTo({ problems: { scan: "File is not set." } });
    expect(before.upTo("filter").problem).toBe("An operator it needs cannot be executed as it is.");
    const after = executionUpTo({ problems: { limit: "Limit is not set." } });
    expect(after.upTo("filter").problem).toBeUndefined();
  });
});
