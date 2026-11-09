import { describe, expect, it } from "vitest";
import { type Claim, claimFor, holdsIn, holdsOfOthers, sameHolds } from "./holds";

const alice = { pid: "a", name: "Alice" };
const bob = { pid: "b", name: "Bob" };
const state = (user: unknown, hold?: Partial<Claim> | null) => ({ user, hold });

describe("who holds what in a session", () => {
  it("is whoever claimed it first, whatever order the states come in", () => {
    const a = state(alice, { id: "op", doing: "viewing", since: 100 });
    const b = state(bob, { id: "op", doing: "editing", since: 101 });
    for (const states of [new Map([[1, a], [2, b]]), new Map([[2, b], [1, a]])])
      expect(holdsIn(states).get("op")).toEqual({ ...alice, doing: "viewing" });
  });

  it("goes to the lower connection when two claim at the same moment, so everyone agrees", () => {
    const states = new Map([
      [9, state(alice, { id: "op", doing: "viewing", since: 100 })],
      [3, state(bob, { id: "op", doing: "viewing", since: 100 })],
    ]);
    expect(holdsIn(states).get("op")?.pid).toBe("b");
  });

  it("ignores what says no person or no proper claim, and keeps things apart", () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, state(undefined, { id: "x", doing: "viewing", since: 1 })],
      [2, state(alice, { id: "x", doing: "staring" as never, since: 1 })],
      [3, state(bob, null)],
      [4, state(alice, { id: "y", doing: "editing", since: 5 })],
      [5, state(bob, { id: "z", doing: "viewing", since: 6 })],
    ]);
    const holds = holdsIn(states);
    expect([...holds.keys()].sort()).toEqual(["y", "z"]);
    expect([...holdsOfOthers(holds, "a").keys()]).toEqual(["z"]);
  });
});

describe("what a person claims", () => {
  const none = new Map();
  it("is what they want, from when they first had it", () => {
    expect(claimFor({ id: "op", doing: "viewing" }, none, "a", undefined, 50)).toEqual({ id: "op", doing: "viewing", since: 50 });
    expect(claimFor({ id: "op", doing: "editing" }, none, "a", { id: "op", doing: "viewing", since: 50 }, 99)).toEqual({ id: "op", doing: "editing", since: 50 });
  });

  it("is nothing when someone else has it or they want nothing, and theirs again in another tab", () => {
    const taken = new Map([["op", { ...bob, doing: "viewing" as const }]]);
    expect(claimFor({ id: "op", doing: "viewing" }, taken, "a", undefined, 50)).toBeNull();
    expect(claimFor(null, none, "a", { id: "op", doing: "viewing", since: 1 }, 50)).toBeNull();
    expect(claimFor({ id: "op", doing: "viewing" }, taken, "b", undefined, 50)).toEqual({ id: "op", doing: "viewing", since: 50 });
  });
});

describe("two sets of holds", () => {
  it("are the same when they say the same", () => {
    const one = new Map([["op", { ...bob, doing: "viewing" as const }]]);
    expect(sameHolds(one, new Map(one))).toBe(true);
    expect(sameHolds(one, new Map([["op", { ...bob, doing: "editing" as const }]]))).toBe(false);
    expect(sameHolds(one, new Map())).toBe(false);
  });
});
