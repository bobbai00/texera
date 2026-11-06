// Where operators sit on the canvas. The spec holds no positions (it is the engine's plan),
// so the app lays the graph out: sources on the left, each operator one column right of
// its furthest input, siblings stacked. Deterministic, so the same spec always looks the same.

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

/** A position for every operator of the spec. */
export function layoutPositions(spec: WorkflowSpec, grid: Grid = CARDS): Positions {
  const ids = spec.operators.map(o => o.operatorID);
  const upstream = new Map<string, string[]>(ids.map(id => [id, []]));
  for (const l of spec.links) upstream.get(l.target.operatorID)?.push(l.source.operatorID);
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const inputs = upstream.get(id) ?? [];
    const r = inputs.length ? Math.max(...inputs.map(rankOf)) + 1 : 0;
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  const rows = new Map<number, number>();
  const positions: Positions = {};
  for (const id of ids) {
    const r = rankOf(id);
    const row = rows.get(r) ?? 0;
    rows.set(r, row + 1);
    positions[id] = { x: ORIGIN.x + r * grid.column, y: ORIGIN.y + row * grid.row };
  }
  return positions;
}

/** Positions for the spec's operators: the ones given where they are, the rest laid out. */
export function reconcilePositions(spec: WorkflowSpec, known: Positions): Positions {
  const laid = layoutPositions(spec);
  const out: Positions = {};
  for (const op of spec.operators)
    out[op.operatorID] = known[op.operatorID] ?? freeSpot(out, laid[op.operatorID] ?? ORIGIN);
  return out;
}

/** Moves a spot down until its card does not lie on another operator's. */
export function freeSpot(positions: Positions, at: Point): Point {
  const taken = Object.values(positions);
  const spot = { ...at };
  while (taken.some(p => Math.abs(p.x - spot.x) < CARD.width && Math.abs(p.y - spot.y) < CARD.height)) spot.y += ROW;
  return spot;
}
