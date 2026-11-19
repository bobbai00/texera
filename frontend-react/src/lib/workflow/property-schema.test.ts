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
import {
  columnChoices,
  columnTypeWarnings,
  delimiterMode,
  extraChoice,
  fieldKind,
  fieldLabel,
  missingColumn,
  resolve,
  visibleFields,
} from "./property-schema";

const filter = schemaOf("Filter").jsonSchema;
const predicate = resolve(filter.properties!.predicates.items!, filter);
const keys = (fields: { key: string }[]) => fields.map(field => field.key);

describe("visibleFields", () => {
  it("lists an operator's properties in the backend's order, without the ones that are not for people", () => {
    const scan = schemaOf("CSVFileScan").jsonSchema;

    const fields = visibleFields(scan, scan, {});

    expect(keys(fields)).toEqual(["fileName", "fileEncoding", "limit", "offset", "customDelimiter", "hasHeader"]);
    expect(fields[0]).toMatchObject({ key: "fileName", required: true });
    expect(fields[2]).toMatchObject({ key: "limit", required: false });
    expect(fieldLabel(fields[0])).toBe("File");
  });

  it("hides a field while a sibling has one of the values that make it pointless", () => {
    expect(keys(visibleFields(predicate, filter, { condition: ">" }))).toEqual(["attribute", "condition", "value"]);
    expect(keys(visibleFields(predicate, filter, { condition: "is null" }))).toEqual(["attribute", "condition"]);
    expect(keys(visibleFields(predicate, filter, { condition: "is not null" }))).toEqual(["attribute", "condition"]);
  });

  it("shows a field whose rule is about a sibling that has no value yet, unless the rule says otherwise", () => {
    expect(keys(visibleFields(predicate, filter, {}))).toContain("value");

    const schema = {
      properties: {
        kind: { type: "string" },
        detail: { type: "string", hideTarget: "kind", hideType: "equals", hideExpectedValue: "none", hideOnNull: true },
      },
    };
    expect(keys(visibleFields(schema, schema, {}))).toEqual(["kind"]);
    expect(keys(visibleFields(schema, schema, { kind: "none" }))).toEqual(["kind"]);
    expect(keys(visibleFields(schema, schema, { kind: "some" }))).toEqual(["kind", "detail"]);
  });

  it("hides the fields that a switch names while the switch is off", () => {
    const schema = { properties: { custom: { type: "boolean", toggleHidden: ["query"] }, query: { type: "string" } } };

    expect(keys(visibleFields(schema, schema, { custom: false }))).toEqual(["custom"]);
    expect(keys(visibleFields(schema, schema, { custom: true }))).toEqual(["custom", "query"]);
  });
});

describe("resolve", () => {
  it("follows a reference into the schema's definitions", () => {
    expect(Object.keys(predicate.properties!)).toEqual(["attribute", "condition", "value"]);
    expect(resolve({ type: "string" }, filter)).toEqual({ type: "string" });
  });
});

describe("fieldKind", () => {
  it.each([
    [schemaOf("Limit").jsonSchema.properties!.limit, "number"],
    [schemaOf("CSVFileScan").jsonSchema.properties!.fileName, "text"],
    [schemaOf("CSVFileScan").jsonSchema.properties!.fileEncoding, "choice"],
    [schemaOf("CSVFileScan").jsonSchema.properties!.hasHeader, "switch"],
    [predicate.properties!.attribute, "column"],
    [filter.properties!.predicates, "rows"],
    [schemaOf("Aggregate").jsonSchema.properties!.groupByKeys, "columns"],
    [{ type: "string", widget: { formlyConfig: { type: "textarea" } } }, "longText"],
    [{ type: "string", widget: { formlyConfig: { templateOptions: { type: "password" } } } }, "password"],
    [{ type: "array", items: { enum: ["a", "b"] } }, "choices"],
    [{ type: "array", items: { type: "string" } }, "texts"],
    [{ type: "object", properties: {} }, "group"],
    [{}, "unknown"],
  ])("edits %j with a %s control", (schema, kind) => {
    expect(fieldKind({ key: "any", schema })).toBe(kind);
  });

  it("knows by its name a property that its schema does not tell apart from any other text", () => {
    expect(fieldKind({ key: "fileName", schema: { type: "string" } })).toBe("datasetFile");
    expect(fieldKind({ key: "datasetVersionPath", schema: { type: "string" } })).toBe("datasetVersion");
    expect(fieldKind({ key: "fileName", schema: { type: "boolean" } })).toBe("switch");
  });
});

