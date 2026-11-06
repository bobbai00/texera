import { describe, expect, it } from "vitest";
import { CARD, COLUMN, freeSpot, ICONS, layoutPositions, ORIGIN, pictureOf, placeMissing, ROW } from "./layout";
import type { Positions, WorkflowSpec } from "./types";

const link = (from: string, to: string, port = "input-0") => ({
  linkID: `${from}-${to}`,
  source: { operatorID: from, portID: "output-0" },
  target: { operatorID: to, portID: port },
});
const ops = (...ids: string[]) => ids.map(id => ({ operatorID: id, operatorType: "X", operatorProperties: {} }));
const spec: WorkflowSpec = {
  operators: ops("a", "b", "c", "d"),
  links: [link("a", "c"), link("b", "c", "input-1"), link("c", "d")],
};

/** Whether two cards at these places lie over each other. */
const overlap = (p: { x: number; y: number }, q: { x: number; y: number }) =>
  Math.abs(p.x - q.x) < CARD.width && Math.abs(p.y - q.y) < CARD.height;

/** Whether the straight line between two points crosses a card's box. */
function crosses(from: { x: number; y: number }, to: { x: number; y: number }, card: { x: number; y: number }) {
  for (let t = 0; t <= 1; t += 1 / 200) {
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    if (x > card.x && x < card.x + CARD.width && y > card.y && y < card.y + CARD.height) return true;
  }
  return false;
}

describe("a workflow laid out", () => {
  it("reads left to right: each operator right of what it reads from, those it starts from in the first column", () => {
    const p = layoutPositions(spec);
    expect(p.a?.x).toBe(ORIGIN.x);
    expect(p.b?.x).toBe(ORIGIN.x);
    expect(p.c?.x).toBeGreaterThan(p.a?.x ?? 0);
    expect(p.d?.x).toBeGreaterThan(p.c?.x ?? 0);
    expect(Math.min(...Object.values(p).map(q => q.y))).toBe(ORIGIN.y);
  });

  it("puts no card on another", () => {
    const p = Object.values(layoutPositions(spec));
    for (const [i, q] of p.entries()) for (const r of p.slice(i + 1)) expect(overlap(q, r)).toBe(false);
  });

  it("stands a join between the two branches it joins", () => {
    const p = layoutPositions(spec);
    expect(p.c?.y).toBeGreaterThanOrEqual(Math.min(p.a?.y ?? 0, p.b?.y ?? 0));
    expect(p.c?.y).toBeLessThanOrEqual(Math.max(p.a?.y ?? 0, p.b?.y ?? 0));
  });

  it("keeps an arrow that skips a column clear of the card in that column", () => {
    // One input of the join comes through a filter, the other straight from its scan.
    const join: WorkflowSpec = {
      operators: ops("left", "filter", "right", "join"),
      links: [link("left", "filter"), link("filter", "join"), link("right", "join", "input-1")],
    };
    const p = layoutPositions(join) as Required<Positions>;
    const out = (id: string) => ({ x: (p[id]?.x ?? 0) + CARD.width, y: (p[id]?.y ?? 0) + CARD.height / 2 });
    const into = (id: string) => ({ x: p[id]?.x ?? 0, y: (p[id]?.y ?? 0) + CARD.height / 2 });
    expect(crosses(out("right"), into("join"), p.filter as { x: number; y: number })).toBe(false);
  });

  it("lays a small picture out closer together, where an operator is its icon", () => {
    const cards = layoutPositions(spec);
    const icons = layoutPositions(spec, ICONS);
    expect((icons.c?.x ?? 0) - (icons.a?.x ?? 0)).toBeLessThan((cards.c?.x ?? 0) - (cards.a?.x ?? 0));
  });

  it("gives every operator a place, also in a cycle", () => {
    const cyclic: WorkflowSpec = { ...spec, links: [...spec.links, link("d", "a")] };
    expect(Object.keys(layoutPositions(cyclic)).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("an operator nobody placed", () => {
  const placed = { a: { x: 40, y: 40 }, b: { x: 40, y: 168 }, c: { x: 360, y: 40 } };

  it("leaves every place someone set where it is", () => {
    const all = { ...placed, d: { x: 900, y: 600 } };
    expect(placeMissing(spec, all)).toEqual(all);
  });

  it("goes right of what it reads from, in the first free spot", () => {
    expect(placeMissing(spec, placed).d).toEqual({ x: 360 + COLUMN, y: 40 });
    // That spot taken by another operator, it goes down until it is free.
    const crowded: WorkflowSpec = { ...spec, operators: [...spec.operators, ...ops("e")] };
    expect(placeMissing(crowded, { ...placed, e: { x: 360 + COLUMN, y: 40 } }).d).toEqual({
      x: 360 + COLUMN,
      y: 40 + ROW,
    });
  });

  it("goes left of what it feeds when it reads from nothing placed", () => {
    const p = placeMissing(spec, { c: { x: 680, y: 200 }, d: { x: 1000, y: 200 } });
    expect(p.a).toEqual({ x: 680 - COLUMN, y: 200 });
    expect(p.b).toEqual({ x: 680 - COLUMN, y: 200 + ROW });
  });

  it("goes under everything when it is joined to nothing placed", () => {
    const lone: WorkflowSpec = { operators: [...spec.operators, ...ops("e")], links: spec.links };
    const all = { a: { x: 40, y: 40 }, b: { x: 40, y: 168 }, c: { x: 360, y: 40 }, d: { x: 680, y: 40 } };
    expect(placeMissing(lone, all).e).toEqual({ x: ORIGIN.x, y: 168 + ROW });
  });

  it("is laid out with the rest when nobody placed anything", () => {
    expect(placeMissing(spec, {})).toEqual(layoutPositions(spec));
  });
});

describe("a small picture of a workflow", () => {
  it("keeps the arrangement the workflow was given, drawn smaller", () => {
    const arranged = {
      ...spec,
      layout: {
        a: { x: 40, y: 40 },
        b: { x: 40, y: 40 + ROW },
        c: { x: 40 + COLUMN, y: 40 },
        d: { x: 40 + 2 * COLUMN, y: 40 + ROW },
      },
    };
    const p = pictureOf(arranged);
    expect(p.c).toEqual({ x: ORIGIN.x + ICONS.column, y: ORIGIN.y });
    expect(p.d).toEqual({ x: ORIGIN.x + 2 * ICONS.column, y: ORIGIN.y + ICONS.row });
  });

  it("is laid out when the workflow does not say where every operator sits", () => {
    expect(pictureOf({ ...spec, layout: { a: { x: 40, y: 40 } } })).toEqual(layoutPositions(spec, ICONS));
    expect(pictureOf(spec)).toEqual(layoutPositions(spec, ICONS));
  });
});

describe("a free spot", () => {
  it("is the spot asked for, moved down until no card is on it", () => {
    expect(freeSpot({ a: { x: 40, y: 40 } }, { x: 40, y: 40 })).toEqual({ x: 40, y: 40 + ROW });
    expect(freeSpot({}, { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
  });
});
