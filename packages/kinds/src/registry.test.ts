import { describe, expect, it } from "vitest";
import { KIND_TABLE } from "./kinds.gen";
import { isKindId, KINDS, LIBRARY_GROUPS } from "./registry";
import { KIND_IDS, kindEntry } from "./types";
import { href, pluralOf } from "./uri";

describe("kind registry", () => {
  it("registers every kind of the contract with an accent token and matching facts", () => {
    expect(KIND_IDS).toHaveLength(KIND_TABLE.length);
    for (const id of KIND_IDS) {
      const spec = KINDS[id];
      expect(spec.kind).toBe(id);
      expect(spec.accent).toContain(`kind-${id}`);
      expect(kindEntry(id).plural).toBe(pluralOf(id));
      expect(spec.label.length).toBeGreaterThan(0);
    }
    // What the app makes from a "New" button: every kind but the ones made elsewhere (an
    // execution, a chat, the settings) and the agent, which the platform ships.
    const madeElsewhere = ["settings", "execution", "conversation", "agent-template"];
    expect(KIND_IDS.filter(k => !KINDS[k].defaultSpec).sort()).toEqual(madeElsewhere.sort());
    expect(LIBRARY_GROUPS.flatMap(g => g.kinds).every(k => isKindId(k))).toBe(true);
  });

  it("links pages by the contract's plurals", () => {
    expect(href({ kind: "agent-template", rid: "t1" })).toBe("/agent-templates/t1");
    expect(href({ kind: "execution", rid: "e1", parent: "w1" })).toBe("/workflows/w1/executions/e1");
    expect(isKindId("mcp-server")).toBe(true);
    expect(isKindId("agent_template")).toBe(false);
  });
});
