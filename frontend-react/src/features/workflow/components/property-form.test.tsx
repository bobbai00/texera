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

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { schemaOf } from "@/testing/workflow";
import { PropertyForm, type PropertyFormProps } from "./property-form";

const penguinColumns = [
  { attributeName: "species", attributeType: "string" },
  { attributeName: "mass", attributeType: "integer" },
];

/** Shows the form of an operator type, holding its values as an editor does, and reports them after every change. */
function renderForm(operatorType: string, initial: Record<string, unknown>, props: Partial<PropertyFormProps> = {}) {
  const onChange = vi.fn();
  function Form() {
    const [values, setValues] = useState(initial);
    return (
      <PropertyForm
        schema={schemaOf(operatorType).jsonSchema}
        values={values}
        inputSchemas={[penguinColumns]}
        onChange={(key, value) => {
          // As the document does it: one property is set, or cleared.
          const changed = { ...values, [key]: value };
          if (value === undefined) delete changed[key];
          setValues(changed);
          onChange(changed);
        }}
        {...props}
      />
    );
  }
  return { user: userEvent.setup(), onChange, ...render(<Form />) };
}

/** Shows the form of a schema written for the test, for what no operator type of the fixture has. */
function renderSchema(properties: Record<string, object>, initial: Record<string, unknown>) {
  const onChange = vi.fn();
  function Form() {
    const [values, setValues] = useState(initial);
    return (
      <PropertyForm
        schema={{ type: "object", properties } as PropertyFormProps["schema"]}
        values={values}
        inputSchemas={[penguinColumns]}
        onChange={(key, value) => {
          setValues({ ...values, [key]: value });
          onChange(key, value);
        }}
      />
    );
  }
  return { user: userEvent.setup(), onChange, ...render(<Form />) };
}

