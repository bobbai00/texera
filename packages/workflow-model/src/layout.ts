// Where operators sit on the canvas. The spec holds no positions (it is the engine's plan),
// so the app lays the graph out: sources on the left, each operator one column right of
// its furthest input, siblings stacked. Deterministic, so the same spec always looks the same.

import type { Point, Positions, WorkflowSpec } from "./types";

export const COLUMN = 180;
export const ROW = 110;
export const ORIGIN: Point = { x: 40, y: 40 };

/** A position for every operator of the spec. */
export function layoutPositions(spec: WorkflowSpec): Positions {
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
    positions[id] = { x: ORIGIN.x + r * COLUMN, y: ORIGIN.y + row * ROW };
  }
  return positions;
}

/** Positions for the spec's operators: the ones given where they are, the rest laid out. */
export function reconcilePositions(spec: WorkflowSpec, known: Positions): Positions {
  const laid = layoutPositions(spec);
  const out: Positions = {};
  for (const op of spec.operators) out[op.operatorID] = known[op.operatorID] ?? freeSpot(out, laid[op.operatorID] ?? ORIGIN);
  return out;
}

/** Moves a spot down until it does not sit on top of another operator. */
export function freeSpot(positions: Positions, at: Point): Point {
  const taken = Object.values(positions);
  const spot = { ...at };
  while (taken.some(p => Math.abs(p.x - spot.x) < 70 && Math.abs(p.y - spot.y) < 70)) spot.y += ROW;
  return spot;
}
