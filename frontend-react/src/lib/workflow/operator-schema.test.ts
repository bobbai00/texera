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
import { schemaOf } from "@/testing/workflow";
import { defaultProperties, newLinkId, newOperator, newOperatorId } from "./operator-schema";

describe("newOperator", () => {
  it("starts an operator with its type's name, version, ports and the defaults of its schema", () => {
    const scan = newOperator(schemaOf("CSVFileScan"), "scan");

    expect(scan).toMatchObject({
      operatorID: "scan",
      operatorType: "CSVFileScan",
      operatorVersion: "N/A",
      customDisplayName: "CSV File Scan",
      inputPorts: [],
      outputPorts: [{ portID: "output-0" }],
      isDisabled: false,
      showAdvanced: false,
    });
    expect(scan.operatorProperties).toEqual(defaultProperties(schemaOf("CSVFileScan")));
    expect(scan.operatorProperties).toMatchObject({ hasHeader: true });
  });

  it("takes the names of the ports, and which take one link only, from the type", () => {
    expect(newOperator(schemaOf("HashJoin"), "join").inputPorts).toEqual([
      { portID: "input-0", displayName: "left", disallowMultiInputs: false, isDynamicPort: false },
      { portID: "input-1", displayName: "right", disallowMultiInputs: false, isDynamicPort: false },
    ]);
    expect(newOperator(schemaOf("BarChart"), "chart").inputPorts[0].disallowMultiInputs).toBe(true);
    expect(newOperator(schemaOf("PythonUDFV2"), "udf").dynamicInputPorts).toBe(true);
  });

  it("gives every operator and link an id of its own, in the form the engine's messages use", () => {
    expect(newOperatorId("Limit")).toMatch(/^Limit-operator-[0-9a-f-]{36}$/);
    expect(newOperatorId("Limit")).not.toBe(newOperatorId("Limit"));
    expect(newLinkId()).toMatch(/^link-[0-9a-f-]{36}$/);
  });
});
