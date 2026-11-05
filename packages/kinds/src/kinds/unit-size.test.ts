import type { ComputingUnitSpec } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { sized, sizeOf } from "./unit-size";

const unit: ComputingUnitSpec = { provider: "kubernetes", computingNodes: [{ name: "master", role: "master", memory: "2Gi" }] };

describe("the size of a computing unit", () => {
  it("is what its master node reserves", () => {
    expect(sizeOf(unit)).toEqual({ memory: "2Gi", cpu: "" });
    expect(sizeOf({ provider: "kubernetes", computingNodes: [{ name: "master", role: "master", memory: "8Gi", cpu: "4" }] })).toEqual({ memory: "8Gi", cpu: "4" });
    expect(sizeOf({ provider: "kubernetes" })).toEqual({ memory: "", cpu: "" });
  });

  it("is set on the master node, keeping what else the spec says", () => {
    const bigger = sized({ ...unit, engine: { image: "texera/unit:dev" } }, { memory: "8Gi", cpu: "4" });
    expect(bigger).toEqual({ provider: "kubernetes", engine: { image: "texera/unit:dev" }, computingNodes: [{ name: "master", role: "master", memory: "8Gi", cpu: "4" }] });
  });

  it("reserves nothing of what is left empty", () => {
    expect(sized(sized(unit, { cpu: "2" }), { cpu: "" })).toEqual(unit);
    expect(sized(unit, { memory: "" }).computingNodes).toEqual([{ name: "master", role: "master" }]);
  });

  it("adds the master node to a spec that has none, and leaves the other nodes alone", () => {
    expect(sized({ provider: "kubernetes" }, { memory: "4Gi" }).computingNodes).toEqual([{ name: "master", role: "master", memory: "4Gi" }]);
    const withWorker: ComputingUnitSpec = { provider: "kubernetes", computingNodes: [{ name: "w1", role: "worker", memory: "1Gi" }, ...(unit.computingNodes ?? [])] };
    expect(sized(withWorker, { memory: "4Gi" }).computingNodes).toEqual([
      { name: "w1", role: "worker", memory: "1Gi" },
      { name: "master", role: "master", memory: "4Gi" },
    ]);
  });
});
