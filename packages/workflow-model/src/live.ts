// A workflow as a live document: the Yjs form of a spec that several people edit at once.
//
// The catalog's versions stay the truth; this is the working copy of one. Operators and links
// are maps keyed by id, so two edits never collide on an array position. An operator is a map
// of its fields and its properties a map of their own, so two people changing different
// properties of one operator both keep their change; a link is one value. Where operators sit
// on the canvas is in the document too, one layout for everyone, but not in the spec: a
// version records what runs, not how it is drawn.
//
// Everything that writes goes through `applyChange`: a person's edit (the change from what
// the document holds to what they made of it), a version written elsewhere (the change from
// the version the document was at to the new one), and the first load (the change from
// nothing). It writes only what differs, so a version arriving from outside leaves a person's
// unsaved edits of other fields in place.

import * as Y from "yjs";
import { reconcilePositions } from "./layout";
import { same } from "./same";
import type { Point, Positions, WorkflowLink, WorkflowOperator, WorkflowSpec } from "./types";

// Whoever holds a document compares specs the way the document does.
export { same };

const OPERATORS = "operators";
const LINKS = "links";
const SETTINGS = "settings";
// Where each operator's card sits. Operators were small icons once, placed closer together
// than a card is wide, and their places were kept as `positions`: those are a leftover.
const POSITIONS = "places";
const FORMER_POSITIONS = "positions";
const PROPERTIES = "operatorProperties";

/** The spec's fields that are neither operators nor links. */
type Setting = Exclude<keyof WorkflowSpec, "operators" | "links">;
// Every one of them, or this does not compile: a field the document did not keep would be
// dropped from the next version without a word.
const SETTINGS_KEPT: Record<Setting, true> = { defaultEnvironment: true, defaultComputingUnit: true, defaultWarehouse: true };
const SETTING_KEYS = Object.keys(SETTINGS_KEPT) as Setting[];

type Json = Record<string, unknown>;

const byId = <T>(items: T[], id: (item: T) => string) => new Map(items.map(item => [id(item), item]));

/** Writes into a map what differs between two objects: changed keys are set, missing ones deleted. */
function writeDifference(map: Y.Map<unknown>, was: Json, now: Json, skip: string[] = []): void {
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (skip.includes(key) || same(was[key], now[key])) continue;
    if (now[key] === undefined) map.delete(key);
    else map.set(key, now[key]);
  }
}

/**
 * Applies to the document what changed from one spec to another. What the document holds
 * beyond `from` (an edit nobody saved yet) stays, unless the change touches the same field.
 * A change to an operator the document no longer has is dropped: the removal stands.
 */
export function applyChange(doc: Y.Doc, from: WorkflowSpec, to: WorkflowSpec, origin?: unknown): void {
  doc.transact(() => {
    const operators = doc.getMap<Y.Map<unknown>>(OPERATORS);
    const positions = doc.getMap<Point>(POSITIONS);
    const before = byId(from.operators, o => o.operatorID);
    const after = byId(to.operators, o => o.operatorID);
    for (const id of before.keys()) {
      if (after.has(id)) continue;
      operators.delete(id);
      positions.delete(id);
    }
    for (const [id, now] of after) {
      const was = before.get(id);
      let live = operators.get(id);
      if (!was) {
        live = new Y.Map<unknown>();
        live.set(PROPERTIES, new Y.Map<unknown>());
        operators.set(id, live);
      }
      if (!live) continue;
      writeDifference(live, (was ?? {}) as Json, now as Json, ["operatorID", PROPERTIES]);
      writeDifference(live.get(PROPERTIES) as Y.Map<unknown>, was?.operatorProperties ?? {}, now.operatorProperties ?? {});
    }

    const links = doc.getMap<Omit<WorkflowLink, "linkID">>(LINKS);
    const linksBefore = byId(from.links, l => l.linkID);
    const linksAfter = byId(to.links, l => l.linkID);
    for (const id of linksBefore.keys()) if (!linksAfter.has(id)) links.delete(id);
    for (const [id, { linkID: _, ...ends }] of linksAfter) {
      const was = linksBefore.get(id);
      if (!was || !same(was.source, ends.source) || !same(was.target, ends.target)) links.set(id, ends);
    }

    writeDifference(doc.getMap<unknown>(SETTINGS), from as unknown as Json, to as unknown as Json, ["operators", "links"]);
  }, origin);
}

/** Makes the document say a spec: the change from what it holds now. */
export function applySpec(doc: Y.Doc, to: WorkflowSpec, origin?: unknown): void {
  applyChange(doc, specOf(doc), to, origin);
}

/** Ids in the order a version had them, then the ones it did not have, by id: the same on every replica. */
function ordered(ids: string[], previous: string[] = []): string[] {
  const present = new Set(ids);
  const known = previous.filter(id => present.has(id));
  const seen = new Set(known);
  return [...known, ...ids.filter(id => !seen.has(id)).sort()];
}

/**
 * The spec a document holds. Operators and links come in the order of `previous` (the version
 * the document was last saved as), with what is new after them. A link whose operator is gone,
 * which two people can produce by removing and connecting at the same moment, is left out.
 */
