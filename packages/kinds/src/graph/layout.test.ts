import type { ConversationGraph, GraphNode } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { layoutGraph } from "./layout";

const node = (uri: string, role: GraphNode["role"], made = false): GraphNode => ({ uri, role, kind: "dataset", name: uri, made });

/** Readings and labs read by a workflow that makes a table, which a second workflow reads. */
const graph: ConversationGraph = {
  nodes: [
    node("readings", "data"),
    node("labs", "data"),
    node("lows", "workflow", true),
    node("lows-table", "data", true),
    node("risk", "workflow", true),
    node("forecaster", "model"),
    node("unit", "unit"),
  ],
  edges: [
    { from: "readings", to: "lows", relation: "reads" },
    { from: "labs", to: "lows", relation: "reads" },
    { from: "lows", to: "lows-table", relation: "makes" },
    { from: "lows-table", to: "risk", relation: "reads" },
    { from: "forecaster", to: "risk", relation: "uses" },
    { from: "lows", to: "unit", relation: "runsOn" },
  ],
  planned: [{ kind: "dataset", name: "Overnight risk", turn: "t1" }],
};

describe("the resource graph's layout", () => {
  it("puts data and work in alternating columns, each past what it depends on", () => {
    const { places, columns } = layoutGraph(graph);
    const at = (id: string) => places.get(id);
    expect([at("readings"), at("labs")]).toEqual([
      { col: 0, row: 0 },
      { col: 0, row: 1 },
    ]);
    expect(at("lows")).toEqual({ col: 1, row: 0 });
    expect(at("lows-table")).toEqual({ col: 2, row: 0 });
    expect(at("risk")).toEqual({ col: 3, row: 0 });
    // What a workflow uses or runs on hangs below it, in its column.
    expect(at("forecaster")).toEqual({ col: 3, row: 1 });
    expect(at("unit")).toEqual({ col: 1, row: 1 });
    // What the plan has not made yet stands after the last column.
    expect(at("planned:t1:dataset:Overnight risk")).toEqual({ col: 4, row: 0 });
    expect(columns).toBe(5);
  });

  it("keeps where a node was put when others arrive, and places the new ones around it", () => {
    const before = layoutGraph({ ...graph, nodes: graph.nodes.slice(0, 3), edges: graph.edges.slice(0, 2), planned: [] });
    const after = layoutGraph(graph, before.places);
    for (const [id, place] of before.places) expect(after.places.get(id)).toEqual(place);
    const seen = new Set([...after.places.values()].map(p => `${p.col}:${p.row}`));
    expect(seen.size).toBe(after.places.size);
  });
});
