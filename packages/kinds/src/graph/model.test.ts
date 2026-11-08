import type { ConversationGraph, GraphNode } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { nameOf, plannedId, relationsOf, runId, runStateOf, SOMEWHERE, touching, viewOf } from "./model";

const D = "texera://datasets/11111111-1111-1111-1111-111111111111";
const W = "texera://workflows/22222222-2222-2222-2222-222222222222";
const W2 = "texera://workflows/33333333-3333-3333-3333-333333333333";
const F = "texera://operators/44444444-4444-4444-4444-444444444444";
const M = "texera://models/55555555-5555-5555-5555-555555555555";
const U = "texera://computing-units/66666666-6666-6666-6666-666666666666";
const U2 = "texera://computing-units/88888888-8888-8888-8888-888888888888";
const E1 = `${W}/executions/77777777-7777-7777-7777-777777777777`;
const E2 = `${W}/executions/99999999-9999-9999-9999-999999999999`;
const port = (exec: string, op: string) => `${exec}/operators/${op}/ports/output-0`;

const node = (uri: string, role: GraphNode["role"], extra: Partial<GraphNode> = {}): GraphNode => ({
  uri,
  role,
  kind: role === "data" ? "dataset" : role,
  name: uri.split("/").at(-1) as string,
  made: false,
  ...extra,
});

