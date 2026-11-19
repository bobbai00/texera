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

import { describe, expect, it } from "vitest";
import { link, operator, workflowContent } from "@/testing/workflow";
import { logicalPlan } from "./plan";

const content = workflowContent(
  [
    operator("CSVFileScan", "scan", { fileName: "iris.csv" }),
    operator("Filter", "filter"),
    { ...operator("Limit", "limit", { limit: 10 }), viewResult: true },
    operator("HashJoin", "join"),
    operator("Sort", "sort"),
  ],
  [
    link("scan", "filter"),
    link("filter", "limit"),
    link("scan", "join", 0),
    link("filter", "join", 1),
    link("join", "sort"),
  ]
);

describe("logicalPlan", () => {
  it("spreads each operator's properties beside its id, its type and its ports, and nothing else", () => {
    const [, limit] = logicalPlan(
      workflowContent([operator("CSVFileScan", "scan"), operator("Limit", "limit", { limit: 10 })])
    ).operators;

    expect(limit).toEqual({
      limit: 10,
      operatorID: "limit",
      operatorType: "Limit",
      inputPorts: [{ portID: "input-0", displayName: "", disallowMultiInputs: false, isDynamicPort: false }],
      outputPorts: [{ portID: "output-0", displayName: "", disallowMultiInputs: false, isDynamicPort: false }],
    });
  });

  it("names the ports of a link by their place on the operator", () => {
    expect(logicalPlan(content).links).toContainEqual({
      fromOpId: "filter",
      fromPortId: { id: 0, internal: false },
      toOpId: "join",
      toPortId: { id: 1, internal: false },
    });
  });

  it("lists the operators whose output is kept for viewing", () => {
    expect(logicalPlan(content).opsToViewResult).toEqual(["limit"]);
    expect(logicalPlan(content).opsToReuseResult).toEqual([]);
  });

  it("leaves out a disabled operator and the links on it", () => {
    const disabled = {
      ...content,
      operators: content.operators.map(each => (each.operatorID === "filter" ? { ...each, isDisabled: true } : each)),
    };

    const plan = logicalPlan(disabled);

    expect(plan.operators.map(each => each.operatorID)).toEqual(["scan", "limit", "join", "sort"]);
    expect(plan.links.map(each => `${each.fromOpId}->${each.toOpId}`)).toEqual(["scan->join", "join->sort"]);
  });

  it("keeps only a target operator and what it depends on", () => {
    const plan = logicalPlan(content, "limit");

    expect(plan.operators.map(each => each.operatorID)).toEqual(["scan", "filter", "limit"]);
    expect(plan.links.map(each => `${each.fromOpId}->${each.toOpId}`)).toEqual(["scan->filter", "filter->limit"]);
  });
});
