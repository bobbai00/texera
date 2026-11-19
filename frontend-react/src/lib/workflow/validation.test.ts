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
import { link, operator, operatorMetadata, workflowContent } from "@/testing/workflow";
import { columnProblems, operatorProblems } from "./validation";

const schemas = new Map(operatorMetadata.operators.map(schema => [schema.operatorType, schema]));

describe("operatorProblems", () => {
  it("finds nothing wrong with operators whose properties are set and whose inputs are linked", () => {
    const content = workflowContent(
      [operator("CSVFileScan", "scan", { fileName: "iris.csv" }), operator("Limit", "limit", { limit: 10 })],
      [link("scan", "limit")]
    );

    expect(operatorProblems(content, schemas)).toEqual({});
  });

  it("names the property that is not set, as the form names it", () => {
    const content = workflowContent([operator("CSVFileScan", "scan")]);

    expect(operatorProblems(content, schemas)).toEqual({ scan: "File is not set." });
  });

  it("says what is wrong with a property that does not fit its type", () => {
    const content = workflowContent(
      [operator("CSVFileScan", "scan", { fileName: "iris.csv" }), operator("Limit", "limit", { limit: "ten" })],
      [link("scan", "limit")]
    );

    expect(operatorProblems(content, schemas)).toEqual({ limit: "Limit must be integer." });
  });

  it("says so when an input port has no link", () => {
    const content = workflowContent(
      [
        operator("CSVFileScan", "scan", { fileName: "iris.csv" }),
        operator("HashJoin", "join", { buildAttributeName: "a", probeAttributeName: "b", joinType: "inner" }),
      ],
      [link("scan", "join", 0)]
    );

    expect(operatorProblems(content, schemas).join).toBe("An input port has no link.");
  });

  it("does not check a disabled operator, and says so when a type is unknown to the server", () => {
    const content = workflowContent([
      { ...operator("Limit", "limit"), isDisabled: true },
      { ...operator("Limit", "old"), operatorType: "TwitterFeed" },
    ]);

    expect(operatorProblems(content, schemas)).toEqual({ old: "This server has no operator type TwitterFeed." });
  });
});

describe("columnProblems", () => {
  const species = { attributeName: "species", attributeType: "string" };
  const content = workflowContent(
    [
      operator("CSVFileScan", "scan", { fileName: "penguins.csv" }),
      operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: "3600" }] }),
      operator("Projection", "projection", { attributes: [{ originalAttribute: "species" }] }),
    ],
    [link("scan", "filter"), link("filter", "projection")]
  );

  it("names a column that an operator asks for and its input does not have, also inside a list of rows", () => {
    const arriving = { filter: [[species]], projection: [[species]] };

    expect(columnProblems(content, schemas, arriving)).toEqual({ filter: 'The input has no column "mass".' });
  });

  it("finds nothing wrong while the columns of an input are not known", () => {
    expect(columnProblems(content, schemas, {})).toEqual({});
    expect(columnProblems(content, schemas, { filter: [undefined] })).toEqual({});
  });

  it("does not check a disabled operator", () => {
    const disabled = {
      ...content,
      operators: content.operators.map(each => ({ ...each, isDisabled: each.operatorID === "filter" })),
    };

    expect(columnProblems(disabled, schemas, { filter: [[species]] })).toEqual({});
  });
});
