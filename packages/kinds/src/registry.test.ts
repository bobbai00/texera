import { describe, expect, it } from "vitest";
import { href, KINDS, kindByLibrarySlug, kindBySlug, LIBRARY_KINDS, parseRef } from "./registry";
import { KIND_IDS, refKey } from "./types";

describe("kind registry", () => {
  it("registers every kind with a unique slug, library slug and accent", () => {
    const slugs = new Set<string>();
    const library = new Set<string>();
    for (const id of KIND_IDS) {
      const spec = KINDS[id];
      expect(spec.kind).toBe(id);
      expect(spec.slug).toMatch(/^[a-z]$/);
      expect(slugs.has(spec.slug)).toBe(false);
      slugs.add(spec.slug);
      expect(library.has(spec.librarySlug)).toBe(false);
      library.add(spec.librarySlug);
      expect(spec.accent).toContain(`kind-${id}`);
      expect(spec.Card).toBeDefined();
      expect(spec.View).toBeDefined();
    }
    expect(LIBRARY_KINDS.every(k => k in KINDS)).toBe(true);
  });

  it("resolves slugs and builds page links", () => {
    expect(kindBySlug("w")?.kind).toBe("workflow");
    expect(kindBySlug("c")?.kind).toBe("conversation");
    expect(kindByLibrarySlug("datasets")?.kind).toBe("dataset");
    expect(kindBySlug("zz")).toBeUndefined();
    expect(href({ kind: "workflow", rid: "abc" })).toBe("/w/abc");
    expect(href({ kind: "dataset", rid: "d1", vno: 3 })).toBe("/d/d1?vno=3");
    expect(href({ kind: "execution", rid: "e1" })).toBe("/x/e1");
  });

  it("round-trips refs through their key", () => {
    const ref = { kind: "dataset" as const, rid: "d1", vno: 2 };
    expect(parseRef(refKey(ref))).toEqual(ref);
    expect(parseRef("workflow:w1")).toEqual({ kind: "workflow", rid: "w1" });
    expect(parseRef("nope:1")).toBeUndefined();
    expect(parseRef(undefined)).toBeUndefined();
  });
});
