// Where each thing of a chat's graph stands, once its size is known. Columns are ranks of
// dependency: data, then computation, then results, again for a chain. A computation column is a
// workflow's card and, beside it, a lane for each unit its runs stood on: the run boxes in the
// lane, the unit at its foot. Each workflow takes a row: the data it reads level with it on the
// left, its runs level with it in their lanes, the tables they made level with them on the right;
// at the closest level a file and a table stand level with the step that reads or made it, and a
// run box runs the height of the steps. Rows are taken in the order the chat came to the
// workflows, so a new one never moves what is drawn. Arrows are data, with at most one rounded
// elbow; dotted ties join a run to its workflow and its unit.

import { type GraphView, type Level, type RunItem, SOMEWHERE, type WorkItem } from "./model";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the page measured of each drawn thing, in the units of the drawing. */
export interface Measured {
  size: (id: string) => { w: number; h: number } | undefined;
  /** How far down a thing a row of it sits, at its middle: a step of a workflow, a file of a dataset. */
  row: (id: string, row: string) => number | undefined;
}

export interface Arrow {
  key: string;
  from: string;
  to: string;
  relation: "reads" | "makes";
  planned: boolean;
  path: string;
  tip: string;
  label?: { x: number; y: number; anchor: "start" | "end"; text: string };
}

/** A dotted tie: a run to its workflow (tether), or the runs of a lane to its unit (rail). */
export interface Tie {
  key: string;
  kind: "tether" | "rail";
  /** What it joins: it lights up when all of these do. */
  ends: string[];
  path: string;
}

/** A unit's lane in a computation column: its runs stand in it, the unit at its foot. */
export interface Lane {
  unit: string;
  rank: number;
  /** The middle of the lane. */
  x: number;
  top: number;
  foot: Box;
}

export interface Column {
  rank: number;
  x: number;
  label: "Data" | "Computation" | "Results";
  count: number;
}

export interface Layout {
  places: Map<string, Box>;
  lanes: Lane[];
  ties: Tie[];
  arrows: Arrow[];
  columns: Column[];
  width: number;
  height: number;
}

/** The measured id of a unit's foot. */
export const footId = (unit: string) => `foot:${unit}`;

/** How a level spaces things, in ems of its own type. */
const SPACING: Record<Level, { gap: number; row: number; track: number; tether: number; lane: number }> = {
  overview: { gap: 4.4, row: 0.7, track: 1.2, tether: 1.8, lane: 1.2 },
  standard: { gap: 4.4, row: 0.9, track: 1.6, tether: 2.4, lane: 1.6 },
  detail: { gap: 4, row: 0.9, track: 1.6, tether: 2.4, lane: 1.6 },
};

