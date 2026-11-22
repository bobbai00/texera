// What a lineage graph draws, read from what the catalog returns: the same beside a chat and on
// a resource's page. It reads left to right: data, with the models workflows use under it; each
// workflow; its executions; the results they kept; the dataset versions results were saved as.
// Zoomed out it draws resources: a box for each, an arrow where a workflow reads or uses one, the
// results of a workflow's newest execution after it. Zoomed in it draws versions: each box lists
// the versions of it that took part, an arrow runs from the version read or used to the workflow
// version that read or used it, naming each operator that reads and the file it reads, and each
// execution stands off the version it ran, with the results it kept after it and an arrow from a
// result to the version it was saved as. A function a workflow calls is said on the version that
// calls it. The steps of a version are its canvas, which opens from its row. The latest plan's
// items stand where what they name will stand. Pure, so it is tested on its own.

import type {
  GraphExecution,
  GraphNode,
  GraphPart,
  GraphResult,
  GraphUnit,
  GraphVersion,
  PlannedItem,
  ResourceGraph,
} from "@texera/catalog-client/types";
import type { OperatorSchema } from "@texera/workflow-model";
import { operatorTitle } from "../results/labels";

/** How close the graph is drawn: its resources, or the versions of them. */
export type Level = "resources" | "versions";

/** A box: a dataset, a model or a workflow, or a workflow the plan will make. */
export interface BoxItem {
  id: string;
  role: "data" | "model" | "workflow";
  node?: GraphNode;
  planned?: PlannedItem;
  /** The rows of the versions of it on the graph, the newest first. */
  rows: string[];
}

/** A function a workflow version calls, at the version it calls; used once an execution ran it. */
export interface Call {
  node: GraphNode;
  vno: number;
  executed: boolean;
}

/** A version of a box: a row of it. */
export interface RowItem {
  /** The version's URI, as the arrows name it. */
  id: string;
  box: string;
  vno: number;
  version: GraphVersion;
  /** For a workflow version: its executions on the graph, the newest first, and how many more it had. */
  runs: string[];
  earlier: number;
  /** For a workflow version: the functions it calls. */
  calls: Call[];
  /** For a version of data or a model: its files the arrows join, in the order they come. */
  files: string[];
}

/** An execution of a workflow version; or, beside a chat, the one it will start: one its plan names, or of a workflow it made and has not executed while a unit it made waits. */
export interface RunItem {
  id: string;
  work: string;
  /** The row of the version it ran; none for one the plan will start of a workflow it will make. */
  row?: string;
  run?: GraphExecution;
  planned?: PlannedItem;
  /** For one not had yet: the unit the chat made that it will likely run on, or the one its plan will make. */
  willRunOn?: GraphUnit;
  plannedUnit?: PlannedItem;
  results: string[];
}

/** A result an execution kept, or a dataset the plan will make. */
export interface ResultItem {
  id: string;
  run?: string;
  result?: GraphResult;
  planned?: PlannedItem;
  /** Its name: as its operator's card on the canvas names it. */
  title: string;
}

/** What an arrow joins inside the versions at its ends: a file of one, an operator or a port of the other. */
export interface PartItem {
  /** The file of a version of data or a model. */
  file?: string;
  /** The operator, as its card on the canvas names it. */
  operator?: string;
  executed: boolean;
}

/** An arrow from a version of data or a model to the workflow version that read or used it. */
export interface LinkItem {
  key: string;
  /** The rows it joins. */
  from: string;
  to: string;
  relation: "reads" | "uses";
  /** An execution of the workflow version read it; else the version only names it. */
  executed: boolean;
  /** Each operator that reads or uses it, with the file it reads. */
  parts: PartItem[];
}

/** An arrow from a result an execution kept to the version of a dataset it was saved as. */
export interface KeptItem {
  key: string;
  /** The execution, and its result; the result is not on the graph once the execution's results expired. */
  run: string;
  result?: string;
  /** The row of the version it was saved as. */
  to: string;
  /** The operator the result came out of, and the file it became. */
  parts: PartItem[];
}

