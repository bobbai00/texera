// Where each thing of a chat's graph stands, once its size is known. It reads left to right: data
// above models, workflows, executions, and the tables they made, and the same again for a workflow
// that reads another's table. Each workflow takes a row: the data it reads level with it on the
// left, its executions beside it one under another, the tables each kept level with it on the
// right; at the closest level a file and a table stand level with the step that reads or made it,
// and an execution runs the height of the steps. Rows are taken in the order the chat came to the
// workflows, so a new one never moves what is drawn; the models, under the data, go down as data
// comes. Arrows have at most one rounded elbow.

import { type GraphView, type Level, namedBy, type RunItem, type WorkItem } from "./model";

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
  relation: "reads" | "uses" | "runs" | "makes";
  planned: boolean;
  path: string;
  tip: string;
}

export interface Column {
  key: string;
  x: number;
  y: number;
  label: "Data" | "Model" | "Workflow" | "Execution" | "Result";
  count: number;
}

export interface Layout {
  places: Map<string, Box>;
  arrows: Arrow[];
  columns: Column[];
  width: number;
  height: number;
}

/** How a level spaces things, in ems of its own type. */
const SPACING: Record<Level, { gap: number; row: number; track: number; stack: number }> = {
  overview: { gap: 3.4, row: 0.7, track: 1.2, stack: 0.6 },
  standard: { gap: 3.4, row: 0.9, track: 1.6, stack: 0.7 },
  detail: { gap: 3.2, row: 0.9, track: 1.6, stack: 0.5 },
};

/** How far down the column's heading things start, in ems. */
const HEADING = 2.6;