describe("PropertyForm", () => {
  it("shows a field for each property, in the backend's order, marking the ones an operator needs", () => {
    renderForm("CSVFileScan", { fileEncoding: "UTF_8", hasHeader: true });

    expect(screen.getByLabelText("File *")).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "File Encoding *" })).toHaveTextContent("UTF_8");
    expect(screen.getByLabelText("Limit")).toHaveValue(null);
    expect(screen.getByRole("checkbox", { name: "Header *" })).toBeChecked();
    expect(screen.queryByText("Dummy Property List")).not.toBeInTheDocument();
  });

  it("leaves out a property that is edited somewhere else", () => {
    renderForm("PythonUDFV2", { code: "yield tuple_", workers: 1 }, { omit: ["code"] });

    expect(screen.queryByLabelText("Python script *")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Worker count *")).toHaveValue(1);
  });

  it("reports text, numbers and switches as the values they are, and leaves out what is cleared", async () => {
    const { user, onChange } = renderForm("CSVFileScan", { fileName: "a", limit: 5, hasHeader: true });

    await user.type(screen.getByLabelText("File *"), "b");
    expect(onChange).toHaveBeenLastCalledWith({ fileName: "ab", limit: 5, hasHeader: true });

    await user.clear(screen.getByLabelText("Limit"));
    expect(onChange).toHaveBeenLastCalledWith({ fileName: "ab", hasHeader: true });

    await user.click(screen.getByRole("checkbox", { name: "Header *" }));
    expect(onChange).toHaveBeenLastCalledWith({ fileName: "ab", hasHeader: false });

    // A property the operator needs stays, as empty text, when its field is emptied.
    await user.clear(screen.getByLabelText("File *"));
    expect(onChange).toHaveBeenLastCalledWith({ fileName: "", hasHeader: false });
  });

  it("edits a list of rows: adds one, fills it from the input's columns, and removes it", async () => {
    const { user, onChange } = renderForm("Filter", { predicates: [] });

    await user.click(screen.getByRole("button", { name: "Add" }));
    const row = within(screen.getByRole("list", { name: "Predicates *" })).getByRole("listitem");
    await user.click(within(row).getByRole("combobox", { name: "Attribute *" }));
    await user.click(await screen.findByRole("option", { name: "mass" }));
    expect(onChange).toHaveBeenLastCalledWith({ predicates: [{ attribute: "mass" }] });

    await user.click(screen.getByRole("button", { name: "Remove row 1 of Predicates *" }));
    expect(onChange).toHaveBeenLastCalledWith({ predicates: [] });
  });

  it("hides a field of a row while another field of that row makes it pointless", async () => {
    const { user } = renderForm("Filter", {
      predicates: [
        { attribute: "mass", condition: ">", value: "3600" },
        { attribute: "species", condition: "=", value: "Adelie" },
      ],
    });
    const [first, second] = within(screen.getByRole("list", { name: "Predicates *" })).getAllByRole("listitem");

    await user.click(within(first).getByRole("combobox", { name: "Condition *" }));
    await user.click(await screen.findByRole("option", { name: "is null" }));

    expect(within(first).queryByLabelText("Value")).not.toBeInTheDocument();
    expect(within(second).getByLabelText("Value")).toHaveValue("Adelie");
  });

  it("takes a column's name as text while the input's columns are unknown", () => {
    renderForm("KeywordSearch", { attribute: "bill", keyword: "x", isCaseSensitive: false }, { inputSchemas: [] });
    expect(screen.getByLabelText("attribute *")).toHaveValue("bill");
  });

  it("lets several columns be ticked", async () => {
    const { user, onChange } = renderForm("Aggregate", { aggregations: [], groupByKeys: ["species"] });

    await user.click(screen.getByRole("checkbox", { name: "mass" }));
    expect(onChange).toHaveBeenLastCalledWith({ aggregations: [], groupByKeys: ["species", "mass"] });
  });

  it("changes nothing when it is disabled", () => {
    renderForm("CSVFileScan", { fileName: "a", hasHeader: true }, { disabled: true });

    expect(screen.getByLabelText("File *")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Header *" })).toBeDisabled();
  });

  it("warns about a column of a type the operator does not expect, without refusing it", async () => {
    const { user } = renderForm("BarChart", { value: "species", fields: "species" });

    expect(screen.getByRole("note")).toHaveTextContent(
      'The type of "species" is string, but integer, long or double is expected.'
    );

    await user.click(screen.getByRole("combobox", { name: /^Value Column/ }));
    await user.click(await screen.findByRole("option", { name: "mass" }));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("offers the usual delimiters by name, and takes another that is typed", async () => {
    const delimiter = { type: "string", title: "Delimiter", widget: { formlyConfig: { type: "delimiter" } } };
    const { user, onChange } = renderSchema({ customDelimiter: delimiter }, { customDelimiter: "," });
    const choice = screen.getByRole("combobox", { name: "Delimiter" });
    expect(choice).toHaveTextContent("Comma ( , )");

    await user.click(choice);
    await user.click(await screen.findByRole("option", { name: "Tab" }));
    expect(onChange).toHaveBeenLastCalledWith("customDelimiter", "\t");

    await user.click(choice);
    await user.click(await screen.findByRole("option", { name: "Another character…" }));
    const typed = screen.getByRole("textbox", { name: "Delimiter, typed" });
    await user.clear(typed);
    await user.type(typed, "##");
    expect(onChange).toHaveBeenLastCalledWith("customDelimiter", "##");
    expect(screen.getByRole("alert")).toHaveTextContent("A delimiter here is a single character.");
  });

  it("edits a list of texts one by one", async () => {
    const corners = { type: "array", title: "Corners", items: { type: "string" } };
    const { user, onChange } = renderSchema({ corners }, { corners: ["0,0"] });

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox", { name: "Corners, 2" }), "9");
    expect(onChange).toHaveBeenLastCalledWith("corners", ["0,0", "9"]);

    await user.click(screen.getByRole("button", { name: "Remove 1 of Corners" }));
    expect(onChange).toHaveBeenLastCalledWith("corners", ["9"]);
  });

  it("edits a dataset's file with the control it is given for it, and as text without one", async () => {
    const picked = "/dataset/texera/penguins/v1/adelie.csv";
    const { user, onChange, unmount } = renderForm(
      "CSVFileScan",
      { fileName: "" },
      {
        controls: {
          datasetFile: ({ id, value, onChange: pick }) => (
            <button
              id={id}
              onClick={() => pick(picked)}>
              {value || "Pick a file"}
            </button>
          ),
        },
      }
    );

    await user.click(screen.getByRole("button", { name: "File *" }));
    expect(onChange).toHaveBeenLastCalledWith({ fileName: picked });
    unmount();

    renderForm("CSVFileScan", { fileName: picked });
    expect(screen.getByRole("textbox", { name: "File *" })).toHaveValue(picked);
  });
});
