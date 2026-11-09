import type { Resource } from "@texera/catalog-client/types";
import { describe as group, expect, it } from "vitest";
import { describe, operatorsOf } from "./describe";

const resource = (rid: string, project: string, description?: string, spec: object = {}) =>
  ({ metadata: { rid, project, description }, spec }) as unknown as Resource;

group("what a resource says of itself", () => {
  it("is its description", () => {
    expect(describe(resource("a", "p", "A cohort"))).toBe("A cohort");
  });
  it("is what a custom operator's code says when it has none of its own", () => {
    expect(describe(resource("a", "p", undefined, { description: "The AUC of a score" }))).toBe("The AUC of a score");
  });
  it("is nothing when it says nothing", () => {
    expect(describe(resource("a", "p"))).toBe("");
  });
});

group("operators", () => {
  it("are the project's own first, and what it inherits after", () => {
    const { own, builtIn } = operatorsOf([resource("mine", "lab"), resource("engine", "texera")], "lab");
    expect(own.map(r => r.metadata.rid)).toEqual(["mine"]);
    expect(builtIn.map(r => r.metadata.rid)).toEqual(["engine"]);
  });
});
