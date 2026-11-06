import type { Operator } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { EMPTY_SPEC, fromOperatorResource, normalizeSpec, operatorImage, schemaMap } from "./operators";

const resource = (over: Partial<Operator["spec"]>, extra: Partial<Operator> = {}): Operator => ({
  apiVersion: "catalog.texera.apache.org/v1",
  kind: "operator",
  metadata: {
    rid: "op-1",
    uri: "texera://operators/op-1",
    name: "x",
    project: "p",
    owner: "u",
    visibility: "public",
    head: 3,
    etag: "e",
    createdBy: "u",
    createdAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
  },
  spec: { operatorType: "CSVFileScan", ...over },
  ...extra,
});

describe("operator resources", () => {
  it("maps an operator the engine provides onto an editor schema by its type name", () => {
    const schema = fromOperatorResource(
      resource({
        displayName: "CSV File Scan",
        group: "Data Input",
        description: "Reads a CSV file",
        propertiesSchema: { properties: { fileName: { type: "string" } }, required: ["fileName"] },
        inputPorts: [],
        outputPorts: [{ portID: "output-0" }],
      })
    );
    expect(schema.operatorType).toBe("CSVFileScan");
    expect(schema.userFriendlyName).toBe("CSV File Scan");
    expect(schema.jsonSchema.required).toEqual(["fileName"]);
    expect(schema.custom).toBeUndefined();
    expect(operatorImage("CSVFileScan")).toBe("/operator-images/CSVFileScan.png");
  });

  it("types a custom operator by its URI at the head version", () => {
    const schema = fromOperatorResource(
      resource({
        operatorType: "Ranker",
        inputPorts: [{ portID: "input-0", allowMultiInputs: true }],
        implementation: { python: { code: "class X: ..." } },
      })
    );
    expect(schema.operatorType).toBe("texera://operators/op-1@3");
    expect(schema.custom).toEqual({ rid: "op-1", vno: 3 });
    expect(schema.operatorGroupName).toBe("Custom");
    expect(schema.inputPorts[0]?.allowMultiLinks).toBe(true);
    expect(schemaMap([resource({})]).has("CSVFileScan")).toBe(true);
    expect(operatorImage(schema.operatorType)).toBe("/operator-images/PythonUDFV2.png");
  });

  it("fills in the ports and properties a spec may omit, as the catalog does", () => {
    expect(normalizeSpec(undefined)).toEqual(EMPTY_SPEC);
    const spec = normalizeSpec({
      operators: [
        { operatorID: "scan", operatorType: "CSVFileScan" },
        { operatorID: "f", operatorType: "Filter", inputPorts: [{ portID: "input-0" }] },
      ],
      links: [],
      defaultEnvironment: "texera://environments/e",
    });
    expect(spec.operators[0]).toEqual({ operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: {}, inputPorts: [], outputPorts: [{ portID: "output-0" }] });
    expect(spec.operators[1]?.inputPorts).toEqual([{ portID: "input-0" }]);
    expect(spec.defaultEnvironment).toBe("texera://environments/e");
  });

  it("gives an operator that lists no ports the ones its links use, so no link is lost", () => {
    // A join written as an agent may write it: no ports, two links in.
    const link = (id: string, from: string, to: string, port: string) => ({
      linkID: id,
      source: { operatorID: from, portID: "output-0" },
      target: { operatorID: to, portID: port },
    });
    const spec = normalizeSpec({
      operators: [
        { operatorID: "left", operatorType: "CSVFileScan" },
        { operatorID: "right", operatorType: "CSVFileScan" },
        { operatorID: "join", operatorType: "HashJoin" },
      ],
      links: [link("l1", "left", "join", "input-0"), link("l2", "right", "join", "input-1")],
    });
    expect(spec.operators[2]?.inputPorts).toEqual([{ portID: "input-0" }, { portID: "input-1" }]);
    expect(spec.operators[2]?.outputPorts).toEqual([{ portID: "output-0" }]);
  });
});
