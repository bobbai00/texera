import type { ConversationGraph, GraphNode } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { entryFor, entryForRef, keyOf, pushed } from "./focus";
import { plannedId, runId, SOMEWHERE, viewOf } from "./model";

const D = "texera://datasets/11111111-1111-1111-1111-111111111111";
const W = "texera://workflows/22222222-2222-2222-2222-222222222222";
const F = "texera://operators/44444444-4444-4444-4444-444444444444";
const M = "texera://models/55555555-5555-5555-5555-555555555555";
const U = "texera://computing-units/66666666-6666-6666-6666-666666666666";
const E = `${W}/executions/77777777-7777-7777-7777-777777777777`;
const T = `${E}/operators/auc/ports/output-0`;
const node = (uri: string, role: GraphNode["role"], extra: Partial<GraphNode> = {}): GraphNode => ({
  uri,
  role,
  kind: role === "data" ? "dataset" : role,
  name: uri.split("/").at(-1) as string,
  made: true,
  ...extra,
});

const graph: ConversationGraph = {
  nodes: [
    node(W, "workflow", {
      name: "screen",
      runs: [{ uri: E, phase: "completed", steps: 2, reused: 0, unit: U }],
      steps: [],
    }),
    node(D, "data", { name: "Pima cohort" }),
    node(F, "function", { name: "ROC AUC" }),
    node(M, "model", { name: "Diabetes onset risk" }),
    node(U, "unit", { name: "Small" }),
    node(T, "data", { kind: "execution", name: "auc", step: "auc", run: E }),
  ],
  edges: [
    { from: D, to: W, relation: "reads" },
    { from: M, to: W, relation: "uses" },
    { from: F, to: W, relation: "uses" },
    { from: W, to: T, relation: "makes" },
  ],
  planned: [{ kind: "dataset", name: "Screened", turn: "t1" }],
  sources: [],
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
    expect(entryFor(view, W)).toMatchObject({ kind: "resource", ref: { kind: "workflow" }, title: "screen" });
    expect(entryFor(view, M)).toMatchObject({ kind: "resource", ref: { kind: "model" } });
    expect(entryFor(view, F)).toMatchObject({ kind: "resource", ref: { kind: "operator" } });
    expect(entryFor(view, U)).toMatchObject({ kind: "resource", ref: { kind: "computing-unit" }, title: "Small" });
  });

  it("shows a run box's runs, a table's rows, and what the plan said of what it has not made", () => {
    expect(entryFor(view, runId(W, U))).toEqual({ kind: "run", id: runId(W, U), title: "screen on Small" });
    expect(entryFor(view, T)).toEqual({ kind: "table", id: T, title: "auc" });
    const planned = plannedId({ kind: "dataset", name: "Screened", turn: "t1" });
    expect(entryFor(view, planned)).toEqual({ kind: "planned", id: planned, title: "Screened" });
    expect(entryFor(view, SOMEWHERE)).toBeUndefined();
    expect(entryFor(view, "texera://nothing/1")).toBeUndefined();
  });

  it("knows a resource a view opens when the graph has it, and opens any other as itself", () => {
    // A version opens at that version, still the graph's node.
    expect(entryForRef(view, { kind: "dataset", rid: D.slice(-36), vno: 1 })).toMatchObject({
      kind: "resource",
      id: D,
      ref: { kind: "dataset", vno: 1 },
      title: "Pima cohort v1",
    });
    expect(keyOf(entryForRef(view, { kind: "dataset", rid: D.slice(-36), vno: 1 }))).not.toBe(
      keyOf(entryFor(view, D) as never)
    );
    const elsewhere = { kind: "dataset" as const, rid: "99999999-9999-9999-9999-999999999999" };
    expect(entryForRef(view, elsewhere)).toEqual({ kind: "resource", ref: elsewhere });
  });

  it("keeps a trail that goes back, never round, when it reaches a place it has been", () => {
    const [a, b, c] = [entryFor(view, W), entryFor(view, runId(W, U)), entryFor(view, T)] as const;
    if (!a || !b || !c) throw new Error("no entries");
    const trail = pushed(pushed(pushed([], a), b), c);
    expect(trail.map(keyOf)).toEqual([keyOf(a), keyOf(b), keyOf(c)]);
    expect(pushed(trail, a).map(keyOf)).toEqual([keyOf(a)]);
    expect(pushed(trail, b).map(keyOf)).toEqual([keyOf(a), keyOf(b)]);
  });
});
