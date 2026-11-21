// Going into a thing on the graph beside a chat: the graph gives way to the thing's own view, and
// a trail says how the person got there, so they can always go back. A dataset, a workflow, a
// model, a function and a unit show the view they have everywhere; a version of one, that view
// at the version, so a workflow version opens its canvas; an execution its own view, a result
// the rows its execution kept, and what the plan has not made yet what the plan said. Pure, so it
// is tested on its own.

import type { ResourceRef } from "../types";
import { parseUri, uriOf } from "../uri";
import { type GraphView, nameOf, rowId } from "./model";

export type FocusEntry =
  /** A resource's own view, at a version when `ref.vno` is set; `id` is the graph's box or row for it. */
  | { kind: "resource"; ref: ResourceRef; id?: string; title?: string }
  /** An execution, or the one the plan will start. */
  | { kind: "run"; id: string; title: string }
  /** A result an execution kept: its rows. */
  | { kind: "table"; id: string; title: string }
  /** Something the plan said it would make and has not. */
  | { kind: "planned"; id: string; title: string };

/** What going into a thing on the graph shows; undefined when there is nothing to go into. */
export function entryFor(view: GraphView, id: string): FocusEntry | undefined {
  if (view.runs.has(id)) return { kind: "run", id, title: nameOf(view, id) };
  const result = view.results.get(id);
  if (result)
    return result.planned ? { kind: "planned", id, title: result.title } : { kind: "table", id, title: result.title };
  const row = view.rows.get(id);
  const box = view.boxes.get(row?.box ?? id);
  if (box?.planned) return { kind: "planned", id, title: box.planned.name };
  const node = box?.node ?? view.functions.get(id);
  const uri = node?.uri ?? view.units.get(id)?.uri;
  const parsed = uri ? parseUri(uri) : undefined;
  if (!parsed || node?.readable === false) return undefined;
  const ref: ResourceRef = {
    kind: parsed.ref.kind,
    rid: parsed.ref.rid,
    ...(parsed.ref.parent ? { parent: parsed.ref.parent } : {}),
  };
  return { kind: "resource", ref: row ? { ...ref, vno: row.vno } : ref, id, title: nameOf(view, id) };
}

/** What a view opens from inside the graph: the graph's own entry when the graph has the thing. */
export function entryForRef(view: GraphView, ref: ResourceRef): FocusEntry {
  const whole = uriOf({ kind: ref.kind, rid: ref.rid, parent: ref.parent });
  const plain = uriOf({ kind: ref.kind, rid: ref.rid });
  const id = [whole, plain].find(
    u => view.boxes.has(u) || view.functions.has(u) || view.units.has(u) || view.runs.has(u)
  );
  if (id && ref.vno !== undefined && view.rows.has(rowId(id, ref.vno)))
    return entryFor(view, rowId(id, ref.vno)) ?? { kind: "resource", ref };
  const entry = id ? entryFor(view, id) : undefined;
  // A version the graph does not draw opens at that version still.
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
