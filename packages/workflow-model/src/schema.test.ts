import { describe, expect, it } from "vitest";
import { fieldKind, isHidden, newItem, orderedProperties, resolve, setValue } from "./schema";
import type { JsonSchema } from "./types";

// Shapes taken from real operator schemas (Aggregate, Split, FileScan, BubbleChart, PythonUDFV2).
const root: JsonSchema = {
  properties: {
    dummyPropertyList: { propertyOrder: 1, type: "array", items: { $ref: "#/definitions/DummyProperties" } },
    aggregations: { propertyOrder: 6, type: "array", items: { $ref: "#/definitions/AggregationOperation" } },
    groupByKeys: { propertyOrder: 7, type: "array", items: { type: "string" }, autofill: "attributeNameList" },
    code: { propertyOrder: 4, type: "string", description: "Input your code here" },
    random: { propertyOrder: 2, type: "boolean", default: true },
    seed: { propertyOrder: 3, type: "integer", hideTarget: "random", hideType: "equals", hideExpectedValue: "true" },
    attributeType: { type: "string", enum: ["single string", "binary", "lines"] },
    fileScanLimit: {
      type: "integer",
      hideTarget: "attributeType",
      hideType: "regex",
      hideExpectedValue: "^binary$|^single string$",
    },
    enableColor: { type: "boolean", toggleHidden: ["colorCategory"] },
    colorCategory: { type: "string", autofill: "attributeName", autofillAttributeOnPort: 0 },
    fileName: { type: "string" },
    delimiter: { type: "string", widget: { formlyConfig: { type: "textarea" } } },
  },
  definitions: {
    DummyProperties: { type: "object", properties: { dummyProperty: { type: "string" } } },
    AggregationOperation: {
      type: "object",
      properties: {
        aggFunction: { type: "string", enum: ["sum", "count"], default: "sum" },
        attribute: { type: "string", autofill: "attributeName", autofillAttributeOnPort: 0 },
        "result attribute": { type: "string" },
      },
    },
    SortCriteriaUnit: {
      type: "object",
      required: ["attribute", "sortPreference"],
      properties: {
        attribute: { type: "string", autofill: "attributeName" },
        sortPreference: { type: "string", enum: ["ASC", "DESC"] },
      },
    },
  },
};
const props = root.properties as Record<string, JsonSchema>;
const p = (key: string) => props[key] as JsonSchema;

describe("property schema", () => {
  it("picks the control for each field", () => {
    expect(fieldKind("aggregations", p("aggregations"), root)).toBe("objectList");
    expect(fieldKind("groupByKeys", p("groupByKeys"), root)).toBe("attributeList");
    expect(fieldKind("colorCategory", p("colorCategory"), root)).toBe("attribute");
    expect(fieldKind("code", p("code"), root)).toBe("code");
    expect(fieldKind("fileName", p("fileName"), root)).toBe("file");
    expect(fieldKind("attributeType", p("attributeType"), root)).toBe("enum");
    expect(fieldKind("random", p("random"), root)).toBe("boolean");
    expect(fieldKind("seed", p("seed"), root)).toBe("integer");
    expect(fieldKind("delimiter", p("delimiter"), root)).toBe("textarea");
  });

  it("orders fields by propertyOrder and drops the internal dummy list", () => {
    expect(
      orderedProperties(root)
        .map(([k]) => k)
        .slice(0, 5)
    ).toEqual(["random", "seed", "code", "aggregations", "groupByKeys"]);
  });

  it("applies hide rules: equals, whole-string regex, and toggles", () => {
    const hidden = (key: string, values: Record<string, unknown>) => isHidden(key, p(key), root, values, props);
    expect(hidden("seed", { random: true })).toBe(true);
    expect(hidden("seed", { random: false })).toBe(false);
    expect(hidden("fileScanLimit", { attributeType: "binary" })).toBe(true);
    expect(hidden("fileScanLimit", { attributeType: "lines" })).toBe(false);
    expect(hidden("colorCategory", { enableColor: false })).toBe(true);
    expect(hidden("colorCategory", { enableColor: true })).toBe(false);
  });

  it("resolves $refs and builds new list items from their defaults", () => {
    expect(resolve({ $ref: "#/definitions/AggregationOperation" }, root).properties?.aggFunction?.enum).toEqual([
      "sum",
      "count",
    ]);
    expect(newItem({ $ref: "#/definitions/AggregationOperation" }, root)).toEqual({ aggFunction: "sum" });
    expect(newItem({ $ref: "#/definitions/SortCriteriaUnit" }, root)).toEqual({ sortPreference: "ASC" });
  });

  it("removes optional fields left empty instead of saving empty strings", () => {
    expect(setValue({ a: "x", b: 1 }, "a", "", false)).toEqual({ b: 1 });
    expect(setValue({ a: "x" }, "a", "", true)).toEqual({ a: "" });
    expect(setValue({}, "n", 0, false)).toEqual({ n: 0 });
  });
});

describe("credential fields", () => {
  it("renders a property marked format: credential with the credential picker", () => {
    expect(fieldKind("apiKey", { type: "string", format: "credential" }, {})).toBe("credential");
    expect(fieldKind("apiKey", { type: "string" }, {})).toBe("text");
  });
});
