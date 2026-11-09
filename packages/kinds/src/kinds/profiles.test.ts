import type { ComputingUnitSpec } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import {
  changeLabel,
  changesFrom,
  madeFrom,
  makeupFacts,
  masterOf,
  packageName,
  sizeLabel,
  withMakeup,
} from "./profiles";

const unit: ComputingUnitSpec = {
  provider: "kubernetes",
  computingNodes: [
    { name: "master", role: "master", profile: "texera://profiles/p@1", memory: "2Gi", packages: ["pandas"] },
  ],
};

describe("what a node is made of", () => {
  it("knows a package by the name pip compares", () => {
    expect(packageName(" Scikit_Learn>=1.5")).toBe("scikit-learn");
    expect(packageName("zope.interface==6")).toBe("zope-interface");
    expect(packageName("pyarrow[pandas]")).toBe("pyarrow");
    expect(packageName("mylib @ https://x.org/a.whl")).toBe("mylib");
  });

  it("says a size and a makeup in words", () => {
    expect(sizeLabel({ memory: "4Gi", cpu: "2", gpu: 1 })).toBe("2 cores · 4 GB · 1 GPU");
    expect(sizeLabel({ memory: "3Gi", cpu: "500m" })).toBe("500m cores · 3Gi");
    expect(sizeLabel({})).toBe("");
    expect(makeupFacts({ memory: "2Gi", packages: ["pandas", "numpy"] })).toEqual(["2 GB", "2 packages"]);
    expect(makeupFacts({ packages: ["pandas"] })).toEqual(["1 package"]);
  });

  it("is as its profile until it changes: then each size and package that differs, in words", () => {
    const profile = { memory: "2Gi", packages: ["pandas", "numpy"] };
    expect(changesFrom(profile, { memory: "2Gi", packages: ["numpy", "pandas"] })).toEqual([]);
    // Written another way, a package is the same package.
    expect(changesFrom(profile, { memory: "2Gi", packages: ["NumPy", " pandas "] })).toEqual([]);
    const changes = changesFrom(profile, { memory: "4Gi", gpu: 1, packages: ["pandas==2.2.3", "humanize"] });
    expect(changes.map(changeLabel)).toEqual([
      "memory 2 GB → 4 GB",
      "GPU none → 1 GPU",
      "pandas → pandas==2.2.3",
      "− numpy",
      "+ humanize",
    ]);
  });

  it("is changed on the unit's master node, which then says only what it is made of", () => {
    const changed = withMakeup(unit, { memory: "4Gi", packages: ["pandas", "humanize"] });
    expect(masterOf(changed)).toEqual({
      name: "master",
      role: "master",
      profile: "texera://profiles/p@1",
      memory: "4Gi",
      packages: ["pandas", "humanize"],
    });
    expect(masterOf(withMakeup(unit, {}))).toEqual({
      name: "master",
      role: "master",
      profile: "texera://profiles/p@1",
    });
    expect(masterOf(withMakeup({ provider: "kubernetes" }, { memory: "8Gi" }))).toEqual({
      name: "master",
      role: "master",
      memory: "8Gi",
    });
    // What else the spec says, and its other nodes, stay as they are.
    const more: ComputingUnitSpec = {
      provider: "kubernetes",
      engine: { image: "texera/unit:dev" },
      computingNodes: [{ name: "w1", role: "worker", memory: "1Gi" }, ...(unit.computingNodes ?? [])],
    };
    expect(withMakeup(more, { memory: "4Gi" })).toEqual({
      provider: "kubernetes",
      engine: { image: "texera/unit:dev" },
      computingNodes: [
        { name: "w1", role: "worker", memory: "1Gi" },
        { name: "master", role: "master", profile: "texera://profiles/p@1", memory: "4Gi" },
      ],
    });
  });

  it("is a profile's when the unit is made from one, which the catalog then fills in", () => {
    expect(masterOf(madeFrom(unit, "texera://profiles/q"))).toEqual({
      name: "master",
      role: "master",
      profile: "texera://profiles/q",
    });
    expect(masterOf(madeFrom(unit, undefined))).toEqual({ name: "master", role: "master", memory: "2Gi" });
  });
});