/** Lays out a graph's view with what was measured; `em` is the level's type size in drawing units. */
export function layOut(view: GraphView, m: Measured, level: Level, em: number): Layout {
  const s = SPACING[level];
  const gap = s.gap * em;
  const rowGap = s.row * em;
  const trackGap = s.track * em;
  const laneGap = s.lane * em;
  const tether = s.tether * em;
  const top0 = 2.6 * em;
  const places = new Map<string, Box>();
  const sizeOf = (id: string) => m.size(id) ?? { w: 0, h: 0 };
  const rankOf = (id: string) => view.rank.get(id) ?? 0;
  const boxesOf = (w: WorkItem) => w.runs.map(id => view.runs.get(id)).filter((b): b is RunItem => !!b);

  // The lanes of each computation column: units in the order its workflows' runs first stood on
  // them; units nothing ran on in the first; the lane of runs whose unit is not known last.
  const lanesIn = new Map<number, string[]>();
  for (const w of view.works) {
    const r = rankOf(w.id);
    const lanes = lanesIn.get(r) ?? [];
    for (const b of boxesOf(w)) if (!lanes.includes(b.unit)) lanes.push(b.unit);
    lanesIn.set(r, lanes);
  }
  if (view.idle.length) lanesIn.set(1, [...(lanesIn.get(1) ?? []), ...view.idle]);
  for (const lanes of lanesIn.values()) {
    const i = lanes.indexOf(SOMEWHERE);
    if (i >= 0) lanes.push(...lanes.splice(i, 1));
  }

  // Columns: data as wide as its widest thing; computation as wide as its cards and its lanes.
  const inRank = new Map<number, string[]>();
  const add = (id: string) => {
    const r = rankOf(id);
    inRank.set(r, [...(inRank.get(r) ?? []), id]);
  };
  for (const id of view.data.keys()) add(id);
  for (const w of view.works) add(w.id);
  const maxRank = Math.max(0, ...inRank.keys(), ...lanesIn.keys());
  const laneWidth = new Map<number, number>();
  const cardWidth = new Map<number, number>();
  const widthOf = (r: number) => {
    if (r % 2 === 0) return Math.max(0, ...(inRank.get(r) ?? []).map(id => sizeOf(id).w));
    const card = Math.max(0, ...view.works.filter(w => rankOf(w.id) === r).map(w => sizeOf(w.id).w));
    const lanes = lanesIn.get(r) ?? [];
    const runsHere = [...view.runs.values()].filter(b => rankOf(b.id) === r);
    const lane = Math.max(0, ...lanes.map(u => sizeOf(footId(u)).w), ...runsHere.map(b => sizeOf(b.id).w));
    cardWidth.set(r, card);
    laneWidth.set(r, lane);
    return lanes.length ? card + tether + lanes.length * lane + (lanes.length - 1) * laneGap : card;
  };
  const colX: number[] = [];
  const colW: number[] = [];
  for (let r = 0, x = 0; r <= maxRank; r++) {
    const w = widthOf(r);
    colX[r] = x;
    colW[r] = w;
    x += w + (w > 0 ? gap : 0);
  }
  const laneX = (r: number, unit: string) => {
    const i = (lanesIn.get(r) ?? []).indexOf(unit);
    const lane = laneWidth.get(r) ?? 0;
    return (colX[r] as number) + (cardWidth.get(r) ?? 0) + tether + i * (lane + laneGap) + lane / 2;
  };
  const bottoms = new Map<number, number>();
  const bottom = (r: number) => bottoms.get(r) ?? top0;
  const raise = (r: number, y: number) => bottoms.set(r, Math.max(bottom(r), y));

  // A workflow's head: where its arrows and ties meet it when nothing finer is known.
  const headOf = (w: WorkItem) => Math.min(sizeOf(w.id).h / 2, 1.6 * em);
  const ties: Tie[] = [];
  const firstOnLane = new Map<string, number>();
  for (const w of view.works) {
    const r = rankOf(w.id);
    const size = sizeOf(w.id);
    const boxes = boxesOf(w).sort(
      (a, b) => (lanesIn.get(r) ?? []).indexOf(a.unit) - (lanesIn.get(r) ?? []).indexOf(b.unit)
    );
    const inputs = w.reads
      .map(x => x.data)
      .filter((id, i, all) => all.indexOf(id) === i && !places.has(id) && rankOf(id) === r - 1);
    const placedInputs = w.reads.map(x => places.get(x.data)).filter((b): b is Box => !!b);
    const results = boxes.flatMap(b => b.results).filter(id => !places.has(id));

    let top = bottom(r);
    if (inputs.length) top = Math.max(top, bottom(r - 1));
    if (results.length) top = Math.max(top, bottom(r + 1));
    const first = placedInputs[0];
    if (first) top = Math.max(top, first.y + first.h / 2 - headOf(w));
    places.set(w.id, { x: colX[r] as number, y: top, w: size.w, h: size.h });
    const head = top + headOf(w);
    let end = top + size.h;

    // Its runs, each in its unit's lane: level with its head, one under another; at the closest
    // level each runs the height of the steps, shared when it ran on more than one unit.
    const span = { from: top + 0.35 * em, to: top + size.h - 0.35 * em };
    const share = boxes.length ? (span.to - span.from - (boxes.length - 1) * 0.5 * em) / boxes.length : 0;
    for (const [i, b] of boxes.entries()) {
      const bs = sizeOf(b.id);
      const x = laneX(r, b.unit) - bs.w / 2;
      const box =
        level === "detail"
          ? { x, y: span.from + i * (share + 0.5 * em), w: bs.w, h: Math.max(bs.h, share) }
          : { x, y: head - bs.h / 2 + i * (bs.h + 0.7 * em), w: bs.w, h: bs.h };
      places.set(b.id, box);
      const cy = level === "detail" ? box.y + Math.min(box.h / 2, 1.25 * em) : box.y + box.h / 2;
      ties.push({
        key: `tether:${b.id}`,
        kind: "tether",
        ends: [w.id, b.id],
        path: line((colX[r] as number) + size.w, cy, box.x, cy),
      });
      if (!firstOnLane.has(`${r}|${b.unit}`)) firstOnLane.set(`${r}|${b.unit}`, cy);
      end = Math.max(end, box.y + box.h + (b.planned && b.runs.length && level !== "detail" ? 1.6 * em : 0));
    }

    // What it reads, level with it on the left, right-aligned against the gap.
    let iy = bottom(r - 1);
    for (const id of inputs) {
      const d = sizeOf(id);
      const read = w.reads.find(x => x.data === id);
      const step = read?.steps[0];
      const file = read?.files[0];
      const at = level === "detail" && step && file ? m.row(w.id, step) : undefined;
      const fileAt = level === "detail" && file ? m.row(id, `file:${file}`) : undefined;
      const want = at !== undefined && fileAt !== undefined ? top + at - fileAt : head - d.h / 2;
      const y = Math.max(iy, want);
      places.set(id, { x: (colX[r - 1] as number) + (colW[r - 1] as number) - d.w, y, w: d.w, h: d.h });
      iy = y + d.h + rowGap;
    }
    // What its runs made, level with them on the right; at the closest level, level with its step.
    let ry = Math.max(bottom(r + 1), top);
    for (const b of boxes) {
      const bb = places.get(b.id) as Box;
      for (const [j, id] of b.results.entries()) {
        if (places.has(id)) continue;
        const d = sizeOf(id);
        const step = view.nodes.get(id)?.step;
        const at = level === "detail" && step ? m.row(w.id, step) : undefined;
        const want = at !== undefined ? top + at - d.h / 2 : j === 0 ? bb.y + bb.h / 2 - d.h / 2 : ry;
        const y = Math.max(ry, want);
        places.set(id, { x: colX[r + 1] as number, y, w: d.w, h: d.h });
        ry = y + d.h + rowGap;
      }
    }
    const rowEnd = Math.max(end, iy - rowGap, ry - rowGap) + trackGap;
    raise(r - 1, rowEnd);
    raise(r, rowEnd);
    raise(r + 1, rowEnd);
  }

  // Data nothing read and nothing made, at the end of its column.
  for (const id of view.loose) {
    if (places.has(id)) continue;
    const r = rankOf(id);
    const d = sizeOf(id);
    const y = bottom(r);
    places.set(id, {
      x: r === 0 ? (colX[0] as number) + (colW[0] as number) - d.w : (colX[r] as number),
      y,
      w: d.w,
      h: d.h,
    });
    raise(r, y + d.h + rowGap);
  }

  // Each lane's unit at its foot, all of a column's on one line under its last row; the rail
  // from the lane's first run down to it.
  const lanes: Lane[] = [];
  for (const [r, units] of lanesIn) {
    const footTop = bottom(r) + 0.4 * em;
    for (const unit of units) {
      const f = sizeOf(footId(unit));
      const x = laneX(r, unit);
      const foot = { x: x - f.w / 2, y: footTop, w: f.w, h: f.h };
      const from = firstOnLane.get(`${r}|${unit}`);
      lanes.push({ unit, rank: r, x, top: from ?? footTop, foot });
      if (from !== undefined)
        ties.push({
          key: `rail:${r}|${unit}`,
          kind: "rail",
          ends: [unit],
          path: `M${round(x)},${round(from)}V${round(footTop)}`,
        });
      raise(r, footTop + f.h + trackGap);
    }
  }

  const arrows = arrowsOf(view, places, m, level, em);
  const columns: Column[] = [];
  for (let r = 0; r <= maxRank; r++) {
    const count = (inRank.get(r) ?? []).length;
    if (!count && !lanesIn.get(r)?.length) continue;
    columns.push({
      rank: r,
      x: colX[r] as number,
      label: r === 0 ? "Data" : r % 2 === 1 ? "Computation" : "Results",
      count,
    });
  }
  let width = 0;
  let height = 0;
  for (const b of [...places.values(), ...lanes.map(l => l.foot)]) {
    width = Math.max(width, b.x + b.w);
    height = Math.max(height, b.y + b.h);
  }
  return { places, lanes, ties, arrows, columns, width, height };
}

