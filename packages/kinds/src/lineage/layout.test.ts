import { describe, expect, it } from "vitest";
import { layoutLineage, placeLabels } from "./layout";

const box = { width: 100, height: 40 };
const spacing = { column: 50, row: 10, group: 20 };
const cards = (...ids: string[]) => ids.map(id => ({ id }));
const arrow = (from: string, to: string) => ({ from, to });
const place = (ids: string[], arrows: { from: string; to: string }[]) =>
  layoutLineage(cards(...ids), arrows, box, spacing);

describe("where the cards of a lineage graph sit", () => {
  it("puts what was read at the left, and each card one column right of the furthest card it came from", () => {
    const p = place(["a", "b", "c", "d"], [arrow("a", "c"), arrow("b", "c"), arrow("c", "d"), arrow("a", "d")]);
    expect([p.a?.x, p.b?.x, p.c?.x, p.d?.x]).toEqual([0, 0, 150, 300]);
  });

  it("stands a card nothing leads to right before what it leads to, not at the far left", () => {
    // key -> endpoint -> agent, and a skill the agent names directly: the skill stands beside the endpoint.
    const p = place(
      ["key", "endpoint", "skill", "agent"],
      [arrow("key", "endpoint"), arrow("endpoint", "agent"), arrow("skill", "agent")]
    );
    expect([p.key?.x, p.endpoint?.x, p.skill?.x, p.agent?.x]).toEqual([0, 150, 150, 300]);
  });

  it("stacks a column without overlap, with more room between cards that came from different cards", () => {
    const p = place(["a", "c", "b1", "b2", "d1"], [arrow("a", "b1"), arrow("a", "b2"), arrow("c", "d1")]);
    expect([p.b1?.y, p.b2?.y, p.d1?.y]).toEqual([0, 50, 120]);
  });

  it("stands a card level with the middle of what came out of it", () => {
    const p = place(["a", "c", "b1", "b2", "d1"], [arrow("a", "b1"), arrow("a", "b2"), arrow("c", "d1")]);
    expect(p.a?.y).toBe(25);
    expect(p.c?.y).toBe(120);
    // A card with one thing after it stands level with it, all the way back.
    const chain = place(["x", "y", "z"], [arrow("x", "y"), arrow("y", "z")]);
    expect([chain.x, chain.y, chain.z]).toEqual([
      { x: 0, y: 0 },
      { x: 150, y: 0 },
      { x: 300, y: 0 },
    ]);
  });

  it("keeps cards with nothing after them in their place in the stack", () => {
    // `last` came after `first` and has nothing after it: it stands right under it.
    const p = place(["s", "first", "last", "r"], [arrow("s", "first"), arrow("s", "last"), arrow("first", "r")]);
    expect(p.first?.y).toBe(0);
    expect(p.last?.y).toBe(50);
    // And one standing before the first card that has something after it stands right above it.
    const q = place(
      ["s", "lone", "busy", "r1", "r2"],
      [arrow("s", "lone"), arrow("s", "busy"), arrow("busy", "r1"), arrow("busy", "r2")]
    );
    expect(q.busy?.y).toBe((q.lone?.y ?? 0) + 50);
    expect(Math.min(...Object.values(q).map(at => at.y))).toBe(0);
  });

  it("orders a column by where the cards it came from stand, so arrows do not cross", () => {
    // Given in the crossing order: the children of the second parent first.
    const p = place(["p1", "p2", "c2", "c1"], [arrow("p1", "c1"), arrow("p2", "c2")]);
    expect(p.c1?.y).toBeLessThan(p.c2?.y ?? 0);
    expect(p.p1?.y).toBeLessThan(p.p2?.y ?? 0);
  });

  it("gives every card a place whatever the arrows, also in a cycle or with an arrow to nowhere", () => {
    const p = place(["a", "b", "alone"], [arrow("a", "b"), arrow("b", "a"), arrow("a", "gone"), arrow("a", "a")]);
    expect(Object.keys(p).sort()).toEqual(["a", "alone", "b"]);
    for (const at of Object.values(p)) expect(Number.isFinite(at.x) && Number.isFinite(at.y)).toBe(true);
    expect(place([], [])).toEqual({});
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
