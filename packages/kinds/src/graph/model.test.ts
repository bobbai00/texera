import type { ConversationGraph, GraphNode } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { plannedId, viewOf } from "./model";

const D = "texera://datasets/11111111-1111-1111-1111-111111111111";
const W = "texera://workflows/22222222-2222-2222-2222-222222222222";
const W2 = "texera://workflows/33333333-3333-3333-3333-333333333333";
const F = "texera://operators/44444444-4444-4444-4444-444444444444";
const M = "texera://models/55555555-5555-5555-5555-555555555555";
const U = "texera://computing-units/66666666-6666-6666-6666-666666666666";
const port = (wf: string, op: string) =>
  `${wf}/executions/77777777-7777-7777-7777-777777777777/operators/${op}/ports/output-0`;

const node = (uri: string, role: GraphNode["role"], extra: Partial<GraphNode> = {}): GraphNode => ({
  uri,
  role,
  kind: role === "data" ? "dataset" : role,
  name: uri.split("/").at(-1) as string,
  made: false,
  ...extra,
});

/** A screening: the cohort read by a workflow that predicts with a model, calls a function, runs on a unit and makes two tables. */
const screening: ConversationGraph = {
  nodes: [
    node(W, "workflow", {
      name: "screen",
      made: true,
      turn: "t1",
      runs: [{ uri: `${W}/executions/1`, phase: "completed", steps: 4, reused: 0 }],
      steps: [
        { id: "cohort", type: "scan", settings: { file: `${D}@1/files/pima.csv` } },
        { id: "scored", type: "predict", settings: { model: `${M}@1` }, inputs: ["cohort"] },
        { id: "calib", type: `${F}@1`, settings: { bands: 10 }, inputs: ["scored"] },
        { id: "auc", type: `${F}@1`, inputs: ["scored"] },
      ],
    }),
    node(D, "data", { name: "Pima cohort", version: 1, made: true }),
    node(F, "function", { name: "ROC AUC", version: 1 }),
    node(M, "model", { name: "Diabetes onset risk", version: 1 }),
    node(U, "unit", { name: "Small", state: "ready", made: true }),
    node(port(W, "auc"), "data", { kind: "execution", name: "auc", step: "auc", rows: 1, made: true }),
    node(port(W, "calib"), "data", { kind: "execution", name: "calib", step: "calib", rows: 10, made: true }),
  ],
  edges: [
    { from: D, to: W, relation: "reads" },
    { from: M, to: W, relation: "uses" },
    { from: F, to: W, relation: "uses" },
    { from: W, to: U, relation: "runsOn" },
    { from: W, to: port(W, "auc"), relation: "makes" },
    { from: W, to: port(W, "calib"), relation: "makes" },
  ],
  planned: [],
  sources: [],
};

describe("the view of a chat's graph", () => {
  it("puts what a workflow uses on it, its unit around it, and its tables in the order of its steps", () => {
    const view = viewOf(screening);
    const [w] = view.works;
    expect(w?.reads).toEqual([{ data: D, steps: ["cohort"], files: ["pima.csv"] }]);
    expect(w?.uses.map(u => u.name)).toEqual(["Diabetes onset risk", "ROC AUC"]);
    expect(w?.unit).toBe(U);
    expect(w?.results).toEqual([port(W, "calib"), port(W, "auc")]);
    expect(view.data.get(D)?.files).toEqual(["pima.csv"]);
    expect([view.rank.get(D), view.rank.get(W), view.rank.get(port(W, "auc"))]).toEqual([0, 1, 2]);
    expect(view.loose).toEqual([]);
    expect(view.idle).toEqual([]);
  });

  it("puts a workflow that reads another's table one rank past it", () => {
    const chain: ConversationGraph = {
      ...screening,
      nodes: [...screening.nodes, node(W2, "workflow", { name: "follow up", made: true, steps: [] })],
      edges: [...screening.edges, { from: port(W, "auc"), to: W2, relation: "reads" }],
    };
    const view = viewOf(chain);
    expect(view.rank.get(W2)).toBe(3);
    expect(view.works.map(w => w.id)).toEqual([W, W2]);
  });

  it("stands each item of the plan where what it names will stand", () => {
    const fresh: ConversationGraph = {
      nodes: [node(D, "data", { name: "Pima cohort", made: true, turn: "t1" })],
      edges: [],
      planned: [
        { kind: "computing-unit", name: "Diabetes scoring", detail: "Small", turn: "t2" },
        { kind: "workflow", name: "risk screen", turn: "t2" },
        { kind: "dataset", name: "Screened", turn: "t2" },
        { kind: "operator", name: "holdout metrics", turn: "t2" },
      ],
      sources: [],
    };
    const view = viewOf(fresh);
    const unit = plannedId({ kind: "computing-unit", name: "Diabetes scoring", turn: "t2" });
    const [w] = view.works;
    expect(w?.planned?.name).toBe("risk screen");
    expect(w?.unit).toBe(unit);
    expect(w?.results).toEqual([plannedId({ kind: "dataset", name: "Screened", turn: "t2" })]);
    expect(w?.plannedUses.map(p => p.name)).toEqual(["holdout metrics"]);
    expect(view.units.get(unit)?.planned?.detail).toBe("Small");
    // The cohort no workflow reads yet stands at the end of the inputs.
    expect(view.loose).toEqual([D]);
  });

  it("puts a workflow made and not run in the fresh unit made for it, and a planned run on the workflow it names", () => {
    const made: ConversationGraph = {
      nodes: [
        node(W, "workflow", { name: "risk screen", made: true, turn: "t2", steps: [] }),
        node(W2, "workflow", {
          name: "hba1c and readmission",
          runs: [{ uri: `${W2}/executions/1`, phase: "completed", steps: 4, reused: 0 }],
          steps: [],
        }),
        node(U, "unit", { name: "Small", state: "starting", made: true, turn: "t2" }),
      ],
      edges: [],
      planned: [{ kind: "execution", name: "hba1c and readmission, rerun on version 1", turn: "t2" }],
      sources: [],
    };
    const view = viewOf(made);
    expect(view.works.find(w => w.id === W)?.unit).toBe(U);
    expect(view.works.find(w => w.id === W2)?.unit).toBeUndefined();
    expect(view.works.find(w => w.id === W2)?.plannedRun?.name).toContain("rerun");
    expect(view.idle).toEqual([]);
  });
});
