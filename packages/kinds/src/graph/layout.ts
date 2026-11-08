// Where each thing of a chat's graph stands, once its size is known. Columns are ranks of
// dependency: inputs, then work, then results, again for a chain. Each workflow takes a row:
// the data it reads stands level with it on the left, and the tables it made level with it on
// the right, so most arrows are straight; at the closest level a file and a table stand level
// with the step that reads or made it. Workflows that ran on one unit, one after another, share
// its frame. Rows are taken in the order the chat came to the workflows, so a new one never
// moves what is drawn. Arrows have at most one rounded elbow and never cross a card.

import type { GraphView, Level, WorkItem } from "./model";

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
  /** The height of a unit's frame above the first card in it: its name, and what it is. */
  head: (unit: string) => number;
}

export interface Frame extends Box {
  id: string;
  head: number;
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

export interface Column {
  rank: number;
  x: number;
  label: "Inputs" | "Work" | "Results";
  count: number;
}

export interface Layout {
  places: Map<string, Box>;
  frames: Frame[];
  arrows: Arrow[];
  columns: Column[];
  width: number;
  height: number;
}

/** How a level spaces things, in ems of its own type. */
const SPACING: Record<Level, { gap: number; pad: number; row: number; track: number }> = {
  overview: { gap: 4.8, pad: 0.9, row: 0.7, track: 1.2 },
  standard: { gap: 4.8, pad: 0.9, row: 0.9, track: 1.6 },
  detail: { gap: 4.4, pad: 0.9, row: 0.9, track: 1.6 },
};

/** Lays out a graph's view with what was measured; `em` is the level's type size in drawing units. */
export function layOut(view: GraphView, m: Measured, level: Level, em: number): Layout {
  const s = SPACING[level];
  const gap = s.gap * em;
  const pad = s.pad * em;
  const rowGap = s.row * em;
  const trackGap = s.track * em;
  const top0 = 2.6 * em;
  const places = new Map<string, Box>();
  const sizeOf = (id: string) => m.size(id) ?? { w: 0, h: 0 };
  const rankOf = (id: string) => view.rank.get(id) ?? 0;

  // Columns: each rank as wide as its widest thing; work columns leave room for frames.
  const inRank = new Map<number, string[]>();
  const add = (id: string) => {
    const r = rankOf(id);
    inRank.set(r, [...(inRank.get(r) ?? []), id]);
  };
  for (const id of view.data.keys()) add(id);
  for (const w of view.works) add(w.id);
  const maxRank = Math.max(0, ...inRank.keys(), view.idle.length ? 1 : 0);
  const widthOf = (r: number) => {
    const ids = [...(inRank.get(r) ?? []), ...(r === 1 ? view.idle : [])];
    const w = Math.max(0, ...ids.map(id => sizeOf(id).w));
    return r % 2 === 1 ? w + 2 * pad : w;
  };
  const colX: number[] = [];
  const colW: number[] = [];
  for (let r = 0, x = 0; r <= maxRank; r++) {
    const w = widthOf(r);
    colX[r] = x;
    colW[r] = w;
    x += w + (w > 0 ? gap : 0);
  }
  const bottoms = new Map<number, number>();
  const bottom = (r: number) => bottoms.get(r) ?? top0;
  const raise = (r: number, y: number) => bottoms.set(r, Math.max(bottom(r), y));

  const frames: Frame[] = [];
  const open = new Map<number, { unit: string; top: number; head: number; last: number }>();
  const close = (r: number) => {
    const f = open.get(r);
    if (!f) return;
    open.delete(r);
    const y = f.top - f.head;
    frames.push({ id: f.unit, x: colX[r] as number, y, w: colW[r] as number, h: f.last + pad - y, head: f.head });
    raise(r, f.last + pad + trackGap);
  };

  // A workflow's head: where its arrows meet it when nothing finer is known.
  const headOf = (w: WorkItem) => Math.min(sizeOf(w.id).h / 2, 1.6 * em);
  for (const w of view.works) {
    const r = rankOf(w.id);
    const size = sizeOf(w.id);
    const inputs = w.reads
      .map(x => x.data)
      .filter((id, i, all) => all.indexOf(id) === i && !places.has(id) && rankOf(id) === r - 1);
    const placedInputs = w.reads.map(x => places.get(x.data)).filter((b): b is Box => !!b);
    const results = w.results.filter(id => !places.has(id));

    const sameFrame = w.unit !== undefined && open.get(r)?.unit === w.unit;
    if (!sameFrame) close(r);
    const head = w.unit && !sameFrame ? m.head(w.unit) : 0;
    let top = bottom(r) + head;
    if (inputs.length) top = Math.max(top, bottom(r - 1));
    if (results.length) top = Math.max(top, bottom(r + 1));
    const first = placedInputs[0];
    if (first) top = Math.max(top, first.y + first.h / 2 - headOf(w));
    places.set(w.id, { x: (colX[r] as number) + pad, y: top, w: size.w, h: size.h });
    if (w.unit) {
      const f = open.get(r);
      if (f) f.last = top + size.h;
      else open.set(r, { unit: w.unit, top, head, last: top + size.h });
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
      const want = at !== undefined && fileAt !== undefined ? top + at - fileAt : top + headOf(w) - d.h / 2;
      const y = Math.max(iy, want);
      places.set(id, { x: (colX[r - 1] as number) + (colW[r - 1] as number) - d.w, y, w: d.w, h: d.h });
      iy = y + d.h + rowGap;
    }
    // What it made, level with it on the right; at the closest level, level with its step.
    let ry = Math.max(bottom(r + 1), top);
    for (const id of results) {
      const d = sizeOf(id);
      const step = view.nodes.get(id)?.step;
      const at = level === "detail" && step ? m.row(w.id, step) : undefined;
      const want = at !== undefined ? top + at - d.h / 2 : top;
      const y = Math.max(ry, want);
      places.set(id, { x: colX[r + 1] as number, y, w: d.w, h: d.h });
      ry = y + d.h + rowGap;
    }
    const end = Math.max(top + size.h, iy - rowGap, ry - rowGap) + trackGap;
    raise(r - 1, end);
    raise(r, end);
    raise(r + 1, end);
  }
  for (const r of [...open.keys()]) close(r);

  // Units nothing has run on yet, at the end of the work; data nothing read, at the end of the inputs.
  for (const id of view.idle) {
    const d = sizeOf(id);
    const y = bottom(1);
    frames.push({ id, x: colX[1] ?? 0, y, w: Math.max(colW[1] ?? 0, d.w + 2 * pad), h: d.h + pad, head: d.h });
    raise(1, y + d.h + pad + trackGap);
  }
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

  const arrows = arrowsOf(view, places, m, level, em);
  const columns: Column[] = [];
  for (let r = 0; r <= maxRank; r++) {
    const count = (inRank.get(r) ?? []).length;
    if (!count && !(r === 1 && view.idle.length)) continue;
    columns.push({
      rank: r,
      x: (colX[r] as number) + (r % 2 === 1 ? pad : 0),
      label: r === 0 ? "Inputs" : r % 2 === 1 ? "Work" : "Results",
      count,
    });
  }
  let width = 0;
  let height = 0;
  for (const b of [...places.values(), ...frames]) {
    width = Math.max(width, b.x + b.w);
    height = Math.max(height, b.y + b.h);
  }
  return { places, frames, arrows, columns, width, height };
}

/** The arrows: data each workflow reads, tables it made. Labels where they do not collide. */
function arrowsOf(view: GraphView, places: Map<string, Box>, m: Measured, level: Level, em: number): Arrow[] {
  const arrows: Arrow[] = [];
  const labels: Box[] = [];
  const labelled = new Set<string>();
  const inside = (y: number, b: Box) => Math.min(Math.max(y, b.y + 1.1 * em), b.y + b.h - 1.1 * em);
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
    arrows.push({
      key,
      from,
      to,
      relation,
      planned,
      path: elbow(x1, y1, end, y2, em),
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
    for (const id of w.results) {
      const r = places.get(id);
      if (!r) continue;
      const item = view.data.get(id);
      // A dataset the plan will make is drawn from its workflow only when the same plan made or will make that workflow.
      if (item?.planned && !(plannedWork || (w.node?.turn && w.node.turn === item.planned.turn))) continue;
      const step = view.nodes.get(id)?.step;
      const sy = level === "detail" && step ? m.row(w.id, step) : undefined;
      const y2 = r.y + r.h / 2;
      const y1 = sy !== undefined ? card.y + sy : inside(y2, card);
      push(`${w.id}>${id}`, w.id, id, "makes", plannedWork || !!item?.planned, card.x + card.w, y1, r.x, y2);
    }
  }
  return arrows;
}

/** A path from one point to another: straight when level, else with one rounded elbow midway. */
export function elbow(x1: number, y1: number, x2: number, y2: number, em: number): string {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (Math.abs(y2 - y1) < 0.6) return `M${r2(x1)},${r2(y1)}H${r2(x2)}`;
  const xm = (x1 + x2) / 2;
  const dy = Math.sign(y2 - y1);
  const r = Math.min(0.7 * em, Math.abs(y2 - y1) / 2, Math.abs(x2 - x1) / 4);
  return `M${r2(x1)},${r2(y1)}H${r2(xm - r)}Q${r2(xm)},${r2(y1)} ${r2(xm)},${r2(y1 + dy * r)}V${r2(y2 - dy * r)}Q${r2(xm)},${r2(y2)} ${r2(xm + r)},${r2(y2)}H${r2(x2)}`;
}
