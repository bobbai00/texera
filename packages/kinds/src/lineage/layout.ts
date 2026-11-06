// Where the cards of a lineage graph sit, and where the words of its arrows go. The cards are
// laid out as every graph of the app is; the words are lineage's own.

import { layered, type Point } from "@texera/workflow-model";

export type { Point };

export interface Box {
  width: number;
  height: number;
}

export interface Spacing {
  /** Between two columns: room for an arrow and the words on it. */
  column: number;
  /** Between two cards of a column. */
  row: number;
}

/**
 * A place for every card: its top left corner, the whole graph starting at the origin. Data runs
 * left to right, laid out as every graph of the app is (`layered`): a card one column right of
 * the furthest card it came from, columns ordered so arrows cross as little as they can, a card
 * level with what it is tied to. The same graph always gets the same picture.
 */
export function layoutLineage(
  nodes: readonly { id: string }[],
  arrows: readonly { from: string; to: string }[],
  box: Box,
  spacing: Spacing
): Record<string, Point> {
  return layered(nodes, arrows, box, spacing);
}

/** Where the words of an arrow go: on its middle, beside the card it leaves or arrives at, or nowhere. */
export type LabelPlace = { at: "middle" } | { at: "none" } | { at: "source" | "target"; slot: number; slots: number };

/** From how many arrows on, a card's arrows that say the same thing say it once. */
export const FAN = 3;

/**
 * Where each arrow's words go. Several arrows that leave one card saying the same thing (an
 * execution that produced five results) say it once, beside that card, where they are still one
 * bundle; so do several that arrive at one card. Any other arrow carries its words on its
 * middle. A card with more than one such bundle gives each a slot, top to bottom.
 */
export function placeLabels(
  arrows: readonly { id: string; from: string; to: string; relation: string; label: string; detail?: string }[]
): Map<string, LabelPlace> {
  const said = (a: (typeof arrows)[number]) => `${a.relation}|${a.label}|${a.detail ?? ""}`;
  const leaving = new Map<string, string[]>();
  const arriving = new Map<string, string[]>();
  const count = (map: Map<string, string[]>, key: string, id: string) => map.set(key, [...(map.get(key) ?? []), id]);
  for (const a of arrows) {
    count(leaving, `${a.from}|${said(a)}`, a.id);
    count(arriving, `${a.to}|${said(a)}`, a.id);
  }
  const places = new Map<string, LabelPlace>();
  const beside = new Map<string, string[]>();
  for (const a of arrows) {
    const fan = leaving.get(`${a.from}|${said(a)}`) ?? [];
    const funnel = arriving.get(`${a.to}|${said(a)}`) ?? [];
    const side = fan.length >= FAN ? "source" : funnel.length >= FAN ? "target" : undefined;
    if (!side) {
      places.set(a.id, { at: "middle" });
      continue;
    }
    if ((side === "source" ? fan : funnel)[0] !== a.id) {
      places.set(a.id, { at: "none" });
      continue;
    }
    const card = `${side}|${side === "source" ? a.from : a.to}`;
    count(beside, card, a.id);
    places.set(a.id, { at: side, slot: 0, slots: 1 });
  }
  for (const [card, ids] of beside) {
    const side = card.startsWith("source|") ? "source" : "target";
    for (const [slot, id] of ids.entries()) places.set(id, { at: side, slot, slots: ids.length });
  }
  return places;
}