/** A screening: the cohort read by a workflow that predicts with a model, calls a function, ran on a unit and made two tables. */
const screening: ConversationGraph = {
  nodes: [
    node(W, "workflow", {
      name: "screen",
      made: true,
      turn: "t1",
      runs: [{ uri: E1, phase: "completed", steps: 4, reused: 0, unit: U }],
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
    node(port(E1, "auc"), "data", { kind: "execution", name: "auc", step: "auc", rows: 1, made: true, run: E1 }),
    node(port(E1, "calib"), "data", { kind: "execution", name: "calib", step: "calib", rows: 10, made: true, run: E1 }),
  ],
  edges: [
    { from: D, to: W, relation: "reads" },
    { from: M, to: W, relation: "uses" },
    { from: F, to: W, relation: "uses" },
    { from: W, to: U, relation: "runsOn" },
    { from: W, to: port(E1, "auc"), relation: "makes" },
    { from: W, to: port(E1, "calib"), relation: "makes" },
  ],
  planned: [],
  sources: [],
};

describe("the view of a chat's graph", () => {
  it("puts what a workflow uses on its card, and its run in a box of its own on the unit, with the tables it made in the order of the steps", () => {
    const view = viewOf(screening);
    const [w] = view.works;
    expect(w?.reads).toEqual([{ data: D, steps: ["cohort"], files: ["pima.csv"] }]);
    expect(w?.uses.map(u => u.name)).toEqual(["Diabetes onset risk", "ROC AUC"]);
    expect(w?.runs).toEqual([runId(W, U)]);
    const box = view.runs.get(runId(W, U));
    expect(box?.runs.map(r => r.uri)).toEqual([E1]);
    expect(box?.results).toEqual([port(E1, "calib"), port(E1, "auc")]);
    expect(box && runStateOf(box)).toBe("completed");
    expect(view.data.get(D)?.files).toEqual(["pima.csv"]);
    expect([view.rank.get(D), view.rank.get(W), view.rank.get(runId(W, U)), view.rank.get(port(E1, "auc"))]).toEqual([
      0, 1, 1, 2,
    ]);
    expect(view.loose).toEqual([]);
    expect(view.idle).toEqual([]);
    expect(nameOf(view, runId(W, U))).toBe("screen on Small");
  });

  it("gives a workflow run on two units a box on each, newest first, and the tables to the box of the run that made them", () => {
    const moved: ConversationGraph = {
      ...screening,
      nodes: [
        node(W, "workflow", {
          ...screening.nodes[0],
          runs: [
            { uri: E2, phase: "running", steps: 4, reused: 0, unit: U2 },
            { uri: E1, phase: "completed", steps: 4, reused: 0, unit: U },
          ],
        }),
        ...screening.nodes.slice(1),
        node(U2, "unit", { name: "Large", state: "ready" }),
      ],
      edges: [...screening.edges, { from: W, to: U2, relation: "runsOn" }],
    };
    const view = viewOf(moved);
    expect(view.works[0]?.runs).toEqual([runId(W, U2), runId(W, U)]);
    const [large, small] = [view.runs.get(runId(W, U2)), view.runs.get(runId(W, U))];
    expect(large && runStateOf(large)).toBe("running");
    expect(large?.results).toEqual([]);
    expect(small?.results).toEqual([port(E1, "calib"), port(E1, "auc")]);
  });

  it("puts a run that does not say its unit on the one unit its workflow ran on, and one on a unit the caller cannot see somewhere", () => {
    const older = viewOf({
      ...screening,
      nodes: [
        node(W, "workflow", { ...screening.nodes[0], runs: [{ uri: E1, phase: "failed", steps: 4, reused: 0 }] }),
        ...screening.nodes.slice(1),
      ],
    });
    expect(older.works[0]?.runs).toEqual([runId(W, U)]);
    expect(runStateOf(older.runs.get(runId(W, U)) as never)).toBe("failed");
    const hidden = viewOf({
      ...screening,
      nodes: [
        node(W, "workflow", {
          ...screening.nodes[0],
          runs: [{ uri: E1, phase: "completed", steps: 4, reused: 0, unit: U2 }],
        }),
        ...screening.nodes.slice(1),
      ],
    });
    expect(hidden.works[0]?.runs).toEqual([runId(W, SOMEWHERE)]);
    // The unit it did not run on stands with nothing on it.
    expect(hidden.idle).toEqual([U]);
  });

  it("puts a workflow that reads another's table one rank past it, its runs with it", () => {
    const chain: ConversationGraph = {
      ...screening,
      nodes: [...screening.nodes, node(W2, "workflow", { name: "follow up", made: true, steps: [] })],
      edges: [
        ...screening.edges,
        { from: port(E1, "auc"), to: W2, relation: "reads" },
        { from: W2, to: U, relation: "runsOn" },
      ],
    };
    const view = viewOf(chain);
    expect(view.rank.get(W2)).toBe(3);
    expect(view.rank.get(runId(W2, U))).toBe(3);
    expect(view.works.map(w => w.id)).toEqual([W, W2]);
    expect(runStateOf(view.runs.get(runId(W2, U)) as never)).toBe("idle");
  });

  it("stands each item of the plan where what it names will stand: the workflow's run on the unit it plans, its dataset beside it", () => {
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
    const box = view.runs.get(w?.runs[0] as string);
    expect(box?.unit).toBe(unit);
    expect(box && runStateOf(box)).toBe("planned");
    expect(box?.results).toEqual([plannedId({ kind: "dataset", name: "Screened", turn: "t2" })]);
    expect(w?.plannedUses.map(p => p.name)).toEqual(["holdout metrics"]);
    expect(view.units.get(unit)?.planned?.detail).toBe("Small");
    // The cohort no workflow reads yet stands at the end of its column.
    expect(view.loose).toEqual([D]);
  });

  it("gives a workflow made and not run its run on the fresh unit made for it, and a planned rerun to the box it ran in", () => {
    const made: ConversationGraph = {
      nodes: [
        node(W, "workflow", { name: "risk screen", made: true, turn: "t2", steps: [] }),
        node(W2, "workflow", {
          name: "hba1c and readmission",
          runs: [{ uri: `${W2}/executions/1`, phase: "completed", steps: 4, reused: 0, unit: U2 }],
          steps: [],
        }),
        node(U, "unit", { name: "Small", state: "starting", made: true, turn: "t2" }),
        node(U2, "unit", { name: "local unit", state: "ready" }),
      ],
      edges: [{ from: W2, to: U2, relation: "runsOn" }],
      planned: [{ kind: "execution", name: "hba1c and readmission, rerun on version 1", turn: "t2" }],
      sources: [],
    };
    const view = viewOf(made);
    expect(view.works.find(w => w.id === W)?.runs).toEqual([runId(W, U)]);
    expect(runStateOf(view.runs.get(runId(W, U)) as never)).toBe("idle");
    // The fresh unit is the plan's target, so the rerun is planned there.
    const rerun = view.works.find(w => w.id === W2)?.runs.map(id => view.runs.get(id));
    expect(rerun?.map(b => [b?.unit, b?.planned?.name !== undefined])).toEqual([
      [U2, false],
      [U, true],
    ]);
    expect(view.idle).toEqual([]);
  });

  it("gives a workflow not run its run on its default unit, and a rerun the plan names to where it ran when no unit was made", () => {
    const view = viewOf({
      nodes: [
        node(W, "workflow", { name: "next", steps: [] }),
        node(W2, "workflow", {
          name: "hba1c and readmission",
          runs: [{ uri: `${W2}/executions/1`, phase: "completed", steps: 4, reused: 0, unit: U2 }],
          steps: [],
        }),
        node(U2, "unit", { name: "local unit", state: "ready" }),
      ],
      edges: [
        { from: W, to: U2, relation: "runsOn" },
        { from: W2, to: U2, relation: "runsOn" },
      ],
      planned: [{ kind: "execution", name: "hba1c and readmission, rerun", turn: "t2" }],
      sources: [],
    });
    expect(runStateOf(view.runs.get(runId(W, U2)) as never)).toBe("idle");
    const box = view.runs.get(runId(W2, U2));
    expect(box?.planned?.name).toContain("rerun");
    expect(box && runStateOf(box)).toBe("completed");
  });

  it("lights up what a thing touches, and says how it stands to the rest", () => {
    const view = viewOf(screening);
    const box = runId(W, U);
    expect([...touching(view, box)].sort()).toEqual([box, D, U, W, port(E1, "auc"), port(E1, "calib")].sort());
    expect([...touching(view, U)].sort()).toEqual([box, U, W].sort());
    expect([...touching(view, port(E1, "auc"))].sort()).toEqual([box, U, W, port(E1, "auc")].sort());
    expect([...touching(view, M)]).toContain(box);
    expect(relationsOf(view, W)).toEqual([
      { label: "Reads", ids: [D] },
      { label: "Uses", ids: [M, F] },
      { label: "Runs", ids: [box] },
      { label: "Made", ids: [port(E1, "calib"), port(E1, "auc")] },
    ]);
    expect(relationsOf(view, box).map(r => r.label)).toEqual(["Of", "On", "Read", "Made"]);
    expect(relationsOf(view, U)).toEqual([{ label: "Runs on it", ids: [box] }]);
    expect(relationsOf(view, port(E1, "auc"))).toEqual([{ label: "Made by", ids: [box] }]);
    expect(relationsOf(view, D)).toEqual([{ label: "Read by", ids: [W] }]);
    expect(relationsOf(view, M)).toEqual([{ label: "Used by", ids: [W] }]);
  });
});
