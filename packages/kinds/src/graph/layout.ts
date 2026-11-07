// Where each node of a chat's resource graph sits. Columns are ranks of dependency, data and
// work alternating from left to right: a dataset nothing in the chat made sits in the first,
// a workflow one past the data it reads, a table it made one past it. Models, functions and
// units hang below the workflow they serve. What the plan said it would make and has not made
// stands in the column after the last, dashed. A node keeps the place it was first given for
// the chat's life, so nothing jumps when another node arrives.

import type { ConversationGraph, GraphNode, PlannedItem } from "@texera/catalog-client/types";

export interface Place {
  col: number;
  row: number;
}

/** A node as the view draws it: one of the graph's, or an item the plan has not made yet. */
export type DrawnNode = { id: string; node: GraphNode; planned?: undefined } | { id: string; node?: undefined; planned: PlannedItem };

export interface GraphLayout {
  nodes: DrawnNode[];
  places: Map<string, Place>;
  columns: number;
  rows: number;
}

const plannedId = (p: PlannedItem) => `planned:${p.turn}:${p.kind ?? ""}:${p.name}`;
const MAIN = new Set(["data", "workflow"]);

/** Each main-line node's rank: data even, work odd, each past what it depends on. */
function ranks(graph: ConversationGraph): Map<string, number> {
  const rank = new Map<string, number>();
  for (const n of graph.nodes) if (MAIN.has(n.role)) rank.set(n.uri, n.role === "workflow" ? 1 : 0);
  // A DAG: as many passes as there are nodes settle it.
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let moved = false;
    for (const e of graph.edges) {
      const from = rank.get(e.from);
      const to = rank.get(e.to);
      if (from === undefined || to === undefined) continue;
      if ((e.relation === "reads" || e.relation === "makes") && to < from + 1) {
        rank.set(e.to, from + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return rank;
}

/** Places every node: those placed before where they were, the new ones at the end of their column. */
export function layoutGraph(graph: ConversationGraph, kept: ReadonlyMap<string, Place> = new Map()): GraphLayout {
  const rank = ranks(graph);
  const column = new Map<string, number>();
  for (const [id, r] of rank) column.set(id, r);
  // What hangs off a workflow goes in its column.
  for (const n of graph.nodes) {
    if (MAIN.has(n.role)) continue;
    const served = graph.edges.find(e => (e.from === n.uri && rank.has(e.to)) || (e.to === n.uri && rank.has(e.from)));
    const workflow = served ? (rank.has(served.to) && served.from === n.uri ? served.to : served.from) : undefined;
    column.set(n.uri, (workflow ? column.get(workflow) : undefined) ?? 1);
  }
  const last = Math.max(0, ...column.values());
  const drawn: DrawnNode[] = [
    ...graph.nodes.filter(n => MAIN.has(n.role)).map(n => ({ id: n.uri, node: n })),
    ...graph.nodes.filter(n => !MAIN.has(n.role)).map(n => ({ id: n.uri, node: n })),
    ...graph.planned.map(p => ({ id: plannedId(p), planned: p })),
  ];
  const places = new Map<string, Place>();
  const taken = new Set<string>();
  for (const d of drawn) {
    const was = kept.get(d.id);
    if (was) {
      places.set(d.id, was);
      taken.add(`${was.col}:${was.row}`);
    }
  }
  // New nodes, column by column from the left, each column in the order of the rows of what
  // its nodes connect to, so arrows cross as little as they can; what hangs off the work after.
  const neighbours = new Map<string, string[]>();
  for (const e of graph.edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }
  const colOf = (d: DrawnNode) => (d.planned ? last + 1 : (column.get(d.id) ?? 0));
  const pull = (d: DrawnNode) => {
    const rows = (neighbours.get(d.id) ?? []).map(id => places.get(id)?.row).filter((r): r is number => r !== undefined);
    return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.POSITIVE_INFINITY;
  };
  const columns = [...new Set(drawn.map(colOf))].sort((a, b) => a - b);
  for (const col of columns) {
    const fresh = drawn.filter(d => !places.has(d.id) && colOf(d) === col);
    const main = fresh.filter(d => d.node && MAIN.has(d.node.role));
    const rest = fresh.filter(d => !(d.node && MAIN.has(d.node.role)));
    const order = (list: DrawnNode[]) => list.map((d, i) => ({ d, i, at: pull(d) })).sort((a, b) => a.at - b.at || a.i - b.i);
    for (const { d } of [...order(main), ...order(rest)]) {
      let row = 0;
      while (taken.has(`${col}:${row}`)) row++;
      places.set(d.id, { col, row });
      taken.add(`${col}:${row}`);
    }
  }
  const all = [...places.values()];
  return {
    nodes: drawn,
    places,
    columns: Math.max(0, ...all.map(p => p.col)) + 1,
    rows: Math.max(0, ...all.map(p => p.row)) + 1,
  };
}