export function specOf(doc: Y.Doc, previous?: WorkflowSpec): WorkflowSpec {
  const live = doc.getMap<Y.Map<unknown>>(OPERATORS);
  const operators = ordered([...live.keys()], previous?.operators.map(o => o.operatorID)).map(id => {
    const { [PROPERTIES]: properties, ...fields } = (live.get(id) as Y.Map<unknown>).toJSON();
    return { operatorID: id, ...fields, operatorProperties: properties ?? {} } as WorkflowOperator;
  });
  const linked = doc.getMap<Omit<WorkflowLink, "linkID">>(LINKS);
  const links = ordered([...linked.keys()], previous?.links.map(l => l.linkID))
    .map(id => ({ linkID: id, ...(linked.get(id) as Omit<WorkflowLink, "linkID">) }))
    .filter(l => live.has(l.source.operatorID) && live.has(l.target.operatorID));
  const settings = doc.getMap<unknown>(SETTINGS);
  const spec: WorkflowSpec = { operators, links };
  for (const key of SETTING_KEYS) {
    const value = settings.get(key);
    if (typeof value === "string") spec[key] = value;
  }
  return spec;
}

/** Where each operator sits, for the ones somebody or the layout has placed. */
export function positionsOf(doc: Y.Doc): Positions {
  return doc.getMap<Point>(POSITIONS).toJSON() as Positions;
}

/** Moves operators on the shared canvas. */
export function movePositions(doc: Y.Doc, moves: Positions, origin?: unknown): void {
  doc.transact(() => {
    const positions = doc.getMap<Point>(POSITIONS);
    for (const [id, at] of Object.entries(moves)) if (!same(positions.get(id), at)) positions.set(id, at);
  }, origin);
}

/**
 * Gives every operator a place: the ones nobody placed are laid out, the others stay. One
 * writer does this (whoever holds the document for everyone), so two people opening a workflow
 * do not lay it out twice.
 */
export function placeOperators(doc: Y.Doc, origin?: unknown): void {
  const known = positionsOf(doc);
  movePositions(doc, reconcilePositions(specOf(doc), known), origin);
}

/**
 * Takes out of the document what its spec leaves out: a link whose operator is gone, the place
 * of an operator that is gone, and the places kept for the icons operators once were. Two
 * people leave the first two behind by removing and changing at the same moment. One writer
 * does this, when it saves, so the document it keeps says what the version says and an
 * operator made later under the same id starts clean.
 */
export function dropLeftovers(doc: Y.Doc, origin?: unknown): void {
  const operators = doc.getMap<Y.Map<unknown>>(OPERATORS);
  const links = doc.getMap<Omit<WorkflowLink, "linkID">>(LINKS);
  const positions = doc.getMap<Point>(POSITIONS);
  const former = doc.getMap<Point>(FORMER_POSITIONS);
  const looseLinks = [...links].filter(([, link]) => !operators.has(link.source.operatorID) || !operators.has(link.target.operatorID)).map(([id]) => id);
  const loosePlaces = [...positions.keys()].filter(id => !operators.has(id));
  if (looseLinks.length === 0 && loosePlaces.length === 0 && former.size === 0) return;
  doc.transact(() => {
    for (const id of looseLinks) links.delete(id);
    for (const id of loosePlaces) positions.delete(id);
    for (const id of [...former.keys()]) former.delete(id);
  }, origin);
}

// A workflow's session and the catalog. The session saves by itself a moment after the edits
// stop. Two things are said about that, in the two ways a session has of saying something:
//
//  - How the document stands with the catalog is part of the session's own awareness state,
//    beside who is there: the version it was last saved as, and why the last save was not
//    taken while that stands. Everyone in the session has it, whenever they joined.
//  - A run, or an agent asked about the workflow, reads the catalog's version and so asks for
//    a save now. That is a request with an answer, told apart from others by its id.

/** How a session's document stands with the catalog. */
export interface Standing {
  /** The version it was last saved as. */
  vno: number;
  /** Why the catalog did not take the last save, while that stands. */
  refused?: string;
}

/** The field of the session's awareness state that holds its standing. */
export const STANDING = "catalog";

/** The standing a session's awareness states hold, once the session has said it. */
export function standingIn(states: Iterable<Record<string, unknown>>): Standing | undefined {
  for (const state of states) {
    const standing = state[STANDING] as Standing | undefined;
    if (standing && typeof standing.vno === "number") return standing;
  }
  return undefined;
}

/** Asks the session to save now; `id` names the request, so its answer is told from any other. */
export const saveRequest = (id: string) => `save:${id}`;

/** The id of a request to save now; undefined when what was said is not one. */
export const readSaveRequest = (said: string): string | undefined => /^save:([^:]*)$/.exec(said)?.[1];

/** The answer to a request to save: the version the catalog then has, or why it took none. */
export type SaveAnswer = { id: string; vno?: number; refused?: undefined } | { id: string; refused: string };

export function saveAnswer(answer: SaveAnswer): string {
  return answer.refused !== undefined ? `not-saved:${answer.id}:${answer.refused}` : `saved:${answer.id}:${answer.vno ?? ""}`;
}

const SAVED = /^saved:([^:]*):(\d*)$/;
const NOT_SAVED = /^not-saved:([^:]*):([\s\S]*)$/;

/** The answer in what a session said; undefined when it said something else. */
export function readSaveAnswer(said: string): SaveAnswer | undefined {
  const saved = SAVED.exec(said);
  if (saved) return { id: saved[1] as string, ...(saved[2] ? { vno: Number(saved[2]) } : {}) };
  const refused = NOT_SAVED.exec(said);
  return refused ? { id: refused[1] as string, refused: refused[2] as string } : undefined;
}