/** Lays out a graph's view with what was measured; `em` is the level's type size in drawing units. */
export function layOut(view: GraphView, m: Measured, level: Level, em: number): Layout {
  const s = SPACING[level];
  const gap = s.gap * em;
  const rowGap = s.row * em;
  const trackGap = s.track * em;
  const stackGap = s.stack * em;
  const top0 = HEADING * em;
  const places = new Map<string, Box>();
  const sizeOf = (id: string) => m.size(id) ?? { w: 0, h: 0 };
  const rankOf = (id: string) => view.rank.get(id) ?? 0;
  const boxesOf = (w: WorkItem) => w.runs.map(id => view.runs.get(id)).filter((b): b is RunItem => !!b);
  const widest = (ids: string[]) => Math.max(0, ...ids.map(id => sizeOf(id).w));

  const dataIn = new Map<number, string[]>();
  for (const id of view.data.keys()) dataIn.set(rankOf(id), [...(dataIn.get(rankOf(id)) ?? []), id]);
  const models = view.models.map(n => n.uri);
  const worksIn = (r: number) => view.works.filter(w => rankOf(w.id) === r);
  const runsIn = (r: number) => [...view.runs.values()].filter(b => rankOf(b.id) === r);
  const maxRank = Math.max(
    view.idle.length ? 1 : 0,
    ...dataIn.keys(),
    ...view.works.map(w => rankOf(w.id)),
    ...[...view.runs.values()].map(b => rankOf(b.id))
  );

  // Across: a data column for an even rank; for an odd one a column of workflows, then one of executions.
  const dataX: number[] = [];
  const dataW: number[] = [];
  const workX: number[] = [];
  const execX: number[] = [];
  for (let r = 0, x = 0; r <= maxRank; r++) {
    if (r % 2 === 0) {
      const w = widest([...(dataIn.get(r) ?? []), ...(r === 0 ? models : [])]);
      dataX[r] = x;
      dataW[r] = w;
      x += w + (w > 0 ? gap : 0);
    } else {
      workX[r] = x;
      const card = widest(worksIn(r).map(w => w.id));
      x += card + (card > 0 ? gap : 0);
      execX[r] = x;
      const run = widest([...runsIn(r).map(b => b.id), ...(r === 1 ? view.idle : [])]);
      x += run + (run > 0 ? gap : 0);
    }
  }
  const at = (xs: number[], r: number) => xs[r] as number;

  const bottoms = new Map<number, number>();
  const bottom = (r: number) => bottoms.get(r) ?? top0;
  const raise = (r: number, y: number) => bottoms.set(r, Math.max(bottom(r), y));

  // A workflow's head: where its arrows meet it when nothing finer is known.
  const headOf = (w: WorkItem) => Math.min(sizeOf(w.id).h / 2, 1.6 * em);
  for (const w of view.works) {
    const r = rankOf(w.id);
    const size = sizeOf(w.id);
    const boxes = boxesOf(w);
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
    places.set(w.id, { x: at(workX, r), y: top, w: size.w, h: size.h });
    const head = top + headOf(w);
    let end = top + size.h;

    // Its executions, one under another from its top; at the closest level they share the height of the steps.
    const span = { from: top + 0.35 * em, to: top + size.h - 0.35 * em };
    const share = boxes.length ? (span.to - span.from - (boxes.length - 1) * stackGap) / boxes.length : 0;
    let next = level === "detail" ? span.from : top;
    for (const b of boxes) {
      const bs = sizeOf(b.id);
      const box = { x: at(execX, r), y: next, w: bs.w, h: level === "detail" ? Math.max(bs.h, share) : bs.h };
      places.set(b.id, box);
      next = box.y + box.h + stackGap;
      end = Math.max(end, box.y + box.h);
    }

    // What it reads, level with it on the left, right-aligned against the gap.
    let iy = bottom(r - 1);
    for (const id of inputs) {
      const d = sizeOf(id);
      const read = w.reads.find(x => x.data === id);
      const step = read?.steps[0];
      const file = read?.files[0];
      const stepAt = level === "detail" && step && file ? m.row(w.id, step) : undefined;
      const fileAt = level === "detail" && file ? m.row(id, `file:${file}`) : undefined;
      const want = stepAt !== undefined && fileAt !== undefined ? top + stepAt - fileAt : head - d.h / 2;
      const y = Math.max(iy, want);
      places.set(id, { x: at(dataX, r - 1) + at(dataW, r - 1) - d.w, y, w: d.w, h: d.h });
      iy = y + d.h + rowGap;
    }
    // What each execution made, level with it on the right; at the closest level, level with its step.
    let ry = Math.max(bottom(r + 1), top);
    for (const b of boxes) {
      const bb = places.get(b.id) as Box;
      for (const [j, id] of b.results.entries()) {
        if (places.has(id)) continue;
        const d = sizeOf(id);
        const step = view.nodes.get(id)?.step;
        const stepAt = level === "detail" && step ? m.row(w.id, step) : undefined;
        const want = stepAt !== undefined ? top + stepAt - d.h / 2 : j === 0 ? bb.y : ry;
        const y = Math.max(ry, want);
        places.set(id, { x: at(dataX, r + 1), y, w: d.w, h: d.h });
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
      x: r === 0 ? at(dataX, 0) + at(dataW, 0) - d.w : at(dataX, r),
      y,
      w: d.w,
      h: d.h,
    });
    raise(r, y + d.h + rowGap);
  }

  // The models, under all the data of the first column.
  const dataOfFirst = (dataIn.get(0) ?? []).map(id => places.get(id)).filter((b): b is Box => !!b);
  const modelHeading = dataOfFirst.length ? Math.max(...dataOfFirst.map(b => b.y + b.h)) + 1.4 * em : 0;
  let my = modelHeading + top0;
  for (const id of models) {
    const d = sizeOf(id);
    places.set(id, { x: at(dataX, 0) + at(dataW, 0) - d.w, y: my, w: d.w, h: d.h });
    my += d.h + rowGap;
  }

  // Units nothing has run on, on their own under the executions.
  for (const id of view.idle) {
    const d = sizeOf(id);
    const y = bottom(1);
    places.set(id, { x: at(execX, 1), y, w: d.w, h: d.h });
    raise(1, y + d.h + rowGap);
  }

  const columns: Column[] = [];
  for (let r = 0; r <= maxRank; r++) {
    if (r % 2 === 0) {
      const count = (dataIn.get(r) ?? []).length;
      if (count)
        columns.push({ key: `${r}:data`, x: at(dataX, r), y: 0, label: r === 0 ? "Data" : "Result", count });
      if (r === 0 && models.length)
        columns.push({ key: "0:model", x: at(dataX, 0), y: modelHeading, label: "Model", count: models.length });
    } else {
      const works = worksIn(r).length;
      if (works) columns.push({ key: `${r}:work`, x: at(workX, r), y: 0, label: "Workflow", count: works });
      const runs = runsIn(r).length + (r === 1 ? view.idle.length : 0);
      if (runs) columns.push({ key: `${r}:exec`, x: at(execX, r), y: 0, label: "Execution", count: runs });
    }
  }
  let width = 0;
  let height = 0;
  for (const b of places.values()) {
    width = Math.max(width, b.x + b.w);
    height = Math.max(height, b.y + b.h);
  }
  return { places, arrows: arrowsOf(view, places, m, level, em), columns, width, height };
}

