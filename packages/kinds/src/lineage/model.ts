// The lineage of a resource as a graph to draw. The catalog keeps lineage as arrows between
// names (an execution used a file, a port produced a table, a version names another resource);
// a person wants to see resources and what happened between them. This turns the one into the
// other, at two levels: resources (a dataset, a workflow, an execution), and data flow (the
// file, the version that ran, each result). Data runs left to right: what was read is where an
// arrow starts, what was made is where it ends.

import type { Edge } from "@texera/catalog-client/types";
import type { ResourceRef } from "../types";
import { parseUri, uriOf } from "../uri";

export type Level = "resources" | "flow";

/** How many executions of one workflow stand as cards of their own; earlier ones fold into one card. */
export const RECENT = 2;

/** What the graph says of an execution: the catalog's list of a workflow's executions has it. */
export interface ExecutionFacts {
  name: string;
  phase: string;
  /** The version of the workflow it ran. */
  vno?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface LineageNode {
  /** The name the card stands for; unique in a graph. */
  id: string;
  /**
   * `resource`: a resource, or one version of it when `ref.vno` is set. `file`: a file of a
   * version. `execution`. `result`: what one output port of an execution produced. `fold`: the
   * earlier executions of a workflow, as one card.
   */
  type: "resource" | "file" | "execution" | "result" | "fold";
  /** Whether the card is the resource whose page shows the graph. */
  root: boolean;
  /** What a click opens: the resource, the version of a file, the execution of a result. */
  ref?: ResourceRef;
  /** A resource: the versions of it the arrows name, ascending. */
  versions?: number[];
  /** A file: its path in the version. */
  path?: string;
  /** An execution: what the catalog says of it, and how many results it produced. */
  execution?: ExecutionFacts;
  results?: number;
  /** A result: the operator and the port it came out of, its rows, and the table that holds it. */
  operator?: string;
  port?: string;
  rows?: number;
  table?: string;
  /** A fold: how many executions it stands for. */
  count?: number;
}

/** The catalog's relations, and `ran`: an execution is a run of a workflow version. */
export type ArrowRelation = Edge["relation"] | "ran";

export interface LineageArrow {
  id: string;
  from: string;
  to: string;
  relation: ArrowRelation;
  /** The words on the arrow, and what they are about ("read" "by scan", "read" "2 files"). */
  label: string;
  detail?: string;
  /** Named in a spec, with no execution that did it: drawn dashed. */
  declared?: boolean;
}

export interface LineageGraph {
  nodes: LineageNode[];
  arrows: LineageArrow[];
  /** How many executions stand folded. */
  folded: number;
}

export interface LineageInput {
  /** The resource whose page this is. */
  root: ResourceRef;
  /** Every arrow the catalog walked to from it, upstream and downstream. */
  edges: Edge[];
  /** The executions that still exist, by rid: one the catalog no longer lists is left out. */
  executions: ReadonlyMap<string, ExecutionFacts>;
  level: Level;
  /** Every execution as its own card, none folded. */
  showAll?: boolean;
  recent?: number;
}

/** An operator's name as a person reads it: the editor names an operator `<type>-operator-<uuid>`. */
export function operatorName(id: string): string {
  return id.replace(/-operator-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, "");
}

const PORT = /^operators\/([^/]+)\/ports\/([^/]+)$/;

type Place =
  | { type: "execution"; uri: string; ref: ResourceRef }
  | { type: "port"; uri: string; execution: string; ref: ResourceRef; operator: string; port: string }
  | { type: "file"; uri: string; ref: ResourceRef; path: string }
  | { type: "resource"; uri: string; ref: ResourceRef }
  | { type: "foreign"; uri: string };

/** What a name in an arrow names. */
function placeOf(uri: string): Place {
  const parsed = parseUri(uri);
  if (!parsed) return { type: "foreign", uri };
  const { ref, subresource } = parsed;
  if (ref.kind === "execution") {
    const execution = uriOf(ref, { version: false });
    const port = subresource ? PORT.exec(subresource) : null;
    return port
      ? { type: "port", uri, execution, ref, operator: port[1] as string, port: port[2] as string }
      : { type: "execution", uri: execution, ref };
  }
  if (subresource?.startsWith("files/")) return { type: "file", uri, ref, path: subresource.slice("files/".length) };
  return { type: "resource", uri: uriOf(ref), ref };
}

/** The resource a name is of or in, executions aside: its URI without version, file or port. */
function resourceOf(uri: string): string | undefined {
  const ref = parseUri(uri)?.ref;
  return ref && ref.kind !== "execution" ? uriOf(ref, { version: false }) : undefined;
}

/** The catalog resources the arrows name, executions aside, each once: what the cards will be of. */
export function resourcesNamed(edges: readonly Edge[]): string[] {
  const names = new Set<string>();
  for (const e of edges)
    for (const uri of [e.from, e.to]) {
      const resource = resourceOf(uri);
      if (resource) names.add(resource);
    }
  return [...names];
}

/** The arrows that touch no resource that is gone: what a deleted resource named or was named by goes with it. */
export function withoutGone(edges: readonly Edge[], gone: ReadonlySet<string>): Edge[] {
  const there = (uri: string) => {
    const resource = resourceOf(uri);
    return resource === undefined || !gone.has(resource);
  };
  return edges.filter(e => there(e.from) && there(e.to));
}

/** An execution the catalog still has. */
interface Run {
  uri: string;
  ref: ResourceRef;
  facts: ExecutionFacts;
}

interface Draft {
  id: string;
  from: string;
  to: string;
  relation: ArrowRelation;
  label: string;
  declared: boolean;
  files: Set<string>;
  operators: Set<string>;
  versions: Set<number>;
  times: number;
}

const basename = (path: string) => path.split("/").at(-1) ?? path;
const numberOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const textOf = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The graph of a resource's lineage at one level. */
export function buildLineage({
  root,
  edges,
  executions,
  level,
  showAll = false,
  recent = RECENT,
}: LineageInput): LineageGraph {
  const flow = level === "flow";
  const runs = new Map<string, Run>();
  const runOf = (place: Place): Run | undefined => {
    if (place.type !== "execution" && place.type !== "port") return undefined;
    const uri = place.type === "port" ? place.execution : place.uri;
    const facts = executions.get(place.ref.rid);
    if (!facts) return undefined;
    const known = runs.get(uri);
    if (known) return known;
    const run: Run = {
      uri,
      ref: { kind: "execution", rid: place.ref.rid, ...(place.ref.parent ? { parent: place.ref.parent } : {}) },
      facts,
    };
    runs.set(uri, run);
    return run;
  };

  // What the arrows say, of the executions that still exist.
  const reads: { run: Run; source: Place; operator?: string }[] = [];
  const made = new Map<string, { port: Place & { type: "port" }; rows?: number; table?: string }[]>();
  const named: { by: Place; target: Place }[] = [];
  const saved: { run: Run; port: Place & { type: "port" }; version: Place }[] = [];
  const reuses: {
    later: Run;
    laterPort: Place & { type: "port" };
    earlier: Run;
    earlierPort: Place & { type: "port" };
  }[] = [];
  for (const e of edges) {
    const from = placeOf(e.from);
    const to = placeOf(e.to);
    if (e.relation === "used") {
      const run = runOf(from);
      if (run) reads.push({ run, source: to, operator: textOf(e.attrs?.operatorID) });
    } else if (e.relation === "produced") {
      const run = runOf(from);
      if (run && from.type === "port")
        push(made, run.uri, { port: from, rows: numberOf(e.attrs?.rows), table: textOf(e.attrs?.table) });
    } else if (e.relation === "references") {
      named.push({ by: from, target: to });
    } else if (e.relation === "derivedFrom") {
      const run = runOf(to);
      if (run && to.type === "port") saved.push({ run, port: to, version: from });
    } else if (e.relation === "reused") {
      const later = runOf(from);
      const earlier = runOf(to);
      if (later && earlier && from.type === "port" && to.type === "port")
        reuses.push({ later, laterPort: from, earlier, earlierPort: to });
    }
  }

  // Which executions stand as cards: the recent ones of each workflow, the page's own, and any
  // whose result went somewhere. The rest of a workflow's fold into one card.
  const isRootRun = (run: Run) => root.kind === "execution" && run.ref.rid === root.rid;
  const kept = new Set<string>([...saved.map(s => s.run.uri), ...reuses.flatMap(r => [r.later.uri, r.earlier.uri])]);
  const byWorkflow = new Map<string, Run[]>();
  for (const run of runs.values()) push(byWorkflow, run.ref.parent ?? "", run);
  const standing: Run[] = [];
  const folds = new Map<string, Run[]>();
  for (const [workflow, list] of byWorkflow) {
    list.sort((a, b) => b.facts.createdAt.localeCompare(a.facts.createdAt) || a.uri.localeCompare(b.uri));
    list.forEach((run, i) => {
      if (showAll || !workflow || i < recent || kept.has(run.uri) || isRootRun(run)) standing.push(run);
      else push(folds, workflow, run);
    });
  }
  standing.sort((a, b) => b.facts.createdAt.localeCompare(a.facts.createdAt) || a.uri.localeCompare(b.uri));

  // Cards are kept in bands, in the order a reader meets them: what was read, what read it,
  // the executions, their results, what was saved from those.
  const bands: LineageNode[][] = [[], [], [], [], []];
  const cards = new Map<string, LineageNode>();
  const card = (band: number, node: LineageNode): LineageNode => {
    const had = cards.get(node.id);
    if (!had) {
      cards.set(node.id, node);
      bands[band]?.push(node);
      return node;
    }
    if (node.versions?.length)
      had.versions = [...new Set([...(had.versions ?? []), ...node.versions])].sort((a, b) => a - b);
    return had;
  };
  const isRootResource = (ref: ResourceRef, exact: boolean) =>
    root.kind !== "execution" &&
    ref.kind === root.kind &&
    ref.rid === root.rid &&
    (!exact || root.vno === undefined || ref.vno === undefined || ref.vno === root.vno);
  const versionsOf = (ref: ResourceRef) => (ref.vno !== undefined ? [ref.vno] : []);
  /** A resource, whatever version or file of it was named. */
  const resource = (ref: ResourceRef): LineageNode => {
    const whole: ResourceRef = { kind: ref.kind, rid: ref.rid, ...(ref.parent ? { parent: ref.parent } : {}) };
    return {
      id: uriOf(whole),
      type: "resource",
      root: isRootResource(ref, false),
      ref: whole,
      versions: versionsOf(ref),
    };
  };
  /** One version of a resource, or the resource when no version was named. */
  const version = (ref: ResourceRef): LineageNode => ({
    id: uriOf(ref),
    type: "resource",
    root: isRootResource(ref, true),
    ref,
    versions: versionsOf(ref),
  });
  /** The card a named resource, version or file stands on at this level. */
  const cardOf = (band: number, place: Place): LineageNode | undefined => {
    if (place.type === "file")
      return card(
        band,
        flow
          ? { id: place.uri, type: "file", root: isRootResource(place.ref, true), ref: place.ref, path: place.path }
          : resource(place.ref)
      );
    if (place.type === "resource") return card(band, flow ? version(place.ref) : resource(place.ref));
    return undefined;
  };
  /** The workflow an execution ran: the version, once it is known and the level shows versions. */
  const workflowOf = (run: Run): LineageNode | undefined => {
    if (!run.ref.parent) return undefined;
    const ref: ResourceRef = {
      kind: "workflow",
      rid: run.ref.parent,
      ...(run.facts.vno !== undefined ? { vno: run.facts.vno } : {}),
    };
    return card(1, flow ? version(ref) : resource(ref));
  };
  const executionOf = (run: Run): LineageNode =>
    card(2, {
      id: run.uri,
      type: "execution",
      root: isRootRun(run),
      ref: run.ref,
      execution: run.facts,
      results: made.get(run.uri)?.length ?? 0,
    });

  const drafts = new Map<string, Draft>();
  const draw = (
    from: LineageNode | undefined,
    to: LineageNode | undefined,
    relation: ArrowRelation,
    label: string,
    declared = false
  ): Draft | undefined => {
    if (!from || !to || from.id === to.id) return undefined;
    const id = `${relation}|${from.id}|${to.id}`;
    const had = drafts.get(id);
    if (had) return had;
    const draft: Draft = {
      id,
      from: from.id,
      to: to.id,
      relation,
      label,
      declared,
      files: new Set(),
      operators: new Set(),
      versions: new Set(),
      times: 0,
    };
    drafts.set(id, draft);
    return draft;
  };

  // A file is read by the workflow whose execution read it: the arrow ends on the workflow, and
  // the execution hangs off the workflow. An execution the catalog files under no workflow
  // takes the arrow itself.
  for (const read of reads) {
    const source = cardOf(0, read.source);
    const reader =
      workflowOf(read.run) ??
      (kept.has(read.run.uri) || standing.includes(read.run) ? executionOf(read.run) : undefined);
    const arrow = draw(source, reader, "used", "read");
    if (!arrow) continue;
    if (read.source.type === "file") arrow.files.add(read.source.path);
    if (read.operator) arrow.operators.add(operatorName(read.operator));
  }
  // What a spec names: from the thing named to the one that names it. Where an execution
  // read it, the arrow above already says more.
  for (const { by, target } of named) {
    const from = cardOf(0, target);
    const to = cardOf(1, by);
    if (!from || !to || drafts.has(`used|${from.id}|${to.id}`)) continue;
    draw(from, to, "references", "referenced by", true);
  }
  for (const run of standing) draw(workflowOf(run), executionOf(run), "ran", "ran");
  for (const [workflow, list] of folds) {
    const fold = card(2, {
      id: `fold:${uriOf({ kind: "workflow", rid: workflow })}`,
      type: "fold",
      root: false,
      ref: { kind: "workflow", rid: workflow },
      count: list.length,
    });
    for (const run of list) draw(workflowOf(run), fold, "ran", "ran");
  }

  /** The card of what a port produced, hanging off its execution. */
  const resultOf = (run: Run, port: Place & { type: "port" }, rows?: number, table?: string): LineageNode => {
    const fresh = !cards.has(port.uri);
    const result = card(3, {
      id: port.uri,
      type: "result",
      root: false,
      ref: run.ref,
      operator: operatorName(port.operator),
      port: port.port,
      ...(rows !== undefined ? { rows } : {}),
      ...(table !== undefined ? { table } : {}),
    });
    if (fresh) draw(executionOf(run), result, "produced", "produced");
    return result;
  };
  if (flow) for (const run of standing) for (const m of made.get(run.uri) ?? []) resultOf(run, m.port, m.rows, m.table);
  for (const s of saved) {
    const arrow = draw(
      flow ? resultOf(s.run, s.port) : executionOf(s.run),
      cardOf(4, s.version),
      "derivedFrom",
      "saved as"
    );
    if (arrow && s.version.type !== "foreign" && s.version.ref.vno !== undefined) arrow.versions.add(s.version.ref.vno);
  }
  for (const r of reuses) {
    const arrow = flow
      ? draw(resultOf(r.earlier, r.earlierPort), resultOf(r.later, r.laterPort), "reused", "reused")
      : draw(executionOf(r.earlier), executionOf(r.later), "reused", "reused");
    if (arrow) arrow.times++;
  }

  // The versions of one resource stand together, the newest first.
  const first = new Map<string, number>();
  const whole = (n: LineageNode) => (n.ref ? uriOf(n.ref, { version: false }) : n.id);
  bands[1]?.forEach((n, i) => {
    if (!first.has(whole(n))) first.set(whole(n), i);
  });
  bands[1]?.sort(
    (a, b) => (first.get(whole(a)) ?? 0) - (first.get(whole(b)) ?? 0) || (b.ref?.vno ?? 0) - (a.ref?.vno ?? 0)
  );

  const detailOf = (d: Draft): string | undefined => {
    if (d.relation === "used") {
      if (flow) return d.operators.size ? `by ${[...d.operators].join(", ")}` : undefined;
      const files = [...new Set([...d.files])];
      return files.length === 1 ? basename(files[0] as string) : files.length > 1 ? `${files.length} files` : undefined;
    }
    if (d.relation === "derivedFrom" && !flow)
      return d.versions.size === 1
        ? `v${[...d.versions][0]}`
        : d.versions.size > 1
          ? `${d.versions.size} versions`
          : undefined;
    if (d.relation === "reused" && !flow) return d.times > 1 ? `${d.times} results` : undefined;
    return undefined;
  };
  return {
    nodes: bands.flat(),
    arrows: [...drafts.values()].map(d => {
      const detail = detailOf(d);
      return {
        id: d.id,
        from: d.from,
        to: d.to,
        relation: d.relation,
        label: d.label,
        ...(detail ? { detail } : {}),
        ...(d.declared ? { declared: true } : {}),
      };
    }),
    folded: [...folds.values()].reduce((n, list) => n + list.length, 0),
  };
}
