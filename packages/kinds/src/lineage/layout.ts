// Where the cards of a lineage graph sit. Data runs left to right, so a card stands one
// column right of the furthest thing it came from, and a card nothing leads to right before
// what it leads to; a column is a stack; a card stands level with the middle of what came out
// of it, so an arrow rarely has to cross another. The same graph always gets the same picture.

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  width: number;
  height: number;
}

export interface Spacing {
  /** Between two columns: room for an arrow and the words on it. */
  column: number;
  /** Between two cards of a column. */
  row: number;
  /** More room between cards of a column that came from different cards. */
  group: number;
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** A place for every card: its top left corner, the whole graph starting at the origin. */
export function layoutLineage(
  nodes: readonly { id: string }[],
  arrows: readonly { from: string; to: string }[],
  box: Box,
  spacing: Spacing
): Record<string, Point> {
  const ids = nodes.map(n => n.id);
  const known = new Set(ids);
  const before = new Map<string, string[]>(ids.map(id => [id, []]));
  const after = new Map<string, string[]>(ids.map(id => [id, []]));
  for (const a of arrows) {
    if (a.from === a.to || !known.has(a.from) || !known.has(a.to)) continue;
    before.get(a.to)?.push(a.from);
    after.get(a.from)?.push(a.to);
  }

  // The column of a card: one right of the furthest card it came from. A cycle is cut where it closes.
  const column = new Map<string, number>();
  const walking = new Set<string>();
  const columnOf = (id: string): number => {
    const had = column.get(id);
    if (had !== undefined) return had;
    if (walking.has(id)) return 0;
    walking.add(id);
    const sources = before.get(id) ?? [];
    const c = sources.length ? Math.max(...sources.map(columnOf)) + 1 : 0;
    walking.delete(id);
    column.set(id, c);
    return c;
  };
  ids.forEach(columnOf);
  // A card nothing leads to stands right before the nearest card it leads to, not at the far
  // left: its arrow stays short, and the graph narrow.
  for (const id of ids) {
    const outs = after.get(id) ?? [];
    if ((before.get(id) ?? []).length === 0 && outs.length)
      column.set(id, Math.max(0, Math.min(...outs.map(o => column.get(o) ?? 0)) - 1));
  }
  const columns: string[][] = [];
  for (const id of ids) {
    const c = column.get(id) ?? 0;
    while (columns.length <= c) columns.push([]);
    columns[c]?.push(id);
  }

  // The order within a column: by where the cards it is tied to stand, so arrows do not cross
  // more than they must; among equals, the order given.
  const place = new Map<string, number>();
  const number = (list: string[]) => {
    for (const [i, id] of list.entries()) place.set(id, i);
  };
  columns.forEach(number);
  const arrange = (list: string[], tied: Map<string, string[]>) => {
    const weight = new Map(
      list.map(id => {
        const others = (tied.get(id) ?? []).map(o => place.get(o) ?? 0);
        return [id, others.length ? mean(others) : (place.get(id) ?? 0)];
      })
    );
    list.sort((a, b) => (weight.get(a) ?? 0) - (weight.get(b) ?? 0) || (place.get(a) ?? 0) - (place.get(b) ?? 0));
    number(list);
  };
  for (let i = 1; i < columns.length; i++) arrange(columns[i] as string[], before);
  for (let i = columns.length - 2; i >= 0; i--) arrange(columns[i] as string[], after);
  for (let i = 1; i < columns.length; i++) arrange(columns[i] as string[], before);

  // Heights, from the last column back: a card stands level with the middle of what came out
  // of it, and never on top of the card above it.
  const top = new Map<string, number>();
  const step = box.height + spacing.row;
  for (let i = columns.length - 1; i >= 0; i--) {
    const list = columns[i] as string[];
    const wanted = list.map(id => {
      const outs = (after.get(id) ?? []).map(o => top.get(o)).filter((y): y is number => y !== undefined);
      return outs.length ? mean(outs) : undefined;
    });
    // Cards with nothing after them, standing above the first that has: stacked up from it.
    const firstWanted = wanted.findIndex(y => y !== undefined);
    let bottom: number | undefined;
    let group: string | undefined;
    list.forEach((id, k) => {
      const mine = (before.get(id) ?? [])[0];
      const room = spacing.row + (bottom !== undefined && mine !== group ? spacing.group : 0);
      const least = bottom === undefined ? undefined : bottom + room;
      let y = wanted[k];
      if (y === undefined)
        y = least ?? (firstWanted > k ? (wanted[firstWanted] as number) - (firstWanted - k) * step : 0);
      else if (least !== undefined) y = Math.max(y, least);
      top.set(id, y);
      bottom = y + box.height;
      group = mine;
    });
  }

  const highest = Math.min(...ids.map(id => top.get(id) ?? 0));
  return Object.fromEntries(
    ids.map(id => [id, { x: (column.get(id) ?? 0) * (box.width + spacing.column), y: (top.get(id) ?? 0) - highest }])
  );
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