describe("columnChoices", () => {
  const left = [{ attributeName: "species", attributeType: "string" }];
  const right = [{ attributeName: "island", attributeType: "string" }];

  it("offers the columns of the input port that the field is about", () => {
    const join = schemaOf("HashJoin").jsonSchema.properties!;

    expect(columnChoices(join.buildAttributeName, [left, right])).toBe(left);
    expect(columnChoices(join.probeAttributeName, [left, right])).toBe(right);
  });

  it("has nothing to offer while the input's columns are unknown", () => {
    expect(columnChoices(predicate.properties!.attribute, [])).toBeUndefined();
  });
});

describe("what a schema says in Texera's own keywords", () => {
  const aggregation = resolve({ $ref: "#/definitions/AggregationOperation" }, schemaOf("Aggregate").jsonSchema);
  const required = (values: Record<string, unknown>) =>
    visibleFields(aggregation, schemaOf("Aggregate").jsonSchema, values)
      .filter(field => field.required)
      .map(field => field.key);

  it("needs a property only while another has the value that calls for it", () => {
    expect(required({ aggFunction: "count" })).toEqual(["aggFunction", "result attribute"]);
    expect(required({ aggFunction: "sum" })).toEqual(["aggFunction", "attribute", "result attribute"]);
  });

  it("asks for a UDF's own Python environment only when it does not use the default one", () => {
    const udf = schemaOf("PythonUDFV2").jsonSchema;
    const keys = (values: Record<string, unknown>) => visibleFields(udf, udf, values).map(field => field.key);

    expect(keys({ defaultEnv: true })).not.toContain("envName");
    expect(keys({ defaultEnv: false })).toContain("envName");
  });

  it("tells a delimiter from other text, and whether it is a character or an expression", () => {
    const delimiter = (mode: string) => ({
      type: "string",
      widget: { formlyConfig: { type: "delimiter", props: { delimiterMode: mode } } },
    });

    expect(fieldKind({ key: "customDelimiter", schema: delimiter("char") })).toBe("delimiter");
    expect(delimiterMode(delimiter("char"))).toBe("char");
    expect(delimiterMode(delimiter("regex"))).toBe("regex");
  });

  it("takes the one more choice a column field offers as no missing column", () => {
    const schema = {
      properties: { name: { type: "string", autofill: "attributeName", additionalEnumValue: "Add New Column" } },
    };
    const input = [[{ attributeName: "species", attributeType: "string" }]];

    expect(extraChoice(schema.properties.name)).toBe("Add New Column");
    expect(missingColumn(schema, schema, { name: "Add New Column" }, input)).toBeUndefined();
    expect(missingColumn(schema, schema, { name: "island" }, input)).toBe("island");
  });
});

describe("columnTypeWarnings", () => {
  const species = { attributeName: "species", attributeType: "string" };
  const mass = { attributeName: "mass", attributeType: "integer" };
  const year = { attributeName: "year", attributeType: "long" };

  it("warns when a column is not of one of the types a property expects", () => {
    const chart = schemaOf("BarChart").jsonSchema;

    expect(columnTypeWarnings(chart, { value: "species" }, [[species, mass]])).toEqual({
      value: 'The type of "species" is string, but integer, long or double is expected.',
    });
    expect(columnTypeWarnings(chart, { value: "mass" }, [[species, mass]])).toEqual({});
  });

  it("warns when two columns that are compared are not of one type, each looked up on its own input", () => {
    const join = schemaOf("HashJoin").jsonSchema;
    const values = { buildAttributeName: "mass", probeAttributeName: "year" };

    expect(columnTypeWarnings(join, values, [[mass], [year]])).toEqual({
      buildAttributeName: 'The type of "mass" is integer, but "year" is long: the two are expected to be the same.',
    });
    expect(columnTypeWarnings(join, values, [[mass], [{ ...year, attributeType: "integer" }]])).toEqual({});
  });

  it("warns by what another property is set to, and only then", () => {
    const aggregation = resolve({ $ref: "#/definitions/AggregationOperation" }, schemaOf("Aggregate").jsonSchema);

    expect(columnTypeWarnings(aggregation, { aggFunction: "sum", attribute: "species" }, [[species, mass]])).toEqual({
      attribute:
        'The type of "species" is string, but integer, long, double or timestamp is expected while Aggregate Func is sum.',
    });
    expect(columnTypeWarnings(aggregation, { aggFunction: "count", attribute: "species" }, [[species]])).toEqual({});
  });

  it("says nothing about a column whose type is not known", () => {
    expect(columnTypeWarnings(schemaOf("BarChart").jsonSchema, { value: "species" }, [])).toEqual({});
    expect(columnTypeWarnings(schemaOf("BarChart").jsonSchema, { value: "gone" }, [[species]])).toEqual({});
  });
});
