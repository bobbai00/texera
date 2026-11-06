import { describe, expect, it } from "vitest";
import { COLUMN, freeSpot, ICONS, layoutPositions, ORIGIN, ROW, reconcilePositions } from "./layout";
import type { WorkflowSpec } from "./types";

const link = (from: string, to: string) => ({
  linkID: `${from}-${to}`,
  source: { operatorID: from, portID: "output-0" },
  target: { operatorID: to, portID: "input-0" },
});
const spec: WorkflowSpec = {
  operators: ["a", "b", "c", "d"].map(id => ({ operatorID: id, operatorType: "X", operatorProperties: {} })),
  links: [link("a", "c"), link("b", "c"), link("c", "d")],
};

describe("layout", () => {
  it("puts sources in the first column, each operator right of its furthest input, siblings stacked", () => {
    const p = layoutPositions(spec);
    expect(p.a).toEqual(ORIGIN);
    expect(p.b).toEqual({ x: ORIGIN.x, y: ORIGIN.y + ROW });
    expect(p.c).toEqual({ x: ORIGIN.x + COLUMN, y: ORIGIN.y });
    expect(p.d).toEqual({ x: ORIGIN.x + 2 * COLUMN, y: ORIGIN.y });
  });

  it("lays a small picture out closer together, where an operator is its icon", () => {
    const p = layoutPositions(spec, ICONS);
    expect(p.c).toEqual({ x: ORIGIN.x + ICONS.column, y: ORIGIN.y });
    expect(p.b).toEqual({ x: ORIGIN.x, y: ORIGIN.y + ICONS.row });
    expect(ICONS.column).toBeLessThan(COLUMN);
  });

  it("survives a cycle and keeps positions the person already set", () => {
    const cyclic: WorkflowSpec = { ...spec, links: [...spec.links, link("d", "a")] };
    expect(Object.keys(layoutPositions(cyclic))).toHaveLength(4);
    const kept = reconcilePositions(spec, { a: { x: 500, y: 500 } });
    expect(kept.a).toEqual({ x: 500, y: 500 });
    expect(kept.b).toEqual({ x: ORIGIN.x, y: ORIGIN.y + ROW });
  });

  it("moves a spot down until it is free", () => {
    expect(freeSpot({ a: { x: 40, y: 40 } }, { x: 40, y: 40 })).toEqual({ x: 40, y: 40 + ROW });
    expect(freeSpot({}, { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
  });
});
