import type { OperatorSchema, WorkflowSpec } from "@texera/workflow-model";
import { describe, expect, it } from "vitest";
import { resultLabel } from "./labels";

const aggregate: OperatorSchema = {
  operatorType: "Aggregate",
  userFriendlyName: "Aggregate",
  operatorGroupName: "Aggregate",
  inputPorts: [{}],
  outputPorts: [{}],
  jsonSchema: {
    properties: {
      aggregations: { type: "array", title: "Aggregations", propertyOrder: 7, items: { $ref: "#/definitions/Op" } },
      groupByKeys: {
        type: "array",
        title: "Group By Keys",
        propertyOrder: 8,
        items: { type: "string" },
        autofill: "attributeNameList",
      },
    },
    definitions: {
      Op: {
        properties: {
          aggFunction: { type: "string", title: "Aggregate Func", enum: ["average", "max"] },
          attribute: { type: "string", title: "Attribute" },
          "result attribute": { type: "string", title: "Result attribute" },
        },
      },
    },
  },
};
const agg = (operatorID: string, fn: string, customDisplayName?: string) => ({
  operatorID,
  operatorType: "Aggregate",
  ...(customDisplayName ? { customDisplayName } : {}),
  operatorProperties: {
    groupByKeys: ["Species"],
    aggregations: [{ aggFunction: fn, attribute: "PetalLengthCm", "result attribute": fn }],
  },
});
const spec = {
  operators: [agg("avg", "average"), agg("most", "max", "longest petals")],
  links: [],
} as unknown as WorkflowSpec;
const schemas = new Map([["Aggregate", aggregate]]);

describe("how a result is named", () => {
  it("as its card names it: two of one type are told apart by what they do", () => {
    const avg = resultLabel(spec, schemas, "avg");
    expect(avg).toMatchObject({ title: "Aggregate", type: "Aggregate" });
    expect(avg.summary).toContain("average");
    expect(resultLabel(spec, schemas, "most").title).toBe("longest petals");
  });

  it("by the operator's id when the version on screen no longer has it", () => {
    expect(resultLabel(spec, schemas, "gone")).toEqual({ title: "gone" });
    expect(resultLabel(undefined, schemas, "avg")).toEqual({ title: "avg" });
  });
});
