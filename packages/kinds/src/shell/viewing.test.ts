import { describe, expect, it } from "vitest";
import { pageResource, viewingContext } from "./viewing";

const W = "0b7a1c2d-0000-4000-8000-000000000001";
const E = "0b7a1c2d-0000-4000-8000-000000000002";

describe("the resource a page shows, from its address", () => {
  it("is the resource of a resource page, with the version it is pinned to", () => {
    expect(pageResource(`/workflows/${W}`)).toEqual({ kind: "workflow", rid: W });
    expect(pageResource(`/datasets/${W}`, 2)).toEqual({ kind: "dataset", rid: W, vno: 2 });
    expect(pageResource(`/workflows/${W}/executions/${E}`)).toEqual({ kind: "execution", rid: E, parent: W });
  });

  it("is nothing for a chat, a list, the settings, or a page that is not a resource's", () => {
    for (const path of [`/conversations/${W}`, "/workflows", "/settings", "/", "/login"]) expect(pageResource(path)).toBeUndefined();
  });
});

describe("what a page tells the agent the person is looking at", () => {
  it("is the resource by kind, name and URI", () => {
    expect(viewingContext({ kind: "workflow", rid: W }, "petals")).toEqual([
      { description: "The person is looking at", value: `Workflow "petals" (texera://workflows/${W})` },
    ]);
  });

  it("names the version a page is pinned to, and an execution under its workflow", () => {
    expect(viewingContext({ kind: "dataset", rid: W, vno: 2 }, "iris")[0]?.value).toBe(`Dataset "iris" (texera://datasets/${W}@2)`);
    expect(viewingContext({ kind: "execution", rid: E, parent: W }, "first")[0]?.value).toBe(`Execution "first" (texera://workflows/${W}/executions/${E})`);
  });

  it("goes by the URI alone until the name is known", () => {
    expect(viewingContext({ kind: "skill", rid: W }, undefined)[0]?.value).toBe(`Skill (texera://skills/${W})`);
  });

  it("adds what the page says about it", () => {
    expect(viewingContext({ kind: "workflow", rid: W }, "petals", "the operator avg is selected")).toEqual([
      { description: "The person is looking at", value: `Workflow "petals" (texera://workflows/${W})` },
      { description: "On that page", value: "the operator avg is selected" },
    ]);
  });
});
