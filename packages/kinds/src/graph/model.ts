// What a chat's graph draws, read from what the catalog returns. It reads left to right: data and
// the models workflows use, then each workflow, then each of its executions, then the tables they
// made. An execution is a box of its own and carries the unit it ran on, so a unit stands once for
// every execution on it. The functions a workflow uses ride on its card. Data and work stand in
// ranks of dependency, data even and work odd. Each item of the latest plan stands where the thing
// it names will stand. Pure, so it is tested on its own.

import type { ConversationGraph, GraphNode, GraphRun, GraphStep, PlannedItem } from "@texera/catalog-client/types";
import { baseOf, namesIn } from "@texera/workflow-model";

export { baseOf };

/** How close the graph is drawn: the whole of it, each thing with its facts, or a workflow's steps. */
export type Level = "overview" | "standard" | "detail";

/** A dataset, a table a run made, or one the plan will make. */
export interface DataItem {
  id: string;
  node?: GraphNode;
  planned?: PlannedItem;
  /** The files of it the chat's workflows read, by path, in the order first read. */
  files: string[];
}

/** A computing unit: inside each execution on it, or on its own when none has run on it. */
export interface UnitItem {
  id: string;
  node?: GraphNode;
  planned?: PlannedItem;
}

/** Where an execution ran when that is not known: a unit the caller may not see, or one nothing names yet. */
export const SOMEWHERE = "unit:somewhere";

/** What a workflow reads of a dataset: by which of its steps, and which of its files. */
export interface Read {
  data: string;
  steps: string[];
  files: string[];
}

/** A workflow, or one the plan will make. */
export interface WorkItem {
  id: string;
  node?: GraphNode;
  planned?: PlannedItem;
  steps: GraphStep[];
  reads: Read[];
  /** The models it uses, drawn on their own and tied to it. */
  models: string[];
  /** The functions it uses, on its card. */
  uses: GraphNode[];
  /** Models and functions the plan will make, which it will likely use. */
  plannedUses: PlannedItem[];
  /** Its executions, the newest first; one it has not had yet comes before them. */
  runs: string[];
}

/** An execution of a workflow; without `run`, the one it has not had yet. */
export interface RunItem {
  id: string;
  work: string;
  /** The unit it ran or will run on, or SOMEWHERE. */
  unit: string;
  run?: GraphRun;
  /** The execution the latest plan will start here, or the plan's workflow this is the execution of. */
  planned?: PlannedItem;
  /** The tables it kept, in the order of the workflow's steps; then what the plan will make. */
  results: string[];
}

/** How an execution stands: its phase, or that it has not happened. */
export type RunState = "completed" | "running" | "starting" | "paused" | "failed" | "cancelled" | "planned" | "idle";

export function runStateOf(box: RunItem): RunState {
  const phase = box.run?.phase;
  if (!phase) return box.planned ? "planned" : "idle";
  if (phase === "completed" || phase === "failed" || phase === "cancelled" || phase === "paused" || phase === "running")
    return phase;
  return "starting";
}

/** An execution that is going: what is drawn of it moves. */
export const isGoing = (state: RunState) => state === "running" || state === "starting";

export interface GraphView {
  works: WorkItem[];
  runs: Map<string, RunItem>;
  data: Map<string, DataItem>;
  units: Map<string, UnitItem>;
  /** The models on the graph: under the data, in the order the chat came to them. */
  models: GraphNode[];
  /** Data no workflow on the graph reads or made: it stands at the end of its column. */
  loose: string[];
  /** Units nothing has run on yet, and none will by the plan: they stand on their own. */
  idle: string[];
  /** Each item's rank: data even, work and its executions odd, each past what it depends on. */
  rank: Map<string, number>;
  /** Every node of the graph by its URI, models and functions too. */
  nodes: Map<string, GraphNode>;
}

export const plannedId = (p: PlannedItem) => `planned:${p.kind ?? ""}:${p.name}`;
/** An execution's id on the graph, by what tells it apart: its URI, or the unit of one not had yet. */
export const runId = (work: string, key: string) => `run:${work}|${key}`;

