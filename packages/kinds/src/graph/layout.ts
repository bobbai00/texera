// Where each thing of a lineage graph stands, once its size is known. It reads left to right:
// data, with the models under it; workflows; executions, zoomed in; results. Each workflow takes
// a band: what it reads level with it on the left, the results right of it. Zoomed out the
// results are its newest execution's, level with it. Zoomed in each execution stands as level
// as it can with the row of the version it ran, one under another, and the results it kept
// level with it; what a workflow version reads stands level with that version's row. Bands are
// taken in the order of the workflows, so a new one never moves what is drawn; the models go
// under all the data. Arrows have at most one rounded elbow.

import { boxOfRow, type GraphView, inputsOf, type Level, type RunItem } from "./model";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the page measured of each drawn thing, in the units of the drawing. */
export interface Measured {
  size: (id: string) => { w: number; h: number } | undefined;
  /** How far down a box one of its rows sits, at its middle. */
  row: (id: string, row: string) => number | undefined;
}

export interface Arrow {
  key: string;
  /** What it joins: boxes zoomed out, rows of versions zoomed in, executions and results. */
  from: string;
  to: string;
  relation: "reads" | "uses" | "runs" | "makes";
  /** Named and not read, or planned: what has not happened. */
  dashed: boolean;
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
  resources: { gap: 3.4, row: 0.7, track: 1.2, stack: 0.6 },
  versions: { gap: 3.4, row: 0.9, track: 1.6, stack: 0.7 },
};

/** How far down the column's heading things start, in ems. */
const HEADING = 2.6;

/** A workflow's executions as they stand zoomed in: by its rows, the newest first; then any of no row. */
function shownRuns(view: GraphView, work: string): RunItem[] {
  const all = (view.runsOf.get(work) ?? []).map(id => view.runs.get(id) as RunItem);
  const order = view.boxes.get(work)?.rows ?? [];
  const at = (r: RunItem) => (r.row === undefined ? order.length : order.indexOf(r.row));
  return [...all].sort((a, b) => at(a) - at(b));
}

