import type { ResourceMetadata } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { metaLine } from "./MetaLine";

const metadata = (over: Partial<ResourceMetadata>): ResourceMetadata => ({
  rid: "r1",
  uri: "texera://skills/r1",
  name: "x",
  project: "p",
  owner: "u",
  visibility: "private",
  head: 2,
  etag: "e",
  createdBy: "u",
  createdAt: "2026-11-05T00:00:00Z",
  updatedAt: "2026-11-05T00:00:00Z",
  ...over,
});

describe("the line under a resource's name", () => {
  it("says who can see it only when that is more than the people it was shared with", () => {
    expect(metaLine("skill", metadata({})).startsWith("v2 · updated ")).toBe(true);
    expect(metaLine("skill", metadata({ visibility: "public" })).startsWith("public · v2 · ")).toBe(true);
  });

  it("leaves the version out of a kind that has none, and says when there is none yet", () => {
    expect(metaLine("computing-unit", metadata({ head: 0 }))).not.toContain(" v");
    expect(metaLine("skill", metadata({ head: 0 }), ["a note"])).toMatch(/^no version yet · updated .* · a note$/);
  });
});
