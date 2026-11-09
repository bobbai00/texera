// Where operators sit on the canvas. A workflow's places are the person's: they are kept in its
// document and in each version (`spec.layout`). The app lays a workflow out only where nobody
// placed anything: all of it, read left to right as a dataflow graph, when nothing is placed;
// an operator nobody placed, beside what it connects to. Deterministic: the same graph and the
// same places always give the same picture.

import { Graph, layout } from "@dagrejs/dagre";
import type { Point, Positions, WorkflowSpec } from "./types";

/** An operator's card as the layout counts it: its width, and its height while it says its settings in one line. */
export const CARD = { width: 248, height: 64 };
/**
 * From one column of cards to the next, and from one row to the next: a card, the room for an
 * arrow, and under a card the line that says how it did in an execution.
 */
export const COLUMN = CARD.width + 72;
export const ROW = CARD.height + 64;
export const ORIGIN: Point = { x: 40, y: 40 };

/** How far apart the layout puts things: from one column to the next, from one row to the next. */
export interface Grid {
  column: number;
  row: number;
}

/** The grid of a canvas of cards. */
export const CARDS: Grid = { column: COLUMN, row: ROW };
/** The grid of a small picture of a workflow, where an operator is its icon with its name under it. */
export const ICONS: Grid = { column: 150, row: 104 };

/** The box an operator takes on a grid: a card, or an icon with its name under it. */
const boxOf = (grid: Grid) => (grid.column === CARDS.column ? CARD : { width: 56, height: grid.row - 48 });

/**
 * A place for every box of a directed graph, read left to right: the top left corner of each,
 * the whole starting at (0, 0). Each box stands in the column after the furthest one it comes
 * from, and one nothing leads to stands right before what it leads to; a column is ordered so
 * arrows cross as little as they can; an arrow that skips a column keeps a lane of its own
 * there, so no box stands on it; a box stands level with what it is tied to, a join between its
 * branches. Every graph the app draws is laid out by this: the canvas, a workflow's picture,
 * lineage.
 */
export function layered(
  nodes: readonly { id: string }[],
  arrows: readonly { from: string; to: string }[],
  box: { width: number; height: number },
  gaps: { column: number; row: number }
): Positions {
  if (nodes.length === 0) return {};
  const graph = new Graph({ multigraph: true });
  graph.setGraph({ rankdir: "LR", ranksep: gaps.column, nodesep: gaps.row, ranker: "network-simplex" });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) graph.setNode(n.id, { width: box.width, height: box.height });
  for (const [i, a] of arrows.entries())
    if (a.from !== a.to && graph.hasNode(a.from) && graph.hasNode(a.to)) graph.setEdge(a.from, a.to, {}, String(i));
  layout(graph);
  const corners = nodes.map(n => {
    const { x, y } = graph.node(n.id);
    return [n.id, { x: x - box.width / 2, y: y - box.height / 2 }] as const;
  });
  const left = Math.min(...corners.map(([, p]) => p.x));
  const top = Math.min(...corners.map(([, p]) => p.y));
  return Object.fromEntries(corners.map(([id, p]) => [id, { x: Math.round(p.x - left), y: Math.round(p.y - top) }]));
}

/** A place for every operator: the workflow as a dataflow graph read left to right, from the origin. */
export function layoutPositions(spec: WorkflowSpec, grid: Grid = CARDS): Positions {
  const box = boxOf(grid);
  const places = layered(
    spec.operators.map(op => ({ id: op.operatorID })),
    spec.links.map(l => ({ from: l.source.operatorID, to: l.target.operatorID })),
    box,
    { column: grid.column - box.width, row: grid.row - box.height }
  );
  return Object.fromEntries(Object.entries(places).map(([id, p]) => [id, { x: ORIGIN.x + p.x, y: ORIGIN.y + p.y }]));
}

/**
 * Places for a spec's operators: every place someone set kept, and an operator nobody placed
 * beside what it connects to: right of what it reads from, else left of what it feeds, else
 * under everything, in the first free spot there. Operators nobody placed are taken outward from
 * what stands already, so a new chain goes on from where it joins, whatever its operators are
 * called. With nothing placed, the workflow is laid out.
 */
export function placeMissing(spec: WorkflowSpec, known: Positions): Positions {
  const placed: Positions = {};
  for (const op of spec.operators) {
    const at = known[op.operatorID];
    if (at) placed[op.operatorID] = at;
  }
  if (Object.keys(placed).length === 0) return spec.operators.length ? layoutPositions(spec) : {};
  const reading = (id: string) => spec.links.find(l => l.target.operatorID === id && placed[l.source.operatorID]);
  const feeding = (id: string) => spec.links.find(l => l.source.operatorID === id && placed[l.target.operatorID]);
  const missing = spec.operators.map(op => op.operatorID).filter(id => !placed[id]);
  while (missing.length > 0) {
    const joined = missing.findIndex(id => reading(id));
    const next = joined >= 0 ? joined : Math.max(missing.findIndex(id => feeding(id)), 0);
    const id = missing.splice(next, 1)[0] as string;
    const reads = reading(id);
    const feeds = feeding(id);
    const from = reads ? placed[reads.source.operatorID] : undefined;
    const to = feeds ? placed[feeds.target.operatorID] : undefined;
    const below = Math.max(...Object.values(placed).map(p => p.y));
    const want = from
      ? { x: from.x + COLUMN, y: from.y }
      : to
        ? { x: to.x - COLUMN, y: to.y }
        : { x: ORIGIN.x, y: below + ROW };
    placed[id] = freeSpot(placed, want);
  }
  return placed;
}

/**
 * Places for a small picture of a workflow, where an operator is its icon: the arrangement the
 * workflow was given, drawn on the icons' grid, or laid out when it does not place every operator.
 */
export function pictureOf(spec: WorkflowSpec): Positions {
  const layout = spec.layout ?? {};
  if (spec.operators.length === 0 || !spec.operators.every(op => layout[op.operatorID]))
    return layoutPositions(spec, ICONS);
  const xs = Object.values(layout).map(p => p.x);
  const ys = Object.values(layout).map(p => p.y);
  const [left, top] = [Math.min(...xs), Math.min(...ys)];
  return Object.fromEntries(
    spec.operators.map(op => {
      const at = layout[op.operatorID] as Point;
      return [
        op.operatorID,
        {
          x: Math.round(ORIGIN.x + ((at.x - left) * ICONS.column) / CARDS.column),
          y: Math.round(ORIGIN.y + ((at.y - top) * ICONS.row) / CARDS.row),
        },
      ];
    })
  );
}

/** Moves a spot down until its card does not lie on another operator's. */
export function freeSpot(positions: Positions, at: Point): Point {
  const taken = Object.values(positions);
  const spot = { ...at };
  while (taken.some(p => Math.abs(p.x - spot.x) < CARD.width && Math.abs(p.y - spot.y) < CARD.height)) spot.y += ROW;
  return spot;
}
