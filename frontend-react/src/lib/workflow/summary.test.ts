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
import { operator, schemaOf } from "@/testing/workflow";
import type { JsonSchema, OperatorSchema } from "./operator-schema";
import { type PropertyField, resolve } from "./property-schema";
import { changeTexts, type SettingLine, settingLines, summaryLine, valueText } from "./summary";

/** The settings of an operator of a type the test fixture has, given these values beside its defaults. */
const linesOf = (operatorType: string, properties: Record<string, unknown> = {}) =>
  settingLines(operator(operatorType, operatorType.toLowerCase(), properties), schemaOf(operatorType));

/** The settings of an operator of a type of these properties alone, which the test fixture does not have. */
function linesOfType(properties: Record<string, JsonSchema>, values: Record<string, unknown>): SettingLine[] {
  const schema: OperatorSchema = { ...schemaOf("Limit"), operatorType: "Custom", jsonSchema: { properties } };
  return settingLines({ ...operator("Limit", "custom"), operatorType: "Custom", operatorProperties: values }, schema);
}

const parameter = (attributeName: string, attributeType: string, value: string, inputType?: string) => ({
  attribute: { attributeName, attributeType },
  value,
  ...(inputType !== undefined && { inputType }),
});

/** A property of an operator type of the test fixture, as a field of its form, and the schema it is read in. */
function fieldOf(operatorType: string, key: string): [Pick<PropertyField, "key" | "schema">, JsonSchema] {
  const root = schemaOf(operatorType).jsonSchema;
  return [{ key, schema: resolve(root.properties?.[key] ?? {}, root) }, root];
}

const delimiter = { key: "delimiter", schema: { type: "string", widget: { formlyConfig: { type: "delimiter" } } } };
const password = {
  key: "password",
  schema: { type: "string", widget: { formlyConfig: { templateOptions: { type: "password" } } } },
};

