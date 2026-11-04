import { describe, expect, it } from "vitest";
import {
  addLink,
  addOperator,
  deleteOperators,
  linkProblem,
  newOperator,
  schemaDefaults,
  terminalOperators,
  updateOperator,
} from "./graph";
import { EMPTY_SPEC } from "./operators";
import { logicalPlan } from "./plan";
import type { OperatorSchema, WorkflowSpec } from "./types";

const schema = (type: string, inputs: { allowMultiLinks?: boolean }[], outputs = 1): OperatorSchema => ({
  operatorType: type,
  userFriendlyName: `${type} op`,
  operatorGroupName: "Test",
  jsonSchema: {
    properties: {
      limit: { type: "integer", default: 10 },
      name: { type: "string" },
      flags: { type: "array", default: ["a"] },
    },
    required: ["limit"],
  },
  inputPorts: inputs,
  outputPorts: Array.from({ length: outputs }, () => ({})),
});

const SCAN = schema("Scan", []);
const LIMIT = schema("Limit", [{ allowMultiLinks: false }]);
const UNION = schema("Union", [{ allowMultiLinks: true }]);

function build() {
  const scan = newOperator(SCAN);
  const scan2 = newOperator(SCAN);
  const limit = newOperator(LIMIT);
  let s: WorkflowSpec = EMPTY_SPEC;
  s = addOperator(s, scan);
  s = addOperator(s, scan2);
  s = addOperator(s, limit);
  s = addLink(s, { operatorID: scan.operatorID, portID: "output-0" }, { operatorID: limit.operatorID, portID: "input-0" });
  return { s, scan, scan2, limit };
}

describe("newOperator", () => {
  it("builds operators with typed ids, numbered ports and schema defaults", () => {
    const op = newOperator(LIMIT);
    expect(op.operatorID).toMatch(/^Limit-operator-[0-9a-f-]{36}$/);
    expect(op.inputPorts).toEqual([{ portID: "input-0" }]);
    expect(op.outputPorts).toEqual([{ portID: "output-0" }]);
    expect(newOperator(UNION).inputPorts).toEqual([{ portID: "input-0", allowMultiInputs: true }]);
    expect(op.operatorProperties).toEqual({ limit: 10, flags: ["a"] });
    expect(op.customDisplayName).toBe("Limit op");
  });

  it("types a custom operator by its URI and names its id neutrally", () => {
    const op = newOperator({ ...LIMIT, operatorType: "texera://operators/abc@2", custom: { rid: "abc", vno: 2 } });
    expect(op.operatorType).toBe("texera://operators/abc@2");
    expect(op.operatorID).toMatch(/^custom-operator-/);
  });

  it("gives every operator its own copy of array and object defaults", () => {
    const defaults = schemaDefaults(LIMIT.jsonSchema);
    (defaults.flags as string[]).push("b");
    expect(schemaDefaults(LIMIT.jsonSchema).flags).toEqual(["a"]);
  });
});

describe("links", () => {
  it("rejects self-loops, unknown ports, duplicates and a second link into a single-input port", () => {
    const { s, scan, scan2, limit } = build();
    const out = (id: string) => ({ operatorID: id, portID: "output-0" });
    const into = (id: string) => ({ operatorID: id, portID: "input-0" });
    expect(linkProblem(s, out(limit.operatorID), into(limit.operatorID))).toMatch(/itself/);
    expect(linkProblem(s, { operatorID: scan.operatorID, portID: "output-7" }, into(limit.operatorID))).toMatch(/output port/);
    expect(linkProblem(s, out(scan.operatorID), into(limit.operatorID))).toMatch(/already linked/);
    expect(linkProblem(s, out(scan2.operatorID), into(limit.operatorID))).toMatch(/single link/);
    expect(addLink(s, out(scan2.operatorID), into(limit.operatorID))).toBe(s);
  });

  it("allows several links into a port that takes many", () => {
    const union = newOperator(UNION);
    let { s } = build();
    const { scan, scan2 } = build();
    s = addOperator(s, scan);
    s = addOperator(s, scan2);
    s = addOperator(s, union);
    s = addLink(s, { operatorID: scan.operatorID, portID: "output-0" }, { operatorID: union.operatorID, portID: "input-0" });
    s = addLink(s, { operatorID: scan2.operatorID, portID: "output-0" }, { operatorID: union.operatorID, portID: "input-0" });
    expect(s.links.filter(l => l.target.operatorID === union.operatorID)).toHaveLength(2);
  });

  it("drops an operator's links with it", () => {
    const { s, scan } = build();
    const after = deleteOperators(s, [scan.operatorID]);
    expect(after.links).toEqual([]);
    expect(after.operators.map(o => o.operatorID)).not.toContain(scan.operatorID);
  });
});

describe("logicalPlan", () => {
  it("refers to ports by position and leaves out disabled operators", () => {
    const { s, scan, scan2, limit } = build();
    expect(logicalPlan(s).links).toEqual([
      { fromOpId: scan.operatorID, fromPortId: { id: 0, internal: false }, toOpId: limit.operatorID, toPortId: { id: 0, internal: false } },
    ]);
    const disabled = updateOperator(s, scan2.operatorID, o => ({ ...o, isDisabled: true }));
    expect(logicalPlan(disabled).operatorIds).not.toContain(scan2.operatorID);
  });

  it("finds the operators nothing reads from", () => {
    const { s, scan2, limit } = build();
    expect(terminalOperators(s).map(o => o.operatorID).sort()).toEqual([scan2.operatorID, limit.operatorID].sort());
  });
});