/** The view of a chat's graph: its workflows with what they read and use, and their executions. */
export function viewOf(graph: ConversationGraph): GraphView {
  const nodes = new Map(graph.nodes.map(n => [n.uri, n]));
  const data = new Map<string, DataItem>();
  const units = new Map<string, UnitItem>();
  for (const n of graph.nodes) {
    if (n.role === "data") data.set(n.uri, { id: n.uri, node: n, files: [] });
    if (n.role === "unit") units.set(n.uri, { id: n.uri, node: n });
  }
  const works: WorkItem[] = graph.nodes
    .filter(n => n.role === "workflow")
    .map(n => ({ id: n.uri, node: n, steps: n.steps ?? [], reads: [], models: [], uses: [], plannedUses: [], runs: [] }));
  const work = new Map(works.map(w => [w.id, w]));
  const runs = new Map<string, RunItem>();
  const boxOf = (w: WorkItem, unit: string, run?: GraphRun): RunItem => {
    const id = runId(w.id, run?.uri ?? unit);
    let box = runs.get(id);
    if (!box) {
      box = { id, work: w.id, unit, ...(run ? { run } : {}), results: [] };
      runs.set(id, box);
      // The executions come newest first, and what has not happened yet is newer still.
      if (run) w.runs.push(id);
      else w.runs.unshift(id);
    }
    return box;
  };
  const boxes = (w: WorkItem) => w.runs.map(id => runs.get(id) as RunItem);

  const made = new Map<string, string[]>();
  const ranOn = new Map<string, string[]>();
  for (const e of graph.edges) {
    const w = work.get(e.relation === "makes" || e.relation === "runsOn" ? e.from : e.to);
    if (!w) continue;
    if (e.relation === "reads" && data.has(e.from) && !w.reads.some(r => r.data === e.from))
      w.reads.push(readOf(w, e.from));
    if (e.relation === "uses") {
      const tool = nodes.get(e.from);
      if (tool?.role === "model" && !w.models.includes(tool.uri)) w.models.push(tool.uri);
      else if (tool && tool.role !== "model" && !w.uses.includes(tool)) w.uses.push(tool);
    }
    if (e.relation === "makes" && data.has(e.to)) made.set(w.id, [...(made.get(w.id) ?? []), e.to]);
    if (e.relation === "runsOn" && units.has(e.to)) ranOn.set(w.id, [...(ranOn.get(w.id) ?? []), e.to]);
  }

  // Each workflow's executions, the newest first, and the tables each of them kept.
  for (const w of works) {
    const ran = w.node?.runs ?? [];
    const on = ranOn.get(w.id) ?? [];
    for (const run of ran) {
      const unit =
        run.unit && units.has(run.unit) ? run.unit : !run.unit && on.length === 1 ? (on[0] as string) : SOMEWHERE;
      boxOf(w, unit, run);
    }
    for (const table of made.get(w.id) ?? []) {
      const by = nodes.get(table)?.run;
      const box = boxes(w).find(b => b.run?.uri === by) ?? boxes(w)[0];
      box?.results.push(table);
    }
    const at = (id: string) => {
      const i = w.steps.findIndex(s => s.id === nodes.get(id)?.step);
      return i < 0 ? w.steps.length : i;
    };
    for (const box of boxes(w)) box.results.sort((a, b) => at(a) - at(b));
    for (const r of w.reads) {
      const d = data.get(r.data) as DataItem;
      for (const f of r.files) if (!d.files.includes(f)) d.files.push(f);
    }
  }

  // The latest plan, and what has not run: each where it will stand.
  const planned = graph.planned;
  const plannedUnit = planned.find(p => p.kind === "computing-unit");
  if (plannedUnit) units.set(plannedId(plannedUnit), { id: plannedId(plannedUnit), planned: plannedUnit });
  const ranAnywhere = new Set([...runs.values()].map(b => b.unit));
  // A fresh unit, made and not run on yet: what the plan's work will run on, when it is the one.
  const fresh = [...units.values()].filter(u => u.node?.made && !ranAnywhere.has(u.id));
  const target = plannedUnit ? plannedId(plannedUnit) : fresh.length === 1 ? fresh[0]?.id : undefined;
  for (const w of works) {
    if (w.runs.length) continue;
    const unit = ranOn.get(w.id)?.[0] ?? (w.node?.made ? target : undefined);
    if (unit) boxOf(w, unit);
  }
  for (const p of planned.filter(p => p.kind === "workflow")) {
    const w: WorkItem = { id: plannedId(p), planned: p, steps: [], reads: [], models: [], uses: [], plannedUses: [], runs: [] };
    works.push(w);
    work.set(w.id, w);
    boxOf(w, target ?? SOMEWHERE).planned = p;
  }
  const last = works.at(-1);
  const ofPlan =
    works.find(w => w.planned) ??
    [...works].reverse().find(w => w.node?.turn && w.node.turn === planned[0]?.turn) ??
    last;
  const unhung: string[] = [];
  for (const p of planned) {
    if (p.kind === "dataset") {
      const id = plannedId(p);
      data.set(id, { id, planned: p, files: [] });
      const box = ofPlan ? boxes(ofPlan)[0] : undefined;
      if (box) box.results.push(id);
      else unhung.push(id);
    } else if (p.kind === "execution") {
      const named = works.find(w => w.node && p.name.toLowerCase().includes(w.node.name.toLowerCase()));
      const on = named ?? last;
      if (!on) continue;
      // The execution it has not had yet: on the unit made for it, else where it ran last.
      const box = boxes(on).find(b => !b.run) ?? boxOf(on, target ?? boxes(on)[0]?.unit ?? SOMEWHERE);
      box.planned ??= p;
    } else if (p.kind === "operator" || p.kind === "model") {
      ofPlan?.plannedUses.push(p);
    }
  }

  // Ranks: data even, work odd, each past what it depends on; an execution with its workflow.
  const rank = new Map<string, number>();
  for (const id of data.keys()) rank.set(id, 0);
  for (const w of works) rank.set(w.id, 1);
  for (let pass = 0, moved = true; moved && pass <= works.length + data.size; pass++) {
    moved = false;
    for (const w of works) {
      const need = Math.max(1, ...w.reads.map(r => (rank.get(r.data) ?? 0) + 1));
      if (need > (rank.get(w.id) ?? 1)) {
        rank.set(w.id, need);
        moved = true;
      }
      const at = (rank.get(w.id) ?? 1) + 1;
      for (const box of boxes(w))
        for (const r of box.results)
          if (at > (rank.get(r) ?? 0)) {
            rank.set(r, at);
            moved = true;
          }
    }
  }
  for (const box of runs.values()) rank.set(box.id, rank.get(box.work) ?? 1);
  for (const id of unhung) rank.set(id, (ofPlan ? (rank.get(ofPlan.id) ?? 1) : 1) + 1);

  const hung = new Set([...runs.values()].flatMap(b => b.results));
  const read = new Set(works.flatMap(w => w.reads.map(r => r.data)));
  const loose = [...data.keys()].filter(id => !read.has(id) && !hung.has(id));
  const standing = new Set([...runs.values()].map(b => b.unit));
  const idle = [...units.keys()].filter(id => !standing.has(id));
  const models = graph.nodes.filter(n => n.role === "model");
  return { works, runs, data, units, models, loose, idle, rank, nodes };
}