describe("settingLines", () => {
  it("says each setting that was set, in the order of the form, under the name the form gives it", () => {
    expect(
      linesOf("Aggregate", {
        groupByKeys: ["noc", "year"],
        aggregations: [{ aggFunction: "count", "result attribute": "gold_medals" }],
      })
    ).toEqual([
      { key: "aggregations", label: "Aggregations", value: "count gold_medals", short: "count gold_medals" },
      { key: "groupByKeys", label: "Group By Keys", value: "noc, year", short: "noc, year" },
    ]);
  });

  it("names a dataset's file by its name, and leaves out what is left at its default", () => {
    expect(linesOf("CSVFileScan", { fileName: "/dataset/texera/penguins/v2 - by island/islands/biscoe.csv" })).toEqual([
      { key: "fileName", label: "File", value: "biscoe.csv", short: "biscoe.csv" },
    ]);
  });

  // By the kind of setting that holds the path: a file by its name, and a version as a whole by its resource's name
  // and its own, whatever follows it; what names no file where a file is read, or no version, by its last part.
  it.each<[string, string, string]>([
    ["fileName", "/model/texera/resnet/v3/labels.csv", "labels.csv"],
    ["fileName", "/texera/penguins/v1/adelie.csv", "adelie.csv"],
    ["fileName", "penguins.csv", "penguins.csv"],
    ["fileName", "https://example.com/data/penguins.csv", "penguins.csv"],
    ["fileName", "/home/user/data.csv", "data.csv"],
    ["fileName", "C:/data/penguins.csv", "penguins.csv"],
    ["fileName", "/dataset/texera/penguins/v1", "v1"],
    ["datasetVersionPath", "/dataset/texera/penguins/v2 - by island", "penguins v2 - by island"],
    ["datasetVersionPath", "/texera/penguins/v1", "penguins v1"],
    ["datasetVersionPath", "/dataset/texera/penguins/v1/adelie.csv", "penguins v1"],
    ["datasetVersionPath", "penguins", "penguins"],
  ])("reads %s %j as %j", (key, value, words) => {
    expect(linesOfType({ [key]: { type: "string", title: "Path" } }, { [key]: value })[0]?.value).toBe(words);
  });

  it("says a number and a switch with their names, so that a bare 15 or no is never shown alone", () => {
    const lines = linesOf("CSVFileScan", { limit: 15, hasHeader: false });

    expect(lines.map(line => line.short)).toEqual(["Limit 15", "no Header"]);
    expect(lines.map(line => line.value)).toEqual(["15", "no"]);
    expect(linesOf("Projection", { isDrop: true })).toEqual([
      { key: "isDrop", label: "Drop Option", value: "yes", short: "Drop Option" },
    ]);
  });

  it("leaves out what is not set, what is the default, a switch that is off, and what is not for people", () => {
    expect(
      linesOf("CSVFileScan", { fileName: "", limit: undefined, offset: null, dummyPropertyList: [{ dummyValue: "a" }] })
    ).toEqual([]);
    expect(linesOf("Filter", { predicates: [] })).toEqual([]);
    expect(linesOf("KeywordSearch", { isCaseSensitive: false })).toEqual([]);
    expect(linesOfType({ strict: { type: "boolean", title: "Strict" } }, { strict: false })).toEqual([]);
  });

  it("leaves out what the form hides for the values beside it", () => {
    expect(linesOf("Split", { random: true, seed: 7 })).toEqual([]);
    expect(linesOf("Split", { random: false, seed: 7 }).map(line => line.short)).toEqual([
      "no Auto-Generate Seed",
      "Seed 7",
    ]);
  });

  it("reads a list of conditions as a person writes them, without a value that a condition does not take", () => {
    const [predicates] = linesOf("Filter", {
      predicates: [
        { attribute: "medal", condition: "=", value: "Gold" },
        { attribute: "year", condition: ">", value: "2006" },
        { attribute: "noc", condition: "is null", value: "left over" },
      ],
    });

    expect(predicates.value).toBe("medal = Gold, year > 2006, noc is null");
  });

  it("says the code of an operator that holds code as code in its language, never the code itself", () => {
    expect(linesOf("PythonUDFV2", { code: "yield tuple_" })).toEqual([
      { key: "code", label: "Python script", value: "Python code", short: "Python code" },
    ]);
  });

  it("says nothing of code that is left as the template the operator came with, or of no code", () => {
    expect(linesOf("PythonUDFV2")).toEqual([]);
    expect(linesOf("PythonUDFV2", { code: "" })).toEqual([]);
  });

  it("says a UDF's parameters by their names and values, and a version by its resource's name and its own", () => {
    const parameters = linesOf("PythonUDFV2", {
      uiParameters: [
        parameter("count", "integer", "5"),
        parameter("weights", "string", "/model/texera/resnet/v3", "model"),
        parameter("note", "string", "/a/b/c", ""),
        // An input type that names no kind of resource takes no version: its value is text as any other.
        parameter("key", "string", "/a/b/v1", "credential"),
        parameter("label", "string", ""),
        "not a parameter",
      ],
    }).find(line => line.key === "uiParameters");

    expect(parameters).toEqual({
      key: "uiParameters",
      label: "Parameters",
      value: "count 5, weights resnet v3, note /a/b/c, key /a/b/v1",
      short: "count 5, weights resnet v3, note /a/b/c, key /a/b/v1",
    });
  });

  it("never shows a password, and names a delimiter that cannot be read as it is", () => {
    const delimiter = { type: "string", title: "Delimiter", widget: { formlyConfig: { type: "delimiter" } } };
    const password = {
      type: "string",
      title: "Password",
      widget: { formlyConfig: { templateOptions: { type: "password" } } },
    };

    expect(
      linesOfType(
        { user: { type: "string", title: "User" }, password, delimiter },
        {
          user: "ada",
          password: "secret",
          delimiter: "\t",
        }
      )
    ).toEqual([
      { key: "user", label: "User", value: "ada", short: "ada" },
      { key: "delimiter", label: "Delimiter", value: "Tab", short: "Tab" },
    ]);
    expect(linesOfType({ delimiter }, { delimiter: "#" })[0]?.value).toBe("#");
  });

  it("shortens a long value", () => {
    const [keyword] = linesOf("KeywordSearch", { keyword: "penguin ".repeat(10) });

    expect(keyword.value).toBe(`${"penguin ".repeat(10).slice(0, 59)}…`);
    expect(keyword.short).toBe(keyword.value);
  });
});

