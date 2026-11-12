import { describe, expect, it } from "vitest";
import { CatalogError } from "../api";
import { goesWith, pageAfter, refusalOf } from "./deleting";

describe("what goes with a resource", () => {
  it("says how many executions go with a workflow", () => {
    expect(goesWith("workflow", 0)).toBe("Every version of it goes.");
    expect(goesWith("workflow", 1)).toBe("Every version of it goes, and its execution with its results.");
    expect(goesWith("workflow", 3)).toContain("its 3 executions with their results");
    expect(goesWith("workflow")).toContain("its executions with their results");
  });
  it("says what a chat leaves behind", () => {
    expect(goesWith("conversation")).toContain("What the chat made stays in the project");
  });
  it("says nothing of a kind that takes nothing along", () => {
    expect(goesWith("skill")).toBe("");
  });
});

describe("what the catalog said when it refused", () => {
  it("names what still uses the thing, each once whatever version names it", () => {
    const refusal = refusalOf(
      new CatalogError(409, "iris is referenced by 3 resources", "referenced", {
        dependents: ["texera://workflows/w1@1", "texera://workflows/w1@2", "texera://workflows/w2@1"],
      })
    );
    expect(refusal).toEqual({ said: "It stays for now: 2 resources still use it.", blockers: ["texera://workflows/w1", "texera://workflows/w2"] });
  });
  it("names the execution still going", () => {
    const refusal = refusalOf(new CatalogError(409, "first is still going; cancel it first", "running", { execution: "texera://workflows/w1/executions/e1" }));
    expect(refusal?.said).toContain("an execution is still going");
    expect(refusal?.blockers).toEqual(["texera://workflows/w1/executions/e1"]);
  });
  it("passes on what it has no words of its own for", () => {
    expect(refusalOf(new CatalogError(409, "lab holds 2 resources; delete or move them first", "has_children"))).toEqual({
      said: "lab holds 2 resources; delete or move them first",
      blockers: [],
    });
  });
  it("is not a refusal when the catalog failed, or said no for another reason", () => {
    expect(refusalOf(new CatalogError(500, "boom"))).toBeUndefined();
    expect(refusalOf(new CatalogError(403, "forbidden"))).toBeUndefined();
    expect(refusalOf(new Error("offline"))).toBeUndefined();
  });
});

describe("where the person stands once a thing is gone", () => {
  it("stays on a page of something else", () => {
    expect(pageAfter({ kind: "dataset", rid: "d1" }, "p1", "/projects/p1")).toBeUndefined();
    expect(pageAfter({ kind: "conversation", rid: "c1" }, "p1", "/conversations/c2")).toBeUndefined();
  });
  it("goes to the project a thing lived in", () => {
    expect(pageAfter({ kind: "dataset", rid: "d1" }, "p1", "/datasets/d1")).toBe("/projects/p1");
  });
  it("goes to the start page from a chat or a project", () => {
    expect(pageAfter({ kind: "conversation", rid: "c1" }, "p1", "/conversations/c1")).toBe("/");
    expect(pageAfter({ kind: "project", rid: "p1" }, "p1", "/projects/p1")).toBe("/");
  });
  it("goes to an execution's workflow, and leaves a workflow from the page of its execution", () => {
    expect(pageAfter({ kind: "execution", rid: "e1", parent: "w1" }, "p1", "/workflows/w1/executions/e1")).toBe("/workflows/w1");
    expect(pageAfter({ kind: "workflow", rid: "w1" }, "p1", "/workflows/w1/executions/e1")).toBe("/projects/p1");
  });
});