/** The arrows: data each workflow reads, tables its runs made. Labels where they do not collide. */
function arrowsOf(view: GraphView, places: Map<string, Box>, m: Measured, level: Level, em: number): Arrow[] {
  const arrows: Arrow[] = [];
  const labels: Box[] = [];
  const labelled = new Set<string>();
  const inside = (y: number, b: Box, margin = 1.1 * em) =>
    Math.min(Math.max(y, b.y + Math.min(margin, b.h / 2)), b.y + b.h - Math.min(margin, b.h / 2));
  const push = (
    key: string,
    from: string,
    to: string,
    relation: "reads" | "makes",
    planned: boolean,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ) => {
    const head = 0.5 * em;
    const end = x2 - head * 0.85;
    // A table's arrow turns just before the table, past every lane it crosses.
    const turn = relation === "makes" ? end - 1.6 * em : undefined;
    arrows.push({
      key,
      from,
      to,
      relation,
      planned,
      path: elbow(x1, y1, end, y2, em, turn),
      tip: `${x2},${y2} ${x2 - head},${y2 - head * 0.52} ${x2 - head},${y2 + head * 0.52}`,
    });
    if (level === "overview" || labelled.has(`${from}>${to}`)) return;
    const width = relation.length * 0.45 * em;
    const label =
      relation === "reads"
        ? { x: x1 + 0.55 * em, y: y1 - 0.42 * em, anchor: "start" as const }
        : { x: end - 0.35 * em, y: y2 - 0.42 * em, anchor: "end" as const };
    const box = {
      x: label.anchor === "start" ? label.x : label.x - width,
      y: label.y - 0.9 * em,
      w: width,
      h: 0.9 * em,
    };
    if (labels.some(b => b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h)) return;
    labels.push(box);
    labelled.add(`${from}>${to}`);
    (arrows.at(-1) as Arrow).label = { ...label, text: relation };
  };
  for (const w of view.works) {
    const card = places.get(w.id);
    if (!card) continue;
    const plannedWork = !!w.planned;
    for (const read of w.reads) {
      const d = places.get(read.data);
      if (!d) continue;
      const pairs =
        level === "detail" && read.steps.length
          ? read.steps.map((step, i) => ({ step, file: read.files[Math.min(i, read.files.length - 1)] }))
          : [{ step: undefined, file: undefined }];
      for (const { step, file } of pairs) {
        const fy = file !== undefined ? m.row(read.data, `file:${file}`) : undefined;
        const sy = step !== undefined ? m.row(w.id, step) : undefined;
        const y1 = fy !== undefined ? d.y + fy : d.y + d.h / 2;
        const y2 = sy !== undefined ? card.y + sy : inside(y1, card);
        push(`${read.data}>${w.id}>${step ?? ""}`, read.data, w.id, "reads", plannedWork, d.x + d.w, y1, card.x, y2);
      }
    }
    for (const id of w.runs) {
      const box = view.runs.get(id);
      const b = places.get(id);
      if (!box || !b) continue;
      for (const t of box.results) {
        const r = places.get(t);
        if (!r) continue;
        const item = view.data.get(t);
        // A dataset the plan will make is drawn from its workflow's run only when the same plan made or will make that workflow.
        if (item?.planned && !(plannedWork || (w.node?.turn && w.node.turn === item.planned.turn))) continue;
        const y2 = r.y + r.h / 2;
        const y1 = level === "detail" ? inside(y2, b, 0.9 * em) : b.y + b.h / 2;
        push(`${id}>${t}`, id, t, "makes", plannedWork || !!item?.planned || !box.runs.length, b.x + b.w, y1, r.x, y2);
      }
    }
  }
  return arrows;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A straight line from one point to another. */
function line(x1: number, y1: number, x2: number, y2: number): string {
  return `M${round(x1)},${round(y1)}L${round(x2)},${round(y2)}`;
}

/** A path from one point to another: straight when level, else with one rounded elbow, midway or at `xm`. */
export function elbow(x1: number, y1: number, x2: number, y2: number, em: number, at?: number): string {
  if (Math.abs(y2 - y1) < 0.6) return `M${round(x1)},${round(y1)}H${round(x2)}`;
  const xm = at !== undefined && at > x1 && at < x2 ? at : (x1 + x2) / 2;
  const dy = Math.sign(y2 - y1);
  const r = Math.min(0.7 * em, Math.abs(y2 - y1) / 2, Math.abs(xm - x1) / 2, Math.abs(x2 - xm) / 2);
  return `M${round(x1)},${round(y1)}H${round(xm - r)}Q${round(xm)},${round(y1)} ${round(xm)},${round(y1 + dy * r)}V${round(y2 - dy * r)}Q${round(xm)},${round(y2)} ${round(xm + r)},${round(y2)}H${round(x2)}`;
}
