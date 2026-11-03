import { describe, expect, it } from "vitest";
import { toFlow } from "./to-flow";
import type { OperatorPredicate, WorkflowContent } from "./types";

const op = (
  id: string,
  type: string,
  inputs: number,
  outputs: number,
  extra: Partial<OperatorPredicate> = {}
): OperatorPredicate => ({
  operatorID: id,
  operatorType: type,
  operatorVersion: "N/A",
  operatorProperties: {},
  inputPorts: Array.from({ length: inputs }, (_, i) => ({ portID: `input-${i}`, displayName: i === 1 ? "right" : "" })),
  outputPorts: Array.from({ length: outputs }, (_, i) => ({ portID: `output-${i}` })),
  showAdvanced: false,
  ...extra,
});

const content = (
  operators: OperatorPredicate[],
  links: WorkflowContent["links"] = [],
  positions = {}
): WorkflowContent => ({
  operators,
  operatorPositions: positions,
  links,
  commentBoxes: [],
  settings: { dataTransferBatchSize: 400, executionMode: "PIPELINED" },
});

describe("toFlow", () => {
  it("maps operators to positioned nodes with one handle per port", () => {
    const { nodes } = toFlow(
      content([op("scan", "CSVFileScan", 0, 1), op("join", "HashJoin", 2, 1)], [], { scan: { x: 10, y: 20 } })
    );
    expect(nodes.map(n => n.id)).toEqual(["scan", "join"]);
    expect(nodes[0]?.position).toEqual({ x: 10, y: 20 });
    expect(nodes[0]?.data.inputs).toEqual([]);
    expect(nodes[1]?.data.inputs).toEqual([
      { id: "input-0", label: undefined },
      { id: "input-1", label: "right" },
    ]);
  });

  it("maps links to edges between the right ports", () => {
    const link = {
      linkID: "l1",
      source: { operatorID: "a", portID: "output-0" },
      target: { operatorID: "b", portID: "input-1" },
    };
    const { edges } = toFlow(content([op("a", "Filter", 1, 1), op("b", "HashJoin", 2, 1)], [link]));
    expect(edges).toEqual([{ id: "l1", source: "a", sourceHandle: "output-0", target: "b", targetHandle: "input-1" }]);
  });

  it("labels nodes with the custom display name, falling back to the operator type", () => {
    const { nodes } = toFlow(
      content([op("a", "Filter", 1, 1, { customDisplayName: "Orders in 2026" }), op("b", "Sort", 1, 1)])
    );
    expect(nodes.map(n => n.data.label)).toEqual(["Orders in 2026", "Sort"]);
  });

  it("places operators without a stored position at the origin, and applies the overlay", () => {
    const { nodes } = toFlow(content([op("a", "Filter", 1, 1)]), { a: { status: "completed", rows: 3 } });
    expect(nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(nodes[0]?.data.status).toBe("completed");
    expect(nodes[0]?.data.rows).toBe(3);
  });

  it("returns an empty graph for an empty workflow and keeps the disabled flag", () => {
    expect(toFlow(content([]))).toEqual({ nodes: [], edges: [] });
    const { nodes } = toFlow(content([op("a", "Filter", 1, 1, { isDisabled: true })]));
    expect(nodes[0]?.data.disabled).toBe(true);
  });
});
