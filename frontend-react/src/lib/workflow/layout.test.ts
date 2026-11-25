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
import { layout, operatorLabel, operatorTile } from "./layout";

describe("layout", () => {
  it("places each operator to the right of the ones it depends on, without overlaps", () => {
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

    // Neither the tiles nor the names under them overlap.
    expect(positions.filter.x - positions.scan.x).toBeGreaterThanOrEqual(operatorLabel.width);
    expect(positions.sort.x - positions.filter.x).toBeGreaterThanOrEqual(operatorLabel.width);
    expect(positions.filter.x).toBe(positions.limit.x);
    expect(Math.abs(positions.filter.y - positions.limit.y)).toBeGreaterThanOrEqual(
      operatorTile.height + operatorLabel.height
    );
  });

  it("lays out a workflow without links, and an empty one", () => {
    expect(Object.keys(layout(workflowContent([operator("Limit", "a"), operator("Limit", "b")])))).toEqual(["a", "b"]);
    expect(layout(workflowContent([]))).toEqual({});
  });
});