export interface GraphView {
  boxes: Map<string, BoxItem>;
  /** The boxes in the order they stand in their columns. */
  data: string[];
  models: string[];
  works: string[];
  rows: Map<string, RowItem>;
  runs: Map<string, RunItem>;
  results: Map<string, ResultItem>;
  links: LinkItem[];
  kept: KeptItem[];
  /** The functions the workflows call, and the units the executions ran on, by URI. */
  functions: Map<string, GraphNode>;
  units: Map<string, GraphUnit>;
  /** Each workflow's executions, the newest first. */
  runsOf: Map<string, string[]>;
  /** What a workflow shows zoomed out: the results of its newest execution that kept any, then what the plan will make of it. */
  latest: Map<string, string[]>;
  /** The models and functions the plan will make, on the workflow they are likely for. */
  plannedUses: Map<string, PlannedItem[]>;
  /** Datasets the plan will make that no execution stands for: at the end of the results. */
  unhung: string[];
  /** Data and models no workflow version on the graph reads or uses. */
  loose: string[];
}

export const plannedId = (p: PlannedItem) => `planned:${p.kind ?? ""}:${p.name}`;
/** The row of a version of a box: the version's URI. */
export const rowId = (box: string, vno: number) => `${box}@${vno}`;
/** The box of a row. */
export const boxOfRow = (row: string) => row.slice(0, row.lastIndexOf("@"));
/** The execution the plan will start of a workflow. */
const plannedRunId = (work: string) => `planned:execution:${work}`;

/** How an execution stands: its phase; or, not had yet, planned or waiting to be started. */
export type RunState = "completed" | "running" | "starting" | "paused" | "failed" | "cancelled" | "planned" | "waiting";

export function runStateOf(item: RunItem): RunState {
  const phase = item.run?.phase;
  if (!item.run) return item.planned ? "planned" : "waiting";
  if (!phase) return "starting";
  if (phase === "completed" || phase === "failed" || phase === "cancelled" || phase === "paused" || phase === "running")
    return phase;
  return "starting";
}

/** An execution that is going: what is drawn of it moves. */
export const isGoing = (state: RunState) => state === "running" || state === "starting";

function push<V>(map: Map<string, V[]>, key: string, value: V, first = false) {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (first) list.unshift(value);
  else list.push(value);
}

