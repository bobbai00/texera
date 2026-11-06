import { describe, expect, it } from "vitest";
import { describeProperties, summarize } from "./summary";
import type { JsonSchema } from "./types";

const scan: JsonSchema = {
  properties: {
    customDelimiter: { type: "string", title: "Delimiter", default: ",", propertyOrder: 8 },
    dummyPropertyList: { type: "array", title: "Dummy Property List", propertyOrder: 1 },
    fileEncoding: {
      type: "string",
      title: "File Encoding",
      default: "UTF_8",
      enum: ["UTF_8", "UTF_16"],
      propertyOrder: 5,
    },
    fileName: { type: "string", title: "File", propertyOrder: 4 },
    hasHeader: { type: "boolean", title: "Header", default: true, propertyOrder: 9 },
    limit: { type: "integer", title: "Limit", propertyOrder: 6 },
  },
};

const filter: JsonSchema = {
  properties: { predicates: { type: "array", title: "Predicates", items: { $ref: "#/definitions/FilterPredicate" } } },
  definitions: {
    FilterPredicate: {
      properties: {
        attribute: { type: "string", title: "Attribute" },
        condition: { type: "string", title: "Condition", enum: ["=", ">"] },
        value: { type: "string", title: "Value" },
      },
    },
  },
};

const aggregate: JsonSchema = {
  properties: {
    aggregations: {
      type: "array",
      title: "Aggregations",
      propertyOrder: 7,
      items: { $ref: "#/definitions/AggregationOperation" },
    },
    groupByKeys: {
      type: "array",
      title: "Group By Keys",
      propertyOrder: 8,
      items: { type: "string" },
      autofill: "attributeNameList",
    },
  },
  definitions: {
    AggregationOperation: {
      properties: {
        aggFunction: { type: "string", title: "Aggregate Func", enum: ["sum", "count"] },
        attribute: { type: "string", title: "Attribute" },
        "result attribute": { type: "string", title: "Result  attribute" },
      },
    },
  },
};

describe("what an operator's card says about its settings", () => {
  it("says each setting that was set, in the schema's order, under its title", () => {
    const lines = describeProperties(aggregate, {
      groupByKeys: ["noc", "year"],
      aggregations: [{ aggFunction: "count", "result attribute": "gold_medals" }],
    });
    expect(lines).toEqual([
      { key: "aggregations", label: "Aggregations", value: "count gold_medals", short: "count gold_medals" },
      { key: "groupByKeys", label: "Group By Keys", value: "noc, year", short: "noc, year" },
    ]);
  });

  it("names a dataset file by its name, not by its URI", () => {
    const lines = describeProperties(scan, {
      fileName: "texera://datasets/0109aa4a@1/files/games/athlete_events.csv",
      hasHeader: true,
      fileEncoding: "UTF_8",
      customDelimiter: ",",
    });
    expect(lines).toEqual([
      { key: "fileName", label: "File", value: "athlete_events.csv", short: "athlete_events.csv" },
    ]);
  });

  it("leaves out what is not set, what is the default, and what nobody edits", () => {
    expect(
      describeProperties(scan, { fileName: "", limit: undefined, hasHeader: true, dummyPropertyList: [{ a: 1 }] })
    ).toEqual([]);
    expect(describeProperties(filter, { predicates: [] })).toEqual([]);
  });

  it("says a number with its name and a switch by its name, so a bare 15 or yes is never shown alone", () => {
    const lines = describeProperties(scan, { limit: 15, hasHeader: false });
    expect(lines.map(l => l.short)).toEqual(["Limit 15", "no Header"]);
    expect(lines.map(l => l.value)).toEqual(["15", "no"]);
    const on = describeProperties({ properties: { isDrop: { type: "boolean", title: "Drop" } } }, { isDrop: true });
    expect(on).toEqual([{ key: "isDrop", label: "Drop", value: "yes", short: "Drop" }]);
  });

  it("reads a list of conditions as a person would write them", () => {
    const lines = describeProperties(filter, {
      predicates: [
        { attribute: "medal", condition: "=", value: "Gold" },
        { attribute: "year", condition: ">", value: "2006" },
      ],
    });
    expect(lines[0]?.value).toBe("medal = Gold, year > 2006");
  });

  it("says how long code is instead of showing it, and never shows a credential", () => {
    const udf: JsonSchema = {
      properties: {
        code: { type: "string", title: "Python script", description: "Input your code here" },
        key: { type: "string", title: "API key", format: "credential" },
      },
    };
    const lines = describeProperties(udf, { code: "a = 1\nb = 2\nyield a", key: "texera://credentials/c1" });
    expect(lines.map(l => l.value)).toEqual(["3 lines of code", "a credential"]);
  });

  it("is the first settings side by side when a card has one line for them", () => {
    const lines = describeProperties(aggregate, {
      groupByKeys: ["noc"],
      aggregations: [{ aggFunction: "count", "result attribute": "gold_medals" }],
    });
    expect(summarize(lines)).toBe("count gold_medals · noc");
    expect(summarize([])).toBe("");
    expect(summarize([...lines, { key: "x", label: "X", value: "more", short: "more" }])).toBe(
      "count gold_medals · noc"
    );
  });
});