/** Lays out a graph's view with what was measured; `em` is the level's type size in drawing units. */
export function layOut(view: GraphView, m: Measured, level: Level, em: number): Layout {
  const s = SPACING[level];
  const zoomedIn = level === "versions";
  const gap = s.gap * em;
  const rowGap = s.row * em;
  const trackGap = s.track * em;
  const stackGap = s.stack * em;
  const top0 = HEADING * em;
  const places = new Map<string, Box>();
  const sizeOf = (id: string) => m.size(id) ?? { w: 0, h: 0 };
  const widest = (ids: string[]) => Math.max(0, ...ids.map(id => sizeOf(id).w));
  const resultsOf = (work: string): string[] =>
    zoomedIn ? shownRuns(view, work).flatMap(r => r.results) : (view.latest.get(work) ?? []);
  const allResults = [...new Set([...view.works.flatMap(resultsOf), ...view.unhung])];
  const allRuns = zoomedIn ? view.works.flatMap(w => shownRuns(view, w).map(r => r.id)) : [];

  // Across: the data and models, right-aligned against their gap; workflows; executions; results.
  const dataW = widest([...view.data, ...view.models]);
  const workW = widest(view.works);
  const runW = widest(allRuns);
  const dataX = 0;
  const workX = dataW + (dataW > 0 ? gap : 0);
  const execX = workX + workW + (workW > 0 ? gap : 0);
  const resultX = execX + (runW > 0 ? runW + gap : 0);

  const bottom = { data: top0, work: top0, exec: top0, result: top0 };
  const atRight = (id: string) => dataX + dataW - sizeOf(id).w;
  // How far down its box a row of a version is: where its arrows meet it.
  const rowAt = (row: string) => m.row(boxOfRow(row), row);
  const headOf = (id: string) => Math.min(sizeOf(id).h / 2, 1.6 * em);

  for (const work of view.works) {
    const card = sizeOf(work);
    const runs = zoomedIn ? shownRuns(view, work) : [];
    const results = resultsOf(work).filter(id => !places.has(id));
    const inputs = inputsOf(view, work).filter(id => !places.has(id) && view.boxes.get(id)?.role === "data");
    let top = bottom.work;
    if (runs.length) top = Math.max(top, bottom.exec);
    if (results.length) top = Math.max(top, bottom.result);
    if (inputs.length) top = Math.max(top, bottom.data);
    places.set(work, { x: workX, y: top, w: card.w, h: card.h });
    let end = top + card.h;

    // Its executions, one under another from its top, each no higher than its version's row.
    let next = top;
    for (const r of runs) {
      const b = sizeOf(r.id);
      const at = r.row !== undefined ? rowAt(r.row) : undefined;
      const y = at === undefined ? next : Math.max(next, top + at - runHead(b.h, em));
      places.set(r.id, { x: execX, y, w: b.w, h: b.h });
      next = y + b.h + stackGap;
      end = Math.max(end, y + b.h);
    }

    // What it reads, level with the highest row of its own that reads it, or with its head.
    let iy = bottom.data;
    const order = view.boxes.get(work)?.rows ?? [];
    for (const id of inputs) {
      const d = sizeOf(id);
      const link = view.links
        .filter(l => boxOfRow(l.from) === id && boxOfRow(l.to) === work)
        .sort((a, b) => order.indexOf(a.to) - order.indexOf(b.to))[0];
      const into = zoomedIn && link ? rowAt(link.to) : undefined;
      const out = zoomedIn && link ? rowAt(link.from) : undefined;
      const want = into !== undefined && out !== undefined ? top + into - out : top + headOf(work) - d.h / 2;
      const y = Math.max(iy, want);
      places.set(id, { x: atRight(id), y, w: d.w, h: d.h });
      iy = y + d.h + rowGap;
      end = Math.max(end, y + d.h);
    }

    // What came of it, level with the execution that kept it, or with it zoomed out.
    let ry = Math.max(bottom.result, top);
    const keep = (id: string, want: number) => {
      const d = sizeOf(id);
      const y = Math.max(ry, want);
      places.set(id, { x: resultX, y, w: d.w, h: d.h });
      ry = y + d.h + rowGap;
      end = Math.max(end, y + d.h);
    };
    // The first of each level with what it came of, the rest under it.
    if (zoomedIn)
      for (const r of runs) {
        const b = places.get(r.id) as Box;
        for (const [j, id] of r.results.entries()) if (!places.has(id)) keep(id, j === 0 ? b.y : ry);
      }
    else for (const [j, id] of results.entries()) keep(id, j === 0 ? top : ry);

    const band = end + trackGap;
    bottom.data = Math.max(bottom.data, band);
    bottom.work = band;
    bottom.exec = band;
    bottom.result = Math.max(bottom.result, band);
  }

  // Data nothing on the graph reads, at the end of its column; then the models under all of it.
  for (const id of view.data) {
    if (places.has(id)) continue;
    const d = sizeOf(id);
    places.set(id, { x: atRight(id), y: bottom.data, w: d.w, h: d.h });
    bottom.data += d.h + rowGap;
  }
  const dataBottom = Math.max(0, ...view.data.map(id => places.get(id)).map(b => (b ? b.y + b.h : 0)));
  const modelHeading = view.data.length ? dataBottom + 1.4 * em : 0;
  let my = modelHeading + top0;
  for (const id of view.models) {
    const d = sizeOf(id);
    places.set(id, { x: atRight(id), y: my, w: d.w, h: d.h });
    my += d.h + rowGap;
  }
  // What the plan will make that no execution stands for, at the end of the results.
  for (const id of view.unhung) {
    if (places.has(id)) continue;
    const d = sizeOf(id);
    places.set(id, { x: resultX, y: bottom.result, w: d.w, h: d.h });
    bottom.result += d.h + rowGap;
  }

  const columns: Column[] = [];
  if (view.data.length) columns.push({ key: "data", x: dataX, y: 0, label: "Data", count: view.data.length });
  if (view.models.length)
    columns.push({ key: "model", x: dataX, y: modelHeading, label: "Model", count: view.models.length });
  if (view.works.length) columns.push({ key: "work", x: workX, y: 0, label: "Workflow", count: view.works.length });
  if (allRuns.length) columns.push({ key: "exec", x: execX, y: 0, label: "Execution", count: allRuns.length });
  if (allResults.length) columns.push({ key: "result", x: resultX, y: 0, label: "Result", count: allResults.length });
  let width = 0;
  let height = 0;
  for (const b of places.values()) {
    width = Math.max(width, b.x + b.w);
    height = Math.max(height, b.y + b.h);
  }
  return { places, arrows: arrowsOf(view, places, m, level, em), columns, width, height };
}

