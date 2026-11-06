import { describe, expect, it } from "vitest";
import { statusOf, toFlow } from "./to-flow";
import type { WorkflowOperator, WorkflowSpec } from "./types";

const op = (id: string, type: string, inputs: number, outputs: number, extra: Partial<WorkflowOperator> = {}): WorkflowOperator => ({
  operatorID: id,
  operatorType: type,
  operatorProperties: {},
  inputPorts: Array.from({ length: inputs }, (_, i) => ({ portID: `input-${i}`, displayName: i === 1 ? "right" : "" })),
  outputPorts: Array.from({ length: outputs }, (_, i) => ({ portID: `output-${i}` })),
  ...extra,
});

const spec = (operators: WorkflowOperator[], links: WorkflowSpec["links"] = []): WorkflowSpec => ({ operators, links });

describe("toFlow", () => {
  it("maps operators to positioned nodes with one handle per port", () => {
    const { nodes } = toFlow(spec([op("scan", "CSVFileScan", 0, 1), op("join", "HashJoin", 2, 1)]), { scan: { x: 10, y: 20 } });
    expect(nodes.map(n => n.id)).toEqual(["scan", "join"]);
    expect(nodes[0]?.position).toEqual({ x: 10, y: 20 });
    expect(nodes[0]?.data.inputs).toEqual([]);
    expect(nodes[1]?.data.inputs).toEqual([
      { id: "input-0", label: undefined },
      { id: "input-1", label: "right" },
    ]);
  });

  it("maps links to edges between the right ports", () => {
    const link = { linkID: "l1", source: { operatorID: "a", portID: "output-0" }, target: { operatorID: "b", portID: "input-1" } };
    const { edges } = toFlow(spec([op("a", "Filter", 1, 1), op("b", "HashJoin", 2, 1)], [link]), {});
    expect(edges).toEqual([{ id: "l1", source: "a", sourceHandle: "output-0", target: "b", targetHandle: "input-1" }]);
  });

  it("labels nodes with the custom display name, falling back to the operator type, and overlays the execution's state", () => {
    const { nodes } = toFlow(
      spec([op("a", "Filter", 1, 1, { customDisplayName: "Orders in 2026" }), op("b", "texera://operators/x@1", 1, 1)]),
      {},
      { a: { status: "completed", rows: 12 }, b: { error: "boom" } }
    );
    expect(nodes[0]?.data.label).toBe("Orders in 2026");
    expect(nodes[0]?.data).toMatchObject({ status: "completed", rows: 12 });
    expect(nodes[1]?.data.label).toBe("Custom operator");
    expect(nodes[1]?.data.error).toBe("boom");
  });

  it("gives a card what it says: the operator's settings, whether its result is kept, and the results on screen", () => {
    const { nodes } = toFlow(
      spec([
        op("top", "Limit", 1, 1, { operatorProperties: { limit: 15 }, viewResult: true, isDisabled: true }),
        op("mid", "Filter", 1, 1),
      ]),
      {},
      { top: { results: ["output-0"] } }
    );
    expect(nodes[0]?.data).toMatchObject({
      properties: { limit: 15 },
      keepsResult: true,
      disabled: true,
      results: ["output-0"],
    });
    expect(nodes[1]?.data).toMatchObject({ properties: {}, keepsResult: false });
    expect(nodes[1]?.data.results).toBeUndefined();
  });

  it("says where an operator stands in the execution: waiting, running, paused, done or failed", () => {
    expect(statusOf("Uninitialized")).toBe("waiting");
    expect(statusOf("Ready")).toBe("waiting");
    expect(statusOf("RUNNING")).toBe("running");
    expect(statusOf("Pausing")).toBe("running");
    expect(statusOf("Paused")).toBe("paused");
    expect(statusOf("Completed")).toBe("completed");
    expect(statusOf("Failed")).toBe("failed");
    expect(statusOf("Killed")).toBe("failed");
    expect(statusOf("something else")).toBeUndefined();
    expect(statusOf(undefined)).toBeUndefined();
  });

  it("moves along the arrows out of an operator that is running", () => {
    const links = [
      { linkID: "l1", source: { operatorID: "a", portID: "output-0" }, target: { operatorID: "b", portID: "input-0" } },
      { linkID: "l2", source: { operatorID: "b", portID: "output-0" }, target: { operatorID: "c", portID: "input-0" } },
    ];
    const { edges } = toFlow(
      spec([op("a", "Scan", 0, 1), op("b", "Filter", 1, 1), op("c", "Limit", 1, 1)], links),
      {},
      { a: { status: "running" }, b: { status: "waiting" } }
    );
    expect(edges.map(e => e.animated ?? false)).toEqual([true, false]);
  });
});