describe("summaryLine", () => {
  it("is the first two settings side by side, for a card that has one line for them", () => {
    const lines = linesOf("Aggregate", {
      groupByKeys: ["noc"],
      aggregations: [{ aggFunction: "count", "result attribute": "gold_medals" }],
    });

    expect(summaryLine(lines)).toBe("count gold_medals · noc");
    expect(summaryLine([...lines, { key: "more", label: "More", value: "more", short: "more" }])).toBe(
      "count gold_medals · noc"
    );
    expect(summaryLine([])).toBe("");
  });
});

describe("valueText", () => {
  it.each<[unknown, string]>([
    ["Gold", "Gold"],
    [15, "15"],
    [0, "0"],
    [true, "yes"],
    [false, "no"],
    [["noc", "year"], "noc, year"],
    [[{ attribute: "mass", condition: ">", value: "3600" }], "mass > 3600"],
    [{ attributeName: "score", attributeType: "double" }, "score double"],
    [`${"a".repeat(80)}`, `${"a".repeat(59)}…`],
  ])("reads %j in a short line as %s", (value, text) => {
    expect(valueText(value)).toBe(text);
  });

  it.each<[unknown]>([[undefined], [null], [""], [[]], [[{}, ""]], [{ alias: null }]])(
    "says that %j is not set",
    value => {
      expect(valueText(value)).toBe("not set");
    }
  );

  it("reads a value as its card says it, where its field is given", () => {
    expect(valueText("\t", delimiter)).toBe("Tab");
    expect(valueText("/dataset/texera/penguins/v1/adelie.csv", ...fieldOf("CSVFileScan", "fileName"))).toBe(
      "adelie.csv"
    );
    expect(
      valueText([{ attribute: "noc", condition: "is null", value: "left over" }], ...fieldOf("Filter", "predicates"))
    ).toBe("noc is null");
  });

  it("never shows a password, only whether one is set", () => {
    expect(valueText("secret", password)).toBe("set");
    expect(valueText("", password)).toBe("not set");
    expect(valueText(undefined, password)).toBe("not set");
  });
});

describe("changeTexts", () => {
  it("reads a value before and after it changed as valueText reads each", () => {
    expect(changeTexts(",", "\t", delimiter)).toEqual(["Comma ( , )", "Tab"]);
    expect(changeTexts(undefined, true)).toEqual(["not set", "yes"]);
  });

  it.each<[string, unknown, unknown, [string, string]]>([
    ["an empty list and a list of one empty row", [], [{}], ["[]", "[{}]"]],
    ["no value and an empty list", undefined, [], ["not set", "[]"]],
    ["an empty list and a list of one empty text", [], [""], ["[]", '[""]']],
    [
      "a group with nothing in it, and one with an empty text",
      { alias: null },
      { alias: "" },
      ['{"alias":null}', '{"alias":""}'],
    ],
  ])("tells apart %s, which read alike, as JSON writes them", (_, before, after, texts) => {
    expect(changeTexts(before, after)).toEqual(texts);
  });

  it("tells apart the files of one name in two versions, and the rows of a list that read alike", () => {
    expect(
      changeTexts(
        "/dataset/texera/penguins/v1/adelie.csv",
        "/dataset/texera/penguins/v2/adelie.csv",
        ...fieldOf("CSVFileScan", "fileName")
      )
    ).toEqual(['"/dataset/texera/penguins/v1/adelie.csv"', '"/dataset/texera/penguins/v2/adelie.csv"']);
    expect(changeTexts([], [{}], ...fieldOf("Filter", "predicates"))).toEqual(["[]", "[{}]"]);
  });

  it("never shows a password, though two read alike", () => {
    expect(changeTexts("old secret", "new secret", password)).toEqual(["set", "set"]);
    expect(changeTexts(undefined, "secret", password)).toEqual(["not set", "set"]);
  });
});
