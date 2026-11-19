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
import { linkProblem, nextPortId } from "./links";

const out = (operatorID: string, port = 0) => ({ operatorID, portID: `output-${port}` });
const into = (operatorID: string, port = 0) => ({ operatorID, portID: `input-${port}` });

const content = workflowContent(
  [
    operator("CSVFileScan", "scan"),
    operator("Filter", "filter"),
    operator("HashJoin", "join"),
    operator("BarChart", "chart"),
  ],
  [link("scan", "filter")]
);

describe("linkProblem", () => {
  it("allows a link from an output port to a free input port of another operator", () => {
    expect(linkProblem(content, out("filter"), into("join", 0))).toBeUndefined();
    expect(linkProblem(content, out("filter"), into("join", 1))).toBeUndefined();
  });

  it("allows a second link into an input port that takes several", () => {
    expect(linkProblem(content, out("join"), into("filter"))).toBeUndefined();
  });

  it.each([
    ["from an input port", into("filter"), into("join")],
    ["to an output port", out("scan"), out("filter")],
    ["from an operator that is not there", out("ghost"), into("join")],
    ["to a port the operator does not have", out("scan"), into("join", 5)],
  ])("refuses a link %s", (_, source, target) => {
    expect(linkProblem(content, source, target)).toBe("A link goes from an output port to an input port.");
  });

  it("refuses a link from an operator to itself", () => {
    expect(linkProblem(content, out("filter"), into("filter"))).toBe("An operator cannot be linked to itself.");
  });

  it("refuses a link that is there already", () => {
    expect(linkProblem(content, out("scan"), into("filter"))).toBe("These two ports are linked already.");
  });

  it("refuses a second link into an input port that takes one", () => {
    const withChart = { ...content, links: [...content.links, link("filter", "chart")] };

    expect(linkProblem(withChart, out("scan"), into("chart"))).toBe("This input port takes one link only.");
  });
});

describe("nextPortId", () => {
  it("numbers a new port after the highest one on its side", () => {
    expect(nextPortId([], "input")).toBe("input-0");
    expect(nextPortId([{ portID: "output-0" }, { portID: "output-2" }], "output")).toBe("output-3");
  });
});
