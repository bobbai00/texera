import type { GraphNode } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { lineOf } from "./steps";

const F = "texera://operators/44444444-4444-4444-4444-444444444444";
const M = "texera://models/55555555-5555-5555-5555-555555555555";
const D = "texera://datasets/11111111-1111-1111-1111-111111111111";
const nodes = new Map<string, GraphNode>([
  [F, { uri: F, role: "function", kind: "operator", name: "ROC AUC", made: false }],
  [M, { uri: M, role: "model", kind: "model", name: "Diabetes onset risk", made: false }],
]);

describe("a step's row", () => {
  it("names the function, the model and the file a step uses", () => {
    expect(lineOf({ id: "auc", type: `${F}@2`, settings: { label: "Outcome", score: "risk" } }, nodes)).toMatchObject({
      op: "ROC AUC",
      text: "label Outcome · score risk",
      uses: { name: "ROC AUC" },
    });
    expect(lineOf({ id: "scored", type: "predict", settings: { model: `${M}@1` } }, nodes)).toMatchObject({
      op: "predict",
      uses: { name: "Diabetes onset risk" },
    });
    expect(
      lineOf({ id: "cohort", type: "scan", settings: { file: `${D}@1/files/pima%20cohort.csv` } }, nodes)
    ).toMatchObject({ op: "scan", file: "pima cohort.csv" });
    expect(lineOf({ id: "held", type: "scan", settings: { file: `${M}@1/files/holdout.csv` } }, nodes)).toMatchObject({
      op: "scan",
      file: "holdout.csv",
      uses: { name: "Diabetes onset risk" },
    });
  });

  it("says a built-in's settings in short", () => {
    expect(lineOf({ id: "lows", type: "filter", settings: { where: "glucose < 70" } }, nodes).text).toBe(
      "where glucose < 70"
    );
    expect(
      lineOf({ id: "by", type: "aggregate", settings: { by: ["participant"], outputs: ["n = count(*)"] } }, nodes).text
    ).toBe("by participant · outputs n = count(*)");
    expect(lineOf({ id: "view", type: "project", settings: { keep: ["a", "b", "c", "d", "e"] } }, nodes).text).toBe(
      "keep 5 columns"
    );
  });
});
