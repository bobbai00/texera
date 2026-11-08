// Going into a thing on the graph beside a chat: the graph gives way to the thing's own view, and
// a trail says how the person got there, so they can always go back. A dataset, a workflow, a
// model, a function and a unit show the view they have everywhere; a run box shows its runs, a
// table the rows its run kept, and what the plan has not made yet what the plan said. Pure, so it
// is tested on its own.

import type { ResourceRef } from "../types";
import { parseUri, uriOf } from "../uri";
import { type GraphView, nameOf, SOMEWHERE } from "./model";

export type FocusEntry =
  /** A resource's own view; `id` is the graph's node for it, when it has one. */
  | { kind: "resource"; ref: ResourceRef; id?: string; title?: string }
  /** A run box: a workflow's runs on one unit. */
  | { kind: "run"; id: string; title: string }
  /** A table a run made: its rows. */
  | { kind: "table"; id: string; title: string }
  /** Something the plan said it would make and has not. */
  | { kind: "planned"; id: string; title: string };

/** What going into a thing on the graph shows; undefined when there is nothing to go into. */
export function entryFor(view: GraphView, id: string): FocusEntry | undefined {
  if (id === SOMEWHERE) return undefined;
  if (view.runs.has(id)) return { kind: "run", id, title: nameOf(view, id) };
  const planned =
    view.works.find(w => w.id === id)?.planned ?? view.data.get(id)?.planned ?? view.units.get(id)?.planned;
  if (planned) return { kind: "planned", id, title: planned.name };
  const n = view.nodes.get(id);
  const parsed = n ? parseUri(n.uri) : undefined;
  if (!n || !parsed) return undefined;
  if (parsed.subresource?.startsWith("operators/")) return { kind: "table", id, title: n.name };
  return {
    kind: "resource",
    ref: { kind: parsed.ref.kind, rid: parsed.ref.rid, parent: parsed.ref.parent },
    id,
    title: n.name,
  };
}

/** What a view opens from inside the graph: the graph's own entry when the graph has the thing. */
export function entryForRef(view: GraphView, ref: ResourceRef): FocusEntry {
  const uri = uriOf({ kind: ref.kind, rid: ref.rid, parent: ref.parent });
  const plain = uriOf({ kind: ref.kind, rid: ref.rid });
  const id = view.nodes.has(uri) ? uri : view.nodes.has(plain) ? plain : undefined;
  const entry = id ? entryFor(view, id) : undefined;
  // A version opens at that version; the graph's node still says what it is to the rest.
  if (entry?.kind === "resource" && ref.vno !== undefined)
    return { ...entry, ref: { ...entry.ref, vno: ref.vno }, title: `${entry.title} v${ref.vno}` };
  return entry ?? { kind: "resource", ref };
}

/** What makes two entries the same place. */
export const keyOf = (e: FocusEntry) =>
  e.kind === "resource" ? `${e.ref.kind}:${e.ref.rid}@${e.ref.vno ?? ""}` : `${e.kind}:${e.id}`;

/** The trail after going to an entry: to one already on it goes back to it, so the trail never loops. */
export function pushed(trail: FocusEntry[], entry: FocusEntry): FocusEntry[] {
  const i = trail.findIndex(e => keyOf(e) === keyOf(entry));
  return i >= 0 ? trail.slice(0, i + 1) : [...trail, entry];
}