/** The view of a lineage graph; `schemas` name the results as the canvas does. */
export function viewOf(graph: ResourceGraph, schemas?: ReadonlyMap<string, OperatorSchema>): GraphView {
  const boxes = new Map<string, BoxItem>();
  const rows = new Map<string, RowItem>();
  const functions = new Map<string, GraphNode>();
  const data: string[] = [];
  const models: string[] = [];
  const works: string[] = [];
  for (const n of graph.nodes) {
    if (n.role === "function") {
      functions.set(n.uri, n);
      continue;
    }
    const box: BoxItem = { id: n.uri, role: n.role, node: n, rows: [] };
    boxes.set(n.uri, box);
    (n.role === "data" ? data : n.role === "model" ? models : works).push(n.uri);
    for (const v of n.versions) {
      const id = rowId(n.uri, v.vno);
      box.rows.push(id);
      rows.set(id, { id, box: n.uri, vno: v.vno, version: v, runs: [], earlier: 0, calls: [], files: [] });
    }
  }

  const runs = new Map<string, RunItem>();
  const runsOf = new Map<string, string[]>();
  const units = new Map<string, GraphUnit>();
  for (const x of graph.executions) {
    const row = rows.get(rowId(x.workflow, x.version));
    if (!row) continue;
    if (x.unit) units.set(x.unit.uri, x.unit);
    runs.set(x.uri, { id: x.uri, work: x.workflow, row: row.id, run: x, results: [] });
    row.runs.push(x.uri);
    push(runsOf, x.workflow, x.uri);
  }
  for (const row of rows.values()) row.earlier = Math.max(0, (row.version.executions ?? 0) - row.runs.length);
  const results = new Map<string, ResultItem>();
  for (const r of graph.results) {
    const run = runs.get(r.execution);
    if (!run) continue;
    const op = { operatorType: r.operatorType, ...(r.displayName ? { customDisplayName: r.displayName } : {}) };
    results.set(r.uri, {
      id: r.uri,
      run: run.id,
      result: r,
      title: r.operatorType ? operatorTitle(op, schemas) : r.operator,
    });
    run.results.push(r.uri);
  }

  const links: LinkItem[] = [];
  const kept: KeptItem[] = [];
  // A file a row's arrows join, once, in the order they come.
  const fileOf = (row: RowItem | undefined, path: string | undefined) => {
    const file = path?.startsWith("files/") ? path.slice("files/".length) : undefined;
    if (row && file && !row.files.includes(file)) row.files.push(file);
    return file;
  };
  const partOf = (part: GraphPart, file: string | undefined): PartItem => {
    const op = part.operatorType
      ? { operatorType: part.operatorType, ...(part.displayName ? { customDisplayName: part.displayName } : {}) }
      : undefined;
    return {
      ...(file ? { file } : {}),
      ...(op ? { operator: operatorTitle(op, schemas) } : {}),
      executed: part.executed,
    };
  };
  for (const e of graph.edges) {
    const to = rows.get(e.to);
    if (!to) continue;
    if (e.relation === "keeps") {
      const run = runs.get(e.from);
      if (!run) continue;
      const port = e.parts.find(p => p.from)?.from;
      const result = port && results.has(`${e.from}/${port}`) ? `${e.from}/${port}` : undefined;
      kept.push({
        key: `${e.from}>${e.to}`,
        run: run.id,
        ...(result ? { result } : {}),
        to: e.to,
        parts: e.parts.map(p => partOf(p, fileOf(to, p.to))),
      });
      continue;
    }
    const fn = functions.get(boxOfRow(e.from));
    if (fn) to.calls.push({ node: fn, vno: Number(e.from.slice(e.from.lastIndexOf("@") + 1)), executed: e.executed });
    else if (rows.has(e.from)) {
      const from = rows.get(e.from);
      links.push({
        key: `${e.from}>${e.to}`,
        from: e.from,
        to: e.to,
        relation: e.relation,
        executed: e.executed,
        parts: e.parts.map(p => partOf(p, fileOf(from, p.from))),
      });
    }
  }

  // The latest plan: each item where what it names will stand.
  const planned = graph.planned;
  const plannedUses = new Map<string, PlannedItem[]>();
  const unhung: string[] = [];
  const runOfPlan = (work: string): RunItem => {
    const id = plannedRunId(work);
    let run = runs.get(id);
    if (!run) {
      const row = boxes.get(work)?.rows[0];
      run = { id, work, ...(row ? { row } : {}), results: [] };
      runs.set(id, run);
      // What has not happened yet is newer than anything that has.
      push(runsOf, work, id, true);
      if (row) rows.get(row)?.runs.unshift(id);
    }
    return run;
  };
  for (const p of planned.filter(p => p.kind === "workflow")) {
    const id = plannedId(p);
    boxes.set(id, { id, role: "workflow", planned: p, rows: [] });
    works.push(id);
    runOfPlan(id).planned = p;
  }
  const last = works.at(-1);
  const ofPlan =
    works.find(w => boxes.get(w)?.planned) ??
    [...works].reverse().find(w => {
      const turn = boxes.get(w)?.node?.turn;
      return !!turn && turn === planned[0]?.turn;
    }) ??
    last;
  for (const p of planned) {
    if (p.kind === "dataset") {
      const id = plannedId(p);
      const run = ofPlan ? (runs.get(plannedRunId(ofPlan)) ?? runs.get(runsOf.get(ofPlan)?.[0] ?? "")) : undefined;
      results.set(id, { id, planned: p, title: p.name, ...(run ? { run: run.id } : {}) });
      if (run) run.results.push(id);
      else unhung.push(id);
    } else if (p.kind === "execution") {
      const named = works.find(w => {
        const name = boxes.get(w)?.node?.name;
        return !!name && p.name.toLowerCase().includes(name.toLowerCase());
      });
      const on = named ?? last;
      if (on) runOfPlan(on).planned ??= p;
    } else if ((p.kind === "operator" || p.kind === "model") && ofPlan) {
      push(plannedUses, ofPlan, p);
    }
  }
  // What the chat will execute next: a workflow it made and has not executed, while a unit it
  // made waits; each execution not had yet is said on the unit it will likely run on, the one the
  // chat made last, else the one its plan will make.
  const waiting = graph.units[0];
  for (const unit of graph.units) units.set(unit.uri, unit);
  if (waiting)
    for (const w of works) {
      const box = boxes.get(w);
      if (box?.node?.made && box.rows.length && !runsOf.get(w)?.length) runOfPlan(w);
    }
  const plannedUnit = planned.find(p => p.kind === "computing-unit");
  for (const run of runs.values())
    if (!run.run) {
      if (waiting) run.willRunOn = waiting;
      else if (plannedUnit) run.plannedUnit = plannedUnit;
    }

  const latest = new Map<string, string[]>();
  for (const w of works) {
    const mine = (runsOf.get(w) ?? []).map(id => runs.get(id) as RunItem);
    const kept = mine.find(r => r.run && r.results.some(id => !results.get(id)?.planned));
    const promised = mine.filter(r => !r.run).flatMap(r => r.results);
    const shown = [...(kept?.results ?? []), ...promised];
    if (shown.length) latest.set(w, [...new Set(shown)]);
  }
  const linked = new Set([...links.map(l => boxOfRow(l.from)), ...kept.map(k => boxOfRow(k.to))]);
  const loose = [...data, ...models].filter(id => !linked.has(id));
  return {
    boxes,
    data,
    models,
    works,
    rows,
    runs,
    results,
    links,
    kept,
    functions,
    units,
    runsOf,
    latest,
    plannedUses,
    unhung,
    loose,
  };
}