/** What a workflow reads of a dataset: the steps that name it, and the files they name. */
function readOf(w: WorkItem, dataset: string): Read {
  const read: Read = { data: dataset, steps: [], files: [] };
  for (const step of w.steps)
    for (const name of namesIn(step.settings ?? {}))
      if (name.base === dataset) {
        if (!read.steps.includes(step.id)) read.steps.push(step.id);
        if (name.path && !read.files.includes(name.path)) read.files.push(name.path);
      }
  return read;
}

/** The node of the first step that names a resource: what a step's row points at. */
export function namedBy(step: GraphStep): { base: string; path?: string }[] {
  const named = namesIn(step.settings ?? {});
  if (step.type.startsWith("texera://")) named.unshift({ base: baseOf(step.type) });
  return named;
}

/** What a thing touches on the graph: what lights up with it. */
export function touching(view: GraphView, id: string): Set<string> {
  const near = new Set([id]);
  for (const w of view.works) {
    const bs = w.runs.map(r => view.runs.get(r)).filter((b): b is RunItem => !!b);
    const mine = [
      w.id,
      ...w.reads.map(r => r.data),
      ...w.models,
      ...w.uses.map(u => u.uri),
      ...bs.flatMap(b => [b.id, b.unit, ...b.results]),
    ];
    if (id === w.id || w.models.includes(id) || w.uses.some(u => u.uri === id)) {
      for (const x of mine) near.add(x);
      continue;
    }
    if (w.reads.some(r => r.data === id)) {
      near.add(w.id);
      for (const b of bs) near.add(b.id);
    }
    for (const b of bs) {
      if (id === b.id) for (const x of [w.id, b.unit, ...w.reads.map(r => r.data), ...w.models, ...b.results]) near.add(x);
      else if (id === b.unit) for (const x of [b.id, w.id]) near.add(x);
      else if (b.results.includes(id)) for (const x of [b.id, w.id, b.unit]) near.add(x);
    }
  }
  return near;
}

