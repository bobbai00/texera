// What a chat's graph draws, read from what the catalog returns. Arrows are for data only: a
// workflow reads datasets and makes tables. What a workflow uses, its models and functions,
// rides on its card, and the unit it ran on, or will run on, is a frame around it. Data and work
// stand in ranks of dependency, data even and work odd. Each item of the latest plan stands where
// the thing it names will stand: a workflow at the end of the work, a unit as a frame, a dataset
// beside the work of its plan, a run on the card of the workflow it runs. Pure, so it is tested
// on its own.

import type { ConversationGraph, GraphNode, GraphStep, PlannedItem } from "@texera/catalog-client/types";

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

/** A computing unit, the frame of what ran or will run on it. */
export interface UnitItem {
  id: string;
  node?: GraphNode;
  planned?: PlannedItem;
}

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
  /** The models and functions it uses. */
  uses: GraphNode[];
  /** Models and functions the plan will make, which it will likely use. */
  plannedUses: PlannedItem[];
  /** The tables its newest run made in the order of its steps, then what the plan will make beside it. */
  results: string[];
  /** The unit it ran on, or will run on. */
  unit?: string;
  /** A run of it the plan will start. */
  plannedRun?: PlannedItem;
}

export interface GraphView {
  works: WorkItem[];
  data: Map<string, DataItem>;
  units: Map<string, UnitItem>;
  /** Data no workflow on the graph reads or made: it stands at the end of the inputs. */
  loose: string[];
  /** Units nothing has run on yet, and none will by the plan. */
  idle: string[];
  /** Each item's rank: data even, work odd, each past what it depends on. */
  rank: Map<string, number>;
  /** Every node of the graph by its URI, models and functions too. */
  nodes: Map<string, GraphNode>;
}

export const plannedId = (p: PlannedItem) => `planned:${p.kind ?? ""}:${p.name}`;

/** The resource a URI names, without a version or a path inside it. */
export const baseOf = (uri: string) => /^texera:\/\/[a-z-]+\/[0-9a-f-]{36}/.exec(uri)?.[0] ?? uri;

/** The texera:// names a step's settings hold, with the path of a file when one is named. */
function namesIn(value: unknown, out: { base: string; path?: string }[] = []): { base: string; path?: string }[] {
  if (typeof value === "string" && value.startsWith("texera://")) {
    const path = /\/files\/(.+)$/.exec(value)?.[1];
    out.push({ base: baseOf(value), path: path ? decodeURIComponent(path) : undefined });
  } else if (Array.isArray(value)) for (const v of value) namesIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) namesIn(v, out);
  return out;
}

/** The view of a chat's graph: its workflows with what they read, use, make and run on. */
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
    .map(n => ({ id: n.uri, node: n, steps: n.steps ?? [], reads: [], uses: [], plannedUses: [], results: [] }));
  const work = new Map(works.map(w => [w.id, w]));

  for (const e of graph.edges) {
    const w = work.get(e.relation === "makes" || e.relation === "runsOn" ? e.from : e.to);
    if (!w) continue;
    if (e.relation === "reads" && data.has(e.from)) w.reads.push(readOf(w, e.from));
    if (e.relation === "uses") {
      const tool = nodes.get(e.from);
      if (tool && !w.uses.includes(tool)) w.uses.push(tool);
    }
    if (e.relation === "makes" && data.has(e.to)) w.results.push(e.to);
    if (e.relation === "runsOn" && units.has(e.to)) w.unit = e.to;
  }
  for (const w of works) {
    const at = (id: string) => {
      const i = w.steps.findIndex(s => s.id === nodes.get(id)?.step);
      return i < 0 ? w.steps.length : i;
    };
    w.results.sort((a, b) => at(a) - at(b));
    for (const r of w.reads) {
      const d = data.get(r.data) as DataItem;
      for (const f of r.files) if (!d.files.includes(f)) d.files.push(f);
    }
  }

  // The latest plan: each item where what it names will stand.
  const planned = graph.planned;
  const plannedUnit = planned.find(p => p.kind === "computing-unit");
  if (plannedUnit) units.set(plannedId(plannedUnit), { id: plannedId(plannedUnit), planned: plannedUnit });
  const ranOn = new Set(works.map(w => w.unit).filter(Boolean));
  // A fresh unit, made and not run on yet: what the plan's work will run on, when it is the one.
  const fresh = [...units.values()].filter(u => u.node?.made && !ranOn.has(u.id));
  const target = plannedUnit ? plannedId(plannedUnit) : fresh.length === 1 ? fresh[0]?.id : undefined;
  for (const p of planned.filter(p => p.kind === "workflow")) {
    const w: WorkItem = {
      id: plannedId(p),
      planned: p,
      steps: [],
      reads: [],
      uses: [],
      plannedUses: [],
      results: [],
      unit: target,
    };
    works.push(w);
    work.set(w.id, w);
  }
  for (const w of works) if (!w.unit && !w.node?.runs && target && w.node?.made) w.unit = target;
  const last = works.at(-1);
  const ofPlan =
    works.find(w => w.planned) ??
    [...works].reverse().find(w => w.node?.turn && w.node.turn === planned[0]?.turn) ??
    last;
  for (const p of planned) {
    if (p.kind === "dataset") {
      const id = plannedId(p);
      data.set(id, { id, planned: p, files: [] });
      if (ofPlan) ofPlan.results.push(id);
    } else if (p.kind === "execution") {
      const named = works.find(w => w.node && p.name.toLowerCase().includes(w.node.name.toLowerCase()));
      const on = named ?? last;
      if (on && !on.plannedRun) on.plannedRun = p;
    } else if (p.kind === "operator" || p.kind === "model") {
      ofPlan?.plannedUses.push(p);
    }
  }

  // Ranks: data even, work odd, each past what it depends on.
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
      for (const r of w.results) {
        const at = (rank.get(w.id) ?? 1) + 1;
        if (at > (rank.get(r) ?? 0)) {
          rank.set(r, at);
          moved = true;
        }
      }
    }
  }
  for (const u of units.keys()) rank.set(u, 1);

  const touched = new Set(works.flatMap(w => [...w.reads.map(r => r.data), ...w.results]));
  const loose = [...data.keys()].filter(id => !touched.has(id));
  const framing = new Set(works.map(w => w.unit).filter(Boolean));
  const idle = [...units.keys()].filter(id => !framing.has(id));
  return { works, data, units, loose, idle, rank, nodes };
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
