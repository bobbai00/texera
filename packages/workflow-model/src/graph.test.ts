import { describe, expect, it } from "vitest";
import {
  addLink,
  addOperator,
  deleteOperators,
  freeSpot,
  linkProblem,
  newOperator,
  schemaDefaults,
  terminalOperators,
  updateOperator,
} from "./graph";
import { EMPTY_CONTENT } from "./operators";
import { logicalPlan } from "./plan";
import type { OperatorSchema, WorkflowContent } from "./types";

const schema = (type: string, inputs: { allowMultiLinks?: boolean }[], outputs = 1): OperatorSchema => ({
  operatorType: type,
  operatorVersion: "N/A",
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
  let c: WorkflowContent = EMPTY_CONTENT;
  c = addOperator(c, scan, { x: 0, y: 0 });
  c = addOperator(c, scan2, { x: 0, y: 100 });
  c = addOperator(c, limit, { x: 200, y: 0 });
  c = addLink(
    c,
    { operatorID: scan.operatorID, portID: "output-0" },
    { operatorID: limit.operatorID, portID: "input-0" }
  );
  return { c, scan, scan2, limit };
}

describe("newOperator", () => {
  it("builds operators with typed ids, numbered ports and schema defaults", () => {
    const op = newOperator(LIMIT);
    expect(op.operatorID).toMatch(/^Limit-operator-[0-9a-f-]{36}$/);
    expect(op.inputPorts).toEqual([
      { portID: "input-0", displayName: "", disallowMultiInputs: true, isDynamicPort: false, dependencies: [] },
    ]);
    expect(op.outputPorts).toEqual([
      { portID: "output-0", displayName: "", disallowMultiInputs: false, isDynamicPort: false },
    ]);
    expect(op.operatorProperties).toEqual({ limit: 10, flags: ["a"] });
    expect(op.customDisplayName).toBe("Limit op");
  });

  it("gives every operator its own copy of array and object defaults", () => {
    const defaults = schemaDefaults(LIMIT.jsonSchema);
    (defaults.flags as string[]).push("b");
    expect(schemaDefaults(LIMIT.jsonSchema).flags).toEqual(["a"]);
  });
});

describe("links", () => {
  it("rejects self-loops, unknown ports, duplicates and a second link into a single-input port", () => {
    const { c, scan, scan2, limit } = build();
    const out = (id: string) => ({ operatorID: id, portID: "output-0" });
    const into = (id: string) => ({ operatorID: id, portID: "input-0" });
    expect(linkProblem(c, out(limit.operatorID), into(limit.operatorID))).toMatch(/itself/);
    expect(linkProblem(c, { operatorID: scan.operatorID, portID: "output-7" }, into(limit.operatorID))).toMatch(
      /output port/
    );
    expect(linkProblem(c, out(scan.operatorID), into(limit.operatorID))).toMatch(/already linked/);
    expect(linkProblem(c, out(scan2.operatorID), into(limit.operatorID))).toMatch(/single link/);
    expect(addLink(c, out(scan2.operatorID), into(limit.operatorID))).toBe(c);
  });

  it("allows several links into a port that takes many", () => {
    const union = newOperator(UNION);
    let { c, scan, scan2 } = build();
    c = addOperator(c, union, { x: 300, y: 0 });
    c = addLink(
      c,
      { operatorID: scan.operatorID, portID: "output-0" },
      { operatorID: union.operatorID, portID: "input-0" }
    );
    c = addLink(
      c,
      { operatorID: scan2.operatorID, portID: "output-0" },
      { operatorID: union.operatorID, portID: "input-0" }
    );
    expect(c.links.filter(l => l.target.operatorID === union.operatorID)).toHaveLength(2);
  });

  it("drops an operator's links and position with it", () => {
    const { c, scan } = build();
    const after = deleteOperators(c, [scan.operatorID]);
    expect(after.links).toEqual([]);
    expect(after.operatorPositions[scan.operatorID]).toBeUndefined();
  });
});

describe("logicalPlan", () => {
  it("spreads properties flat and refers to ports by position", () => {
    const { c, scan, limit } = build();
    const plan = logicalPlan(c);
    expect(plan.operators.find(o => o.operatorID === limit.operatorID)).toMatchObject({
      operatorID: limit.operatorID,
      operatorType: "Limit",
      limit: 10,
      inputPorts: limit.inputPorts,
    });
    expect(plan.links).toEqual([
      {
        fromOpId: scan.operatorID,
        fromPortId: { id: 0, internal: false },
        toOpId: limit.operatorID,
        toPortId: { id: 0, internal: false },
      },
    ]);
    expect(plan.opsToViewResult).toEqual([]);
  });

  it("leaves out disabled operators, and keeps only the upstream of a target", () => {
    const { c, scan, scan2, limit } = build();
    const disabled = updateOperator(c, scan2.operatorID, o => ({ ...o, isDisabled: true }));
    expect(logicalPlan(disabled).operators.map(o => o.operatorID)).not.toContain(scan2.operatorID);
    expect(
      logicalPlan(c, limit.operatorID)
        .operators.map(o => o.operatorID)
        .sort()
    ).toEqual([scan.operatorID, limit.operatorID].sort());
    expect(
      terminalOperators(c)
        .map(o => o.operatorID)
        .sort()
    ).toEqual([scan2.operatorID, limit.operatorID].sort());
  });
});

describe("freeSpot", () => {
  it("moves a new operator below the ones already at that spot", () => {
    const { c } = build();
    expect(freeSpot(c, { x: 0, y: 0 })).toEqual({ x: 0, y: 220 });
    expect(freeSpot(c, { x: 500, y: 0 })).toEqual({ x: 500, y: 0 });
  });
});