/** The arrows, left to right: what each workflow reads and uses, its executions, what they kept. */
function arrowsOf(view: GraphView, places: Map<string, Box>, m: Measured, level: Level, em: number): Arrow[] {
  const arrows: Arrow[] = [];
  const zoomedIn = level === "versions";
  const inside = (y: number, b: Box, margin = 1.1 * em) =>
    Math.min(Math.max(y, b.y + Math.min(margin, b.h / 2)), b.y + b.h - Math.min(margin, b.h / 2));
  const push = (
    a: Pick<Arrow, "key" | "from" | "to" | "relation" | "dashed">,
    ends: { x1: number; y1: number; x2: number; y2: number },
    late = false
  ) => {
    const { x1, y1, x2, y2 } = ends;
    const head = 0.5 * em;
    const end = x2 - head * 0.85;
    arrows.push({
      ...a,
      // An arrow that passes other things turns just before its end, past all it crosses.
      path: elbow(x1, y1, end, y2, em, late ? end - 1.6 * em : undefined),
      tip: `${x2},${y2} ${x2 - head},${y2 - head * 0.52} ${x2 - head},${y2 + head * 0.52}`,
    });
  };
  const rowY = (row: string, b: Box) => {
    const at = m.row(boxOfRow(row), row);
    return at === undefined ? undefined : b.y + at;
  };

  if (zoomedIn)
    for (const l of view.links) {
      const d = places.get(boxOfRow(l.from));
      const c = places.get(boxOfRow(l.to));
      if (!d || !c) continue;
      const y1 = rowY(l.from, d) ?? d.y + d.h / 2;
      const y2 = rowY(l.to, c) ?? inside(y1, c);
      const plannedWork = !!view.boxes.get(boxOfRow(l.to))?.planned;
      push(
        { key: l.key, from: l.from, to: l.to, relation: l.relation, dashed: !l.executed || plannedWork },
        { x1: d.x + d.w, y1, x2: c.x, y2 },
        view.boxes.get(boxOfRow(l.from))?.role === "model"
      );
    }
  else {
    // Zoomed out, one arrow from a resource to a workflow, solid when any version's was.
    const folded = new Map<string, { from: string; to: string; relation: "reads" | "uses"; executed: boolean }>();
    for (const l of view.links) {
      const from = boxOfRow(l.from);
      const to = boxOfRow(l.to);
      const key = `${from}>${to}`;
      const had = folded.get(key);
      folded.set(key, { from, to, relation: l.relation, executed: l.executed || !!had?.executed });
    }
    for (const [key, f] of folded) {
      const d = places.get(f.from);
      const c = places.get(f.to);
      if (!d || !c) continue;
      const y1 = d.y + d.h / 2;
      push(
        { key, from: f.from, to: f.to, relation: f.relation, dashed: !f.executed },
        { x1: d.x + d.w, y1, x2: c.x, y2: inside(y1, c) },
        view.boxes.get(f.from)?.role === "model"
      );
    }
  }

  for (const work of view.works) {
    const card = places.get(work);
    const box = view.boxes.get(work);
    if (!card || !box) continue;
    const makes = (from: string, b: Box, ids: string[], dashed: boolean) => {
      for (const id of ids) {
        const t = places.get(id);
        const item = view.results.get(id);
        if (!t || !item) continue;
        // What the plan will make is drawn from its workflow only when the same plan made or will make the workflow.
        if (item.planned && !(box.planned || (box.node?.turn && box.node.turn === item.planned.turn))) continue;
        const y2 = t.y + t.h / 2;
        push(
          { key: `${from}>${id}`, from, to: id, relation: "makes", dashed: dashed || !!item.planned },
          { x1: b.x + b.w, y1: inside(y2, b, 0.6 * em), x2: t.x, y2 },
          true
        );
      }
    };
    if (!zoomedIn) {
      makes(work, card, view.latest.get(work) ?? [], !!box.planned);
      continue;
    }
    // One line out of each version's row to each execution of it.
    for (const id of view.runsOf.get(work) ?? []) {
      const run = view.runs.get(id);
      const b = places.get(id);
      if (!run || !b) continue;
      const at = run.row !== undefined ? rowY(run.row, card) : undefined;
      const y1 = at ?? card.y + Math.min(card.h / 2, 1.6 * em);
      push(
        { key: `${run.row ?? work}>${id}`, from: run.row ?? work, to: id, relation: "runs", dashed: !run.run },
        { x1: card.x + card.w, y1, x2: b.x, y2: inside(y1, b, 1.2 * em) }
      );
      makes(id, b, run.results, !run.run);
    }
  }
  return arrows;
}

/** How far down an execution its line ends, its height being `h`. */
const runHead = (h: number, em: number) => Math.min(h / 2, 1.2 * em);

const round = (n: number) => Math.round(n * 100) / 100;

/** A path from one point to another: straight when level, else with one rounded elbow, midway or at `xm`. */
export function elbow(x1: number, y1: number, x2: number, y2: number, em: number, at?: number): string {
  if (Math.abs(y2 - y1) < 0.6) return `M${round(x1)},${round(y1)}H${round(x2)}`;
  const xm = at !== undefined && at > x1 && at < x2 ? at : (x1 + x2) / 2;
  const dy = Math.sign(y2 - y1);
  const r = Math.min(0.7 * em, Math.abs(y2 - y1) / 2, Math.abs(xm - x1) / 2, Math.abs(x2 - xm) / 2);
  return `M${round(x1)},${round(y1)}H${round(xm - r)}Q${round(xm)},${round(y1)} ${round(xm)},${round(y1 + dy * r)}V${round(y2 - dy * r)}Q${round(xm)},${round(y2)} ${round(xm + r)},${round(y2)}H${round(x2)}`;
}