/** The boxes whose versions a workflow reads or uses, in the order the arrows come. */
export function inputsOf(view: GraphView, work: string): string[] {
  const mine = new Set(view.boxes.get(work)?.rows);
  const out: string[] = [];
  for (const l of view.links) {
    const box = boxOfRow(l.from);
    if (mine.has(l.to) && !out.includes(box)) out.push(box);
  }
  return out;
}

/** A workflow's functions said once each, at the newest version any of its versions calls. */
export function callsOf(view: GraphView, work: string): Call[] {
  const out = new Map<string, Call>();
  for (const row of view.boxes.get(work)?.rows ?? [])
    for (const c of view.rows.get(row)?.calls ?? []) {
      const had = out.get(c.node.uri);
      if (!had || c.vno > had.vno) out.set(c.node.uri, { ...c, executed: c.executed || !!had?.executed });
    }
  return [...out.values()];
}

/** What lights up with a thing: what it reads or is read by, its executions and what they kept. */
export function touching(view: GraphView, id: string): Set<string> {
  const near = new Set([id]);
  const add = (...ids: (string | undefined)[]) => {
    for (const x of ids) if (x) near.add(x);
  };
  const intoRow = (row: string) => {
    for (const l of view.links) if (l.to === row) add(l.from, boxOfRow(l.from));
  };
  const runAndResults = (run: string) => {
    add(run, ...(view.runs.get(run)?.results ?? []));
    for (const k of view.kept) if (k.run === run) add(k.to, boxOfRow(k.to));
  };
  // What a version of data was saved from: the result, its execution and the version that ran.
  const savedFrom = (rows: (r: string) => boolean) => {
    for (const k of view.kept)
      if (rows(k.to)) {
        const by = view.runs.get(k.run);
        add(k.result, k.run, by?.work, by?.row);
      }
  };
  const workRow = (row: RowItem) => {
    add(row.id, row.box);
    intoRow(row.id);
    for (const r of row.runs) runAndResults(r);
    for (const c of row.calls) add(c.node.uri);
  };
  const box = view.boxes.get(id);
  const row = view.rows.get(id);
  const run = view.runs.get(id);
  const result = view.results.get(id);
  if (box?.role === "workflow") {
    for (const r of box.rows) workRow(view.rows.get(r) as RowItem);
    for (const r of view.runsOf.get(id) ?? []) runAndResults(r);
    add(...(view.latest.get(id) ?? []));
  } else if (box) {
    for (const l of view.links) if (boxOfRow(l.from) === id) add(l.from, l.to, boxOfRow(l.to));
    savedFrom(r => boxOfRow(r) === id);
  }
  if (row && view.boxes.get(row.box)?.role === "workflow") workRow(row);
  else if (row) {
    add(row.box);
    for (const l of view.links) if (l.from === row.id) add(l.to, boxOfRow(l.to));
    savedFrom(r => r === row.id);
  }
  if (run) {
    add(run.work, run.row);
    if (run.row) intoRow(run.row);
    runAndResults(run.id);
  }
  if (result?.run) {
    const by = view.runs.get(result.run);
    add(by?.id, by?.work, by?.row);
    for (const k of view.kept) if (k.result === id) add(k.to, boxOfRow(k.to));
  }
  if (view.functions.has(id))
    for (const r of view.rows.values()) if (r.calls.some(c => c.node.uri === id)) add(r.id, r.box);
  return near;
}

