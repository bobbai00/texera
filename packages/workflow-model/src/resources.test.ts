import { describe, expect, it } from "vitest";
import { CARD } from "./layout";
import { RESOURCE_CHIP, RESOURCE_HANDLE, resourceLayer, resourceRoom, resourcesOf } from "./resources";
import type { WorkflowSpec } from "./types";

const D = "texera://datasets/11111111-1111-4111-8111-111111111111";
const M = "texera://models/22222222-2222-4222-8222-222222222222";
const op = (operatorID: string, operatorProperties: Record<string, unknown>) =>
  ({ operatorID, operatorType: "x", operatorProperties }) as WorkflowSpec["operators"][number];

describe("what operators read from the catalog", () => {
  it("is each dataset and model the settings name, once, however deep, and nothing else", () => {
    expect(
      resourcesOf(
        op("a", {
          file: `${D}@3/files/a%20b.csv`,
          nested: { model: `${M}@1`, again: `${M}@1` },
          type: "texera://operators/33333333-3333-4333-8333-333333333333@1",
          note: "not a resource",
        })
      )
    ).toEqual([
      { uri: `${D}@3`, kind: "dataset", file: "a b.csv" },
      { uri: `${M}@1`, kind: "model" },
    ]);
    expect(resourcesOf(op("a", {}))).toEqual([]);
  });

  it("stands each one over its operator, one above another, with a dashed line that cannot be picked", () => {
    const spec: WorkflowSpec = {
      operators: [op("scan", { file: `${D}@1/files/x.csv` }), op("both", { file: `${D}@1/files/x.csv`, model: `${M}@1` }), op("plain", {})],
      links: [],
    };
    const { nodes, edges } = resourceLayer(spec, { scan: { x: 40, y: 200 }, both: { x: 360, y: 200 }, plain: { x: 680, y: 200 } });
    expect(nodes.map(n => n.id)).toEqual([`resource:scan:${D}@1`, `resource:both:${D}@1`, `resource:both:${M}@1`]);
    const step = RESOURCE_CHIP.height + RESOURCE_CHIP.gap;
    expect(nodes[0]?.position).toEqual({ x: 40 + (CARD.width - RESOURCE_CHIP.width) / 2, y: 200 - step });
    expect(nodes[2]?.position.y).toBe(200 - 2 * step);
    expect(nodes.every(n => n.draggable === false && n.selectable === false && n.connectable === false)).toBe(true);
    expect(edges[0]).toMatchObject({ source: nodes[0]?.id, target: "scan", targetHandle: RESOURCE_HANDLE, selectable: false, deletable: false });
    expect(edges[0]?.style?.strokeDasharray).toBeDefined();
    expect(resourceRoom(spec)).toBe(2 * step);
    expect(resourceRoom({ operators: [op("plain", {})], links: [] })).toBe(0);
  });
});