/** The arrows, left to right: what a workflow reads and uses, its executions, the tables they made. */
function arrowsOf(view: GraphView, places: Map<string, Box>, m: Measured, level: Level, em: number): Arrow[] {
  const arrows: Arrow[] = [];
  const rankOf = (id: string) => view.rank.get(id) ?? 0;
  const inside = (y: number, b: Box, margin = 1.1 * em) =>
    Math.min(Math.max(y, b.y + Math.min(margin, b.h / 2)), b.y + b.h - Math.min(margin, b.h / 2));
  const push = (
    relation: Arrow["relation"],
    from: string,
    to: string,
    planned: boolean,
    ends: { x1: number; y1: number; x2: number; y2: number },
    options: { key?: string; late?: boolean } = {}
  ) => {
    const { x1, y1, x2, y2 } = ends;
    const head = 0.5 * em;
    const end = x2 - head * 0.85;
    arrows.push({
      key: options.key ?? `${from}>${to}`,
      from,
      to,
      relation,
      planned,
      // An arrow that passes other columns turns just before its end, past all it crosses.
      path: elbow(x1, y1, end, y2, em, options.late ? end - 1.6 * em : undefined),
      tip: `${x2},${y2} ${x2 - head},${y2 - head * 0.52} ${x2 - head},${y2 + head * 0.52}`,
    });
  };
  for (const w of view.works) {
    const card = places.get(w.id);
    if (!card) continue;
    const plannedWork = !!w.planned;
    const r = rankOf(w.id);
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
        push(
          "reads",
          read.data,
          w.id,
          plannedWork,
          { x1: d.x + d.w, y1, x2: card.x, y2 },
          { key: `${read.data}>${w.id}>${step ?? ""}`, late: r - rankOf(read.data) > 1 }
        );
      }
    }
    for (const model of w.models) {
      const b = places.get(model);
      if (!b) continue;
      const y1 = b.y + b.h / 2;
      const step = level === "detail" ? w.steps.find(s => namedBy(s).some(n => n.base === model)) : undefined;
      const sy = step ? m.row(w.id, step.id) : undefined;
      const y2 = sy !== undefined ? card.y + sy : inside(y1, card);
      push("uses", model, w.id, plannedWork, { x1: b.x + b.w, y1, x2: card.x, y2 }, { late: r > 1 });
    }
    // One line out of the workflow to each execution; straight to the first, which stands level with it.
    const runY = (b: Box) => b.y + Math.min(b.h / 2, 1.2 * em);
    const firstRun = w.runs.map(id => places.get(id)).find((b): b is Box => !!b);
    const out = firstRun ? inside(runY(firstRun), card) : 0;
    for (const id of w.runs) {
      const box = view.runs.get(id);
      const b = places.get(id);
      if (!box || !b) continue;
      push("runs", w.id, id, plannedWork || !box.run, { x1: card.x + card.w, y1: out, x2: b.x, y2: runY(b) });
      for (const t of box.results) {
        const table = places.get(t);
        if (!table) continue;
        const item = view.data.get(t);
        // A dataset the plan will make is drawn from its workflow's execution only when the same plan made or will make that workflow.
        if (item?.planned && !(plannedWork || (w.node?.turn && w.node.turn === item.planned.turn))) continue;
        const y2 = table.y + table.h / 2;
        const y1 = inside(y2, b, 0.6 * em);
        push(
          "makes",
          id,
          t,
          plannedWork || !!item?.planned || !box.run,
          { x1: b.x + b.w, y1, x2: table.x, y2 },
          { late: true }
        );
      }
    }
  }
  return arrows;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A path from one point to another: straight when level, else with one rounded elbow, midway or at `xm`. */
export function elbow(x1: number, y1: number, x2: number, y2: number, em: number, at?: number): string {
  if (Math.abs(y2 - y1) < 0.6) return `M${round(x1)},${round(y1)}H${round(x2)}`;
  const xm = at !== undefined && at > x1 && at < x2 ? at : (x1 + x2) / 2;
  const dy = Math.sign(y2 - y1);
  const r = Math.min(0.7 * em, Math.abs(y2 - y1) / 2, Math.abs(xm - x1) / 2, Math.abs(x2 - xm) / 2);
  return `M${round(x1)},${round(y1)}H${round(xm - r)}Q${round(xm)},${round(y1)} ${round(xm)},${round(y1 + dy * r)}V${round(y2 - dy * r)}Q${round(xm)},${round(y2)} ${round(xm + r)},${round(y2)}H${round(x2)}`;
}