/** What a thing is to the rest of the graph, in groups a person reads: what to go to next. */
export function relationsOf(view: GraphView, id: string): { label: string; ids: string[] }[] {
  const out: { label: string; ids: string[] }[] = [];
  const add = (label: string, ids: string[]) => {
    const unique = ids.filter((x, i) => ids.indexOf(x) === i);
    if (unique.length) out.push({ label, ids: unique });
  };
  const from = (rows: Set<string>, role: "data" | "model") =>
    view.links.filter(l => rows.has(l.to) && view.boxes.get(boxOfRow(l.from))?.role === role).map(l => l.from);
  const to = (rows: Set<string>) => view.links.filter(l => rows.has(l.from)).map(l => l.to);
  const box = view.boxes.get(id);
  const row = view.rows.get(id);
  const workRows =
    box?.role === "workflow"
      ? new Set(box.rows)
      : row && view.boxes.get(row.box)?.role === "workflow"
        ? new Set([row.id])
        : undefined;
  if (workRows) {
    const runs = [...workRows].flatMap(r => view.rows.get(r)?.runs ?? []);
    add("Reads", from(workRows, "data"));
    add("Uses", [
      ...from(workRows, "model"),
      ...[...workRows].flatMap(r => view.rows.get(r)?.calls.map(c => c.node.uri) ?? []),
    ]);
    add("Executions", box ? (view.runsOf.get(id) ?? []) : runs);
    add(
      "Made",
      (box ? (view.runsOf.get(id) ?? []) : runs).flatMap(r => view.runs.get(r)?.results ?? [])
    );
    return out;
  }
  if (box || row) {
    const rows = new Set(box ? box.rows : [id]);
    add(
      "Saved from",
      view.kept.filter(k => rows.has(k.to)).map(k => k.result ?? k.run)
    );
    add(box?.role === "model" || view.boxes.get(row?.box ?? "")?.role === "model" ? "Used by" : "Read by", to(rows));
    return out;
  }
  const run = view.runs.get(id);
  if (run) {
    add("Of", [run.row ?? run.work]);
    add("Read", run.row ? from(new Set([run.row]), "data") : []);
    add("Made", run.results);
    add(
      "Saved as",
      view.kept.filter(k => k.run === run.id).map(k => k.to)
    );
    return out;
  }
  const result = view.results.get(id);
  if (result?.run) {
    add("Made by", [result.run]);
    add(
      "Saved as",
      view.kept.filter(k => k.result === id).map(k => k.to)
    );
    return out;
  }
  if (view.functions.has(id))
    add(
      "Used by",
      [...view.rows.values()].filter(r => r.calls.some(c => c.node.uri === id)).map(r => r.id)
    );
  if (view.units.has(id))
    add(
      "Executions on it",
      [...view.runs.values()].filter(r => (r.run?.unit ?? r.willRunOn)?.uri === id).map(r => r.id)
    );
  return out;
}

/** A thing's name on the graph. */
export function nameOf(view: GraphView, id: string): string {
  const box = view.boxes.get(id);
  if (box) return box.node ? box.node.name || "Not shared with you" : (box.planned?.name ?? id);
  const row = view.rows.get(id);
  if (row) return `${nameOf(view, row.box)} v${row.vno}`;
  const run = view.runs.get(id);
  if (run) {
    const of = run.row ? nameOf(view, run.row) : nameOf(view, run.work);
    return run.run ? `Execution of ${of}` : run.planned ? `Planned execution of ${of}` : `Next execution of ${of}`;
  }
  const result = view.results.get(id);
  if (result) return result.title;
  return view.functions.get(id)?.name ?? view.units.get(id)?.name ?? id;
}

/** What a comment on a thing of the graph is about; undefined for what is only planned or not shared. */
export function commentTarget(view: GraphView, id: string): { uri: string; name: string } | undefined {
  const run = view.runs.get(id);
  if (run) return run.run ? { uri: run.run.uri, name: nameOf(view, id).replace(/^E/, "e") } : undefined;
  const result = view.results.get(id);
  if (result) return result.result ? { uri: result.result.uri, name: result.title } : undefined;
  const unit = view.units.get(id);
  if (unit) return { uri: unit.uri, name: unit.name };
  const row = view.rows.get(id);
  const node = view.boxes.get(row?.box ?? id)?.node ?? view.functions.get(id);
  if (!node?.readable) return undefined;
  return { uri: row ? row.id : node.uri, name: nameOf(view, id) };
}
