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
import { operatorCard, operatorSpacing } from "./canvas-geometry";
import { layout } from "./layout";
import type { Point } from "./model";

/** Whether two cards placed at these corners lie over each other. */
const overlap = (p: Point, q: Point) =>
  Math.abs(p.x - q.x) < operatorCard.width && Math.abs(p.y - q.y) < operatorCard.height;

describe("layout", () => {
  it("places each operator in the column after the one it depends on, and two that depend on one a row apart", () => {
    const content = workflowContent(
      [
        operator("CSVFileScan", "scan"),
        operator("Filter", "filter"),
        operator("Limit", "limit"),
        operator("Sort", "sort"),
      ],
      [link("scan", "filter"), link("scan", "limit"), link("filter", "sort")]
    );

    const positions = layout(content);

    expect(positions.filter.x - positions.scan.x).toBe(320);
    expect(positions.sort.x - positions.filter.x).toBe(320);
    expect(positions.filter.x).toBe(positions.limit.x);
    expect(Math.abs(positions.filter.y - positions.limit.y)).toBeGreaterThanOrEqual(128);
  });

  it("places an operator after every one it depends on, in the column after the furthest of them", () => {
    const content = workflowContent(
      [operator("CSVFileScan", "scan"), operator("Filter", "filter"), operator("HashJoin", "join")],
      [link("scan", "filter"), link("filter", "join"), link("scan", "join", 1)]
    );

    const positions = layout(content);

    expect(positions.filter.x - positions.scan.x).toBe(320);
    expect(positions.join.x - positions.filter.x).toBe(320);
  });

  it("puts no card on another, and starts at the top left corner of the canvas", () => {
    const content = workflowContent(
      [
        operator("CSVFileScan", "left"),
        operator("CSVFileScan", "right"),
        operator("Filter", "filter"),
        operator("HashJoin", "join"),
        operator("Limit", "limit"),
      ],
      [link("left", "filter"), link("filter", "join"), link("right", "join", 1), link("join", "limit")]
    );

    const positions = Object.values(layout(content));

    for (const [index, place] of positions.entries()) {
      for (const other of positions.slice(index + 1)) expect(overlap(place, other)).toBe(false);
    }
    expect(Math.min(...positions.map(({ x }) => x))).toBe(0);
    expect(Math.min(...positions.map(({ y }) => y))).toBe(0);
  });

  it("lays out a workflow without links in one column, and an empty one", () => {
    const positions = layout(workflowContent([operator("Limit", "a"), operator("Limit", "b")]));

    expect(Object.keys(positions)).toEqual(["a", "b"]);
    expect(positions.a.x).toBe(positions.b.x);
    expect(Math.abs(positions.a.y - positions.b.y)).toBeGreaterThanOrEqual(operatorSpacing.row);
    expect(layout(workflowContent([]))).toEqual({});
  });

  it("leaves out a link that does not join two of the workflow's operators", () => {
    const operators = [operator("Limit", "a"), operator("Limit", "b")];
    const unlinked = layout(workflowContent(operators));

    // A link made while someone else deleted the operator it comes from takes no column of its own.
    expect(layout(workflowContent(operators, [link("gone", "a")]))).toEqual(unlinked);
    // A link from an operator to itself leaves no room around it.
    expect(layout(workflowContent(operators, [link("a", "a")]))).toEqual(unlinked);
  });
});