/** What a thing is to the rest of the graph, in groups a person reads: what to go to next. */
export function relationsOf(view: GraphView, id: string): { label: string; ids: string[] }[] {
  const out: { label: string; ids: string[] }[] = [];
  const add = (label: string, ids: string[]) => {
    const unique = ids.filter((x, i) => ids.indexOf(x) === i && x !== SOMEWHERE);
    if (unique.length) out.push({ label, ids: unique });
  };
  const boxesOf = (w: WorkItem) => w.runs.map(r => view.runs.get(r)).filter((b): b is RunItem => !!b);
  const w = view.works.find(x => x.id === id);
  if (w) {
    add(
      "Reads",
      w.reads.map(r => r.data)
    );
    add("Uses", [...w.models, ...w.uses.map(u => u.uri)]);
    add("Executions", w.runs);
    add(
      "Made",
      boxesOf(w).flatMap(b => b.results)
    );
    return out;
  }
  const box = view.runs.get(id);
  if (box) {
    const of = view.works.find(x => x.id === box.work);
    add("Of", [box.work]);
    add("On", [box.unit]);
    add("Read", of?.reads.map(r => r.data) ?? []);
    add("Made", box.results);
    return out;
  }
  if (view.units.has(id)) {
    add(
      "Executions on it",
      [...view.runs.values()].filter(b => b.unit === id).map(b => b.id)
    );
    return out;
  }
  if (view.data.has(id)) {
    add(
      "Made by",
      [...view.runs.values()].filter(b => b.results.includes(id)).map(b => b.id)
    );
    add(
      "Read by",
      view.works.filter(x => x.reads.some(r => r.data === id)).map(x => x.id)
    );
    return out;
  }
  add(
    "Used by",
    view.works.filter(x => x.models.includes(id) || x.uses.some(u => u.uri === id)).map(x => x.id)
  );
  return out;
}

/** A thing's name on the graph: a node's, a plan item's, or an execution's workflow and unit. */
export function nameOf(view: GraphView, id: string): string {
  const box = view.runs.get(id);
  if (box) {
    const unit = box.unit === SOMEWHERE ? "" : nameOf(view, box.unit);
    return `${nameOf(view, box.work)}${unit ? ` on ${unit}` : ""}`;
  }
  const w = view.works.find(x => x.id === id);
  return (
    view.nodes.get(id)?.name ??
    w?.planned?.name ??
    view.data.get(id)?.planned?.name ??
    view.units.get(id)?.planned?.name ??
    id
  );
}

/** What a comment on a thing of the graph is about; undefined for what is only planned. */
export function commentTarget(view: GraphView, id: string): { uri: string; name: string } | undefined {
  const box = view.runs.get(id);
  if (box) return box.run ? { uri: box.run.uri, name: `execution of ${nameOf(view, box.work)}` } : undefined;
  const n = view.nodes.get(id);
  return n ? { uri: n.uri, name: n.name } : undefined;
}
