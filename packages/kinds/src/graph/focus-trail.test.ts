import type { GraphNode, GraphVersion, ResourceGraph } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { entryFor, entryForRef, type FocusEntry, keyOf, pushed } from "./focus-trail";
import { plannedId, viewOf } from "./model";

const D = "texera://datasets/11111111-1111-1111-1111-111111111111";
const S = "texera://datasets/13131313-1313-1313-1313-131313131313";
const W = "texera://workflows/22222222-2222-2222-2222-222222222222";
const F = "texera://operators/44444444-4444-4444-4444-444444444444";
const M = "texera://models/55555555-5555-5555-5555-555555555555";
const U = "texera://computing-units/66666666-6666-6666-6666-666666666666";
const E = `${W}/executions/77777777-7777-7777-7777-777777777777`;
const T = `${E}/operators/auc/ports/output-0`;

const version = (vno: number): GraphVersion => ({ vno, made: false });
const node = (uri: string, role: GraphNode["role"], name: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  uri,
  role,
  kind: role === "data" ? "dataset" : role === "function" ? "operator" : role,
  name,
  readable: true,
  versions: [version(1)],
  made: false,
  ...extra,
});

const graph: ResourceGraph = {
  nodes: [
    node(W, "workflow", "screen", { versions: [version(2), version(1)] }),
    node(D, "data", "Pima cohort"),
    node(S, "data", "", { readable: false }),
    node(M, "model", "Risk model"),
    node(F, "function", "ROC AUC"),
  ],
  executions: [
    {
      uri: E,
      workflow: W,
      version: 1,
      name: "execution",
      phase: "completed",
      steps: 2,
      reused: 0,
      made: true,
      createdBy: "alice",
      unit: { uri: U, name: "Small" },
    },
  ],
  results: [{ uri: T, execution: E, operator: "auc", operatorType: "Aggregate", displayName: "AUC" }],
  edges: [
    { from: `${D}@1`, to: `${W}@1`, relation: "reads", executed: true },
    { from: `${S}@1`, to: `${W}@2`, relation: "reads", executed: false },
    { from: `${F}@1`, to: `${W}@1`, relation: "uses", executed: true },
  ],
  planned: [{ kind: "dataset", name: "Calibration", turn: "t2" }],
  sources: [],
  units: [],
};

describe("going into a thing on the graph", () => {
  const view = viewOf(graph);

  it("shows a resource's own view for a dataset, a workflow, a model, a function and a unit", () => {
    expect(entryFor(view, D)).toEqual({
      kind: "resource",
      ref: { kind: "dataset", rid: D.slice(-36) },
      id: D,
      title: "Pima cohort",
    });
    expect(entryFor(view, W)?.kind).toBe("resource");
    expect(entryFor(view, M)?.title).toBe("Risk model");
    expect(entryFor(view, F)).toMatchObject({ kind: "resource", ref: { kind: "operator" }, title: "ROC AUC" });
    expect(entryFor(view, U)).toMatchObject({ kind: "resource", ref: { kind: "computing-unit" }, title: "Small" });
  });

  it("opens a version at that version, a workflow version on its canvas", () => {
    expect(entryFor(view, `${W}@1`)).toEqual({
      kind: "resource",
      ref: { kind: "workflow", rid: W.slice(-36), vno: 1 },
      id: `${W}@1`,
      title: "screen v1",
    });
    expect(entryFor(view, `${D}@1`)).toMatchObject({ ref: { kind: "dataset", vno: 1 }, title: "Pima cohort v1" });
  });

  it("shows an execution, a result's rows, and what the plan said of what it has not made", () => {
    expect(entryFor(view, E)).toEqual({ kind: "run", id: E, title: "Execution of screen v1" });
    expect(entryFor(view, T)).toEqual({ kind: "table", id: T, title: "AUC" });
    const planned = plannedId({ kind: "dataset", name: "Calibration", turn: "t2" });
    expect(entryFor(view, planned)).toEqual({ kind: "planned", id: planned, title: "Calibration" });
  });

  it("opens nothing for what is not shared", () => {
    expect(entryFor(view, S)).toBeUndefined();
    expect(entryFor(view, `${S}@1`)).toBeUndefined();
  });

  it("knows a resource a view opens when the graph has it, at the version asked, and opens any other as itself", () => {
    expect(entryForRef(view, { kind: "workflow", rid: W.slice(-36) })).toMatchObject({ kind: "resource", id: W });
    expect(entryForRef(view, { kind: "workflow", rid: W.slice(-36), vno: 2 })).toMatchObject({
      id: `${W}@2`,
      title: "screen v2",
    });
    expect(entryForRef(view, { kind: "dataset", rid: D.slice(-36), vno: 3 })).toMatchObject({
      ref: { vno: 3 },
      title: "Pima cohort v3",
    });
    const other = { kind: "dataset" as const, rid: "99999999-9999-9999-9999-999999999999" };
    expect(entryForRef(view, other)).toEqual({ kind: "resource", ref: other });
  });

  it("keeps a trail that goes back, never round, when it reaches a place it has been", () => {
    const a = entryFor(view, W) as FocusEntry;
    const b = entryFor(view, E) as FocusEntry;
    const c = entryFor(view, `${W}@1`) as FocusEntry;
    const trail = pushed(pushed(pushed([], a), b), c);
    expect(trail.map(keyOf)).toEqual([keyOf(a), keyOf(b), keyOf(c)]);
    expect(pushed(trail, a).map(keyOf)).toEqual([keyOf(a)]);
  });
});
