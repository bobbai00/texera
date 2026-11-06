import { describe, expect, it } from "vitest";
import { peopleIn, presenceTone } from "./presence";

const alice = { pid: "a11ce000-0000-4000-8000-000000000001", name: "Alice Liddell" };
const bob = { pid: "b0b00000-0000-4000-8000-000000000002", name: "Bob Stone" };
const carol = { pid: "ca401000-0000-4000-8000-000000000003", name: "Carol Lovelace" };

describe("the people in a session", () => {
  it("are whoever said who they are: the person first, then the others by name", () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: carol }],
      [2, { user: alice }],
      [3, { user: bob, cursor: { x: 1, y: 2 } }],
      [4, {}],
    ]);
    const people = peopleIn(states, 3);
    expect(people.map(p => p.name)).toEqual(["Bob Stone", "Alice Liddell", "Carol Lovelace"]);
    expect(people.map(p => p.self)).toEqual([true, false, false]);
    expect(people[0]?.state).toEqual({ user: bob, cursor: { x: 1, y: 2 } });
  });

  it("count a person once, however many tabs they have open, and the tab that is this one wins", () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: alice, cursor: { x: 9, y: 9 } }],
      [2, { user: alice }],
      [3, { user: bob }],
    ]);
    expect(peopleIn(states, 2).map(p => [p.name, p.self, p.clientId])).toEqual([
      ["Alice Liddell", true, 2],
      ["Bob Stone", false, 3],
    ]);
  });

  it("have a colour of their own that stays the same from page to page", () => {
    expect(presenceTone(alice.pid)).toBe(presenceTone(alice.pid));
    for (const p of [alice, bob, carol]) expect(presenceTone(p.pid)).toBeGreaterThanOrEqual(0);
    for (const p of [alice, bob, carol]) expect(presenceTone(p.pid)).toBeLessThan(6);
  });
});
