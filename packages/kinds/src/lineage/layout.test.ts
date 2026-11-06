import { describe, expect, it } from "vitest";
import { layoutLineage, placeLabels } from "./layout";

const box = { width: 100, height: 40 };
const spacing = { column: 50, row: 10 };
const cards = (...ids: string[]) => ids.map(id => ({ id }));
const arrow = (from: string, to: string) => ({ from, to });
const place = (ids: string[], arrows: { from: string; to: string }[]) =>
  layoutLineage(cards(...ids), arrows, box, spacing);

describe("where the cards of a lineage graph sit", () => {
  const right = (p: Record<string, { x: number }>, from: string, to: string) => (p[to]?.x ?? 0) > (p[from]?.x ?? 0);
  const overlap = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.abs(a.x - b.x) < box.width && Math.abs(a.y - b.y) < box.height;

  it("puts what was read at the left, and each card right of every card it came from", () => {
    const p = place(["a", "b", "c", "d"], [arrow("a", "c"), arrow("b", "c"), arrow("c", "d"), arrow("a", "d")]);
    expect(p.a?.x).toBe(0);
    expect(p.b?.x).toBe(0);
    for (const [from, to] of [
      ["a", "c"],
      ["b", "c"],
      ["c", "d"],
      ["a", "d"],
    ])
      expect(right(p, from as string, to as string)).toBe(true);
  });

  it("stands a card nothing leads to right before what it leads to, not at the far left", () => {
    // key -> endpoint -> agent, and a skill the agent names directly: the skill stands beside the endpoint.
    const p = place(
      ["key", "endpoint", "skill", "agent"],
      [arrow("key", "endpoint"), arrow("endpoint", "agent"), arrow("skill", "agent")]
    );
    expect(p.skill?.x).toBe(p.endpoint?.x);
  });

  it("stacks a column without overlap", () => {
    const p = place(["a", "c", "b1", "b2", "d1"], [arrow("a", "b1"), arrow("a", "b2"), arrow("c", "d1")]);
    const all = Object.values(p);
    for (const [i, q] of all.entries()) for (const r of all.slice(i + 1)) expect(overlap(q, r)).toBe(false);
  });

  it("stands a chain level, all the way along", () => {
    const chain = place(["x", "y", "z"], [arrow("x", "y"), arrow("y", "z")]);
    expect(new Set([chain.x?.y, chain.y?.y, chain.z?.y]).size).toBe(1);
  });

  it("orders a column by where the cards it came from stand, so arrows do not cross", () => {
    // Given in the crossing order: the children of the second parent first.
    const p = place(["p1", "p2", "c2", "c1"], [arrow("p1", "c1"), arrow("p2", "c2")]);
    expect(Math.sign((p.c1?.y ?? 0) - (p.c2?.y ?? 0))).toBe(Math.sign((p.p1?.y ?? 0) - (p.p2?.y ?? 0)));
  });

  it("gives every card a place whatever the arrows, also in a cycle or with an arrow to nowhere", () => {
    const p = place(["a", "b", "alone"], [arrow("a", "b"), arrow("b", "a"), arrow("a", "gone"), arrow("a", "a")]);
    expect(Object.keys(p).sort()).toEqual(["a", "alone", "b"]);
    for (const at of Object.values(p)) expect(Number.isFinite(at.x) && Number.isFinite(at.y)).toBe(true);
    expect(place([], [])).toEqual({});
  });

  it("gives the same graph the same picture", () => {
    const arrows = [arrow("a", "c"), arrow("b", "c"), arrow("c", "d")];
    expect(place(["a", "b", "c", "d"], arrows)).toEqual(place(["a", "b", "c", "d"], arrows));
  });
});

describe("where the words of the arrows go", () => {
  const says = (id: string, from: string, to: string, label = "produced", detail?: string) => ({
    id,
    from,
    to,
    relation: label,
    label,
    ...(detail ? { detail } : {}),
  });

  it("puts the words of an arrow on its middle", () => {
    const p = placeLabels([says("1", "file", "workflow", "read"), says("2", "workflow", "run", "ran")]);
    expect([p.get("1"), p.get("2")]).toEqual([{ at: "middle" }, { at: "middle" }]);
  });

  it("says once, beside the card, what three or more arrows leaving it say", () => {
    const p = placeLabels([
      says("a", "run", "r1"),
      says("b", "run", "r2"),
      says("c", "run", "r3"),
      says("x", "run", "saved", "saved as"),
    ]);
    expect(p.get("a")).toEqual({ at: "source", slot: 0, slots: 1 });
    expect([p.get("b"), p.get("c")]).toEqual([{ at: "none" }, { at: "none" }]);
    expect(p.get("x")).toEqual({ at: "middle" });
    // Two arrows are not a bundle: each says its own.
    const two = placeLabels([says("a", "run", "r1"), says("b", "run", "r2")]);
    expect([two.get("a"), two.get("b")]).toEqual([{ at: "middle" }, { at: "middle" }]);
  });

  it("says once, beside the card, what three or more arrows arriving at it say, and tells different words apart", () => {
    const p = placeLabels([
      says("a", "f1", "w", "read", "by scan"),
      says("b", "f2", "w", "read", "by scan"),
      says("c", "f3", "w", "read", "by scan"),
      says("d", "f4", "w", "read", "by join"),
    ]);
    expect(p.get("a")).toEqual({ at: "target", slot: 0, slots: 1 });
    expect([p.get("b"), p.get("c")]).toEqual([{ at: "none" }, { at: "none" }]);
    expect(p.get("d")).toEqual({ at: "middle" });
  });

  it("gives each bundle of a card a slot of its own", () => {
    const made = ["r1", "r2", "r3"].map(r => says(`p-${r}`, "run", r));
    const kept = ["d1", "d2", "d3"].map(d => says(`s-${d}`, "run", d, "saved as"));
    const p = placeLabels([...made, ...kept]);
    expect(p.get("p-r1")).toEqual({ at: "source", slot: 0, slots: 2 });
    expect(p.get("s-d1")).toEqual({ at: "source", slot: 1, slots: 2 });
  });
});
