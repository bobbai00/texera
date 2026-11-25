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

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { diffContent } from "@/lib/workflow/diff";
import type { Operator } from "@/lib/workflow/model";
import type { OperatorSchema } from "@/lib/workflow/operator-schema";
import { renderWithProviders } from "@/testing/render";
import { link, operator, schemaOf, workflowContent } from "@/testing/workflow";
import { VersionChanges } from "./version-changes";

const heavier = (mass: string) => ({ predicates: [{ attribute: "mass", condition: ">", value: mass }] });

const csvScan = schemaOf("CSVFileScan");

/**
 * The CSV scan of the test fixture as the backend describes it now, with a delimiter that is picked by name, and a
 * password beside its settings, as the sources that read a database have.
 */
const scanSchema: OperatorSchema = {
  ...csvScan,
  jsonSchema: {
    ...csvScan.jsonSchema,
    properties: {
      ...csvScan.jsonSchema.properties,
      customDelimiter: {
        ...csvScan.jsonSchema.properties?.customDelimiter,
        widget: { formlyConfig: { type: "delimiter" } },
      },
      password: {
        type: "string",
        title: "Password",
        widget: { formlyConfig: { templateOptions: { type: "password" } } },
      },
    },
  },
};

/** A type whose setting is a group, which the definition it refers to gives its title. */
const windowed: OperatorSchema = {
  ...schemaOf("Limit"),
  operatorType: "Windowed",
  jsonSchema: {
    properties: { window: { $ref: "#/definitions/Window" } },
    definitions: { Window: { type: "object", title: "Time window", properties: { size: { type: "integer" } } } },
  },
};

/** What the changes from one state of an operator to another say about it. */
function changedFrom(before: Operator, after: Operator, schemas: OperatorSchema[]) {
  const { container } = renderWithProviders(
    <VersionChanges
      diff={diffContent(workflowContent([before]), workflowContent([after]))}
      schemas={new Map(schemas.map(schema => [schema.operatorType, schema]))}
      onShow={() => {}}
    />
  );
  return within(container).getByRole("region", { name: "Changed" });
}

describe("VersionChanges", () => {
  it("names each operator as its card does: by the name it was given, or else by its type's", () => {
    const unnamed = (each: Operator) => ({ ...each, customDisplayName: undefined });
    const scan = unnamed(operator("CSVFileScan", "scan"));
    const filter = unnamed(operator("Filter", "filter", heavier("3600")));
    renderWithProviders(
      <VersionChanges
        diff={diffContent(
          workflowContent([filter]),
          workflowContent([scan, unnamed(operator("Filter", "filter", heavier("4000")))], [link("scan", "filter")])
        )}
        schemas={new Map([schemaOf("CSVFileScan"), schemaOf("Filter")].map(schema => [schema.operatorType, schema]))}
        onShow={() => {}}
      />
    );

    expect(screen.getByRole("region", { name: "Added" })).toHaveTextContent(/^AddedCSV File Scan$/);
    expect(screen.getByRole("region", { name: "Changed" })).toHaveTextContent(/^ChangedFilter/);
    expect(screen.getByRole("region", { name: "Links" })).toHaveTextContent("Linked CSV File Scan → Filter");
  });

  it("says how each value changed in the words a card says it in, and what was not set before", () => {
    const changed = changedFrom(
      operator("Filter", "filter", heavier("3600")),
      { ...operator("Filter", "filter", heavier("4000")), viewResult: true },
      [schemaOf("Filter")]
    );

    expect(changed).toHaveTextContent("Result kept: not set → yes");
    expect(changed).toHaveTextContent("Predicates: mass > 3600 → mass > 4000");
  });

  it("reads each setting as its field says: a delimiter by its name, a password as set, a file by its name", () => {
    const changed = changedFrom(
      operator("CSVFileScan", "scan", { fileName: "/dataset/texera/penguins/v1/adelie.csv" }),
      operator("CSVFileScan", "scan", {
        fileName: "/dataset/texera/penguins/v1/biscoe.csv",
        customDelimiter: "\t",
        password: "secret",
      }),
      [scanSchema]
    );

    expect(changed).toHaveTextContent("Delimiter: Comma ( , ) → Tab");
    expect(changed).toHaveTextContent("Password: not set → set");
    expect(changed).toHaveTextContent("File: adelie.csv → biscoe.csv");
    expect(changed).not.toHaveTextContent("secret");
  });

  it("tells apart two values that read alike, as an empty list and a list of one row that is not filled in yet", () => {
    const changed = changedFrom(
      operator("CSVFileScan", "scan", { fileName: "/dataset/texera/penguins/v1/adelie.csv", password: "old" }),
      operator("CSVFileScan", "scan", { fileName: "/dataset/texera/penguins/v2/adelie.csv", password: "new" }),
      [scanSchema]
    );
    const added = changedFrom(
      operator("Filter", "filter", { predicates: [] }),
      operator("Filter", "filter", {
        predicates: [{}],
      }),
      [schemaOf("Filter")]
    );

    expect(changed).toHaveTextContent(
      'File: "/dataset/texera/penguins/v1/adelie.csv" → "/dataset/texera/penguins/v2/adelie.csv"'
    );
    // A password is never shown, whatever it was.
    expect(changed).toHaveTextContent("Password: set → set");
    expect(added).toHaveTextContent("Predicates: [] → [{}]");
  });

  it("names a port by its name, and a setting as its form does", () => {
    const udf = operator("PythonUDFV2", "udf");
    const added = { portID: "input-1", displayName: "", disallowMultiInputs: false, isDynamicPort: true };
    const window = (size: number) => ({
      ...operator("Limit", "windowed"),
      operatorType: "Windowed",
      operatorProperties: {
        window: { size },
      },
    });

    expect(
      changedFrom(udf, { ...udf, inputPorts: [...udf.inputPorts, added] }, [schemaOf("PythonUDFV2")])
    ).toHaveTextContent("Input ports: input-0 → input-0, input-1");
    // Ports whose names stayed the same read as any change does.
    expect(
      changedFrom(udf, { ...udf, inputPorts: [{ ...udf.inputPorts[0], disallowMultiInputs: true }] }, [
        schemaOf("PythonUDFV2"),
      ])
    ).toHaveTextContent("Input ports: input-0 no no → input-0 yes no");
    expect(changedFrom(window(5), window(10), [windowed])).toHaveTextContent("Time window: 5 → 10");
  });
});
