import { describe, expect, it } from "vitest";
import { EMPTY_CONTENT, fromCatalogOperators, normalizeContent, schemaMap } from "./operators";

describe("catalog operators", () => {
  it("maps the catalog's operator types onto editor schemas and keeps the group tree", () => {
    const meta = fromCatalogOperators({
      operators: [
        {
          operatorType: "CSVFileScan",
          userFriendlyName: "CSV File Scan",
          operatorGroupName: "Data Input",
          operatorDescription: "Reads a CSV file",
          jsonSchema: { properties: { fileName: { type: "string" } }, required: ["fileName"] },
          inputPorts: [],
          outputPorts: [{ displayName: "" }],
          version: "sha256:abc",
        },
        {
          operatorType: "Union",
          userFriendlyName: "Union",
          operatorGroupName: "Set",
          jsonSchema: {},
          inputPorts: [{ displayName: "", allowMultiLinks: true }],
          outputPorts: [{}],
        },
      ],
      groups: [{ groupName: "Data Input", children: null }, { groupName: "Set", children: [] }],
    });
    expect(meta.groups.map(g => g.groupName)).toEqual(["Data Input", "Set"]);
    const scan = schemaMap(meta).get("CSVFileScan");
    expect(scan?.operatorVersion).toBe("sha256:abc");
    expect(scan?.jsonSchema.required).toEqual(["fileName"]);
    expect(schemaMap(meta).get("Union")?.inputPorts[0]?.allowMultiLinks).toBe(true);
  });

  it("fills in what a version's content may omit", () => {
    expect(normalizeContent(undefined)).toEqual(EMPTY_CONTENT);
    const content = normalizeContent({
      operators: [{ operatorID: "a", operatorType: "Filter", operatorVersion: "", inputPorts: [{ portID: "input-0" }] }],
      links: [],
    });
    expect(content.operators[0]).toMatchObject({ operatorProperties: {}, outputPorts: [], showAdvanced: false });
    expect(content.operatorPositions).toEqual({});
    expect(content.settings).toEqual({ dataTransferBatchSize: 400, executionMode: "PIPELINED" });
  });
});
