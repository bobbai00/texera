import type { GraphExecution, GraphNode, GraphVersion, PlannedItem, ResourceGraph } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { type Box, elbow, type Layout, layOut, type Measured } from "./layout";
import { boxOfRow, type GraphView, type Level, viewOf } from "./model";

const D = "texera://datasets/11111111-1111-1111-1111-111111111111";
const L = "texera://datasets/12121212-1212-1212-1212-121212121212";
const W = "texera://workflows/22222222-2222-2222-2222-222222222222";
const W2 = "texera://workflows/33333333-3333-3333-3333-333333333333";
const M = "texera://models/88888888-8888-8888-8888-888888888888";
const exec = (wf: string, n: number) => `${wf}/executions/7777777${n}-7777-7777-7777-777777777777`;
const port = (e: string, op: string) => `${e}/operators/${op}/ports/output-0`;

const version = (vno: number, extra: Partial<GraphVersion> = {}): GraphVersion => ({ vno, made: false, ...extra });
const node = (uri: string, role: GraphNode["role"], versions: GraphVersion[]): GraphNode => ({
  uri,
  role,
  kind: role === "data" ? "dataset" : role === "function" ? "operator" : role,
  name: uri.slice(-4),
  readable: true,
  versions,
  made: true,
});
const execution = (uri: string, workflow: string, vno: number): GraphExecution => ({
  uri,
  workflow,
  version: vno,
  name: "execution",
  phase: "completed",
  steps: 3,
  reused: 0,
  made: true,
  createdBy: "alice",
});

/** A workflow whose version 1 read the cohort and version 2 the cohort and the labs, each executed once and keeping a table; version 3, the newest, not executed. */
const versions: ResourceGraph = {
  nodes: [
    node(W, "workflow", [version(3), version(2, { executions: 1 }), version(1, { executions: 1 })]),
    node(D, "data", [version(1, { files: ["a.csv"] })]),
    node(L, "data", [version(1, { files: ["b.csv"] })]),
    node(M, "model", [version(1)]),
  ],
  executions: [execution(exec(W, 2), W, 2), execution(exec(W, 1), W, 1)],
  results: [
    { uri: port(exec(W, 2), "t2"), execution: exec(W, 2), operator: "t2", operatorType: "Aggregate", rows: 5 },
    { uri: port(exec(W, 1), "t1"), execution: exec(W, 1), operator: "t1", operatorType: "Aggregate", rows: 3 },
  ],
  edges: [
    { from: `${D}@1`, to: `${W}@1`, relation: "reads", executed: true },
    { from: `${D}@1`, to: `${W}@2`, relation: "reads", executed: true },
    { from: `${L}@1`, to: `${W}@2`, relation: "reads", executed: true },
    { from: `${D}@1`, to: `${W}@3`, relation: "reads", executed: false },
    { from: `${L}@1`, to: `${W}@3`, relation: "reads", executed: false },
    { from: `${M}@1`, to: `${W}@2`, relation: "uses", executed: true },
  ],
  planned: [],
  sources: [],
  units: [],
};

/** Sizes as the page would measure them: a box is taller by a row for each of its versions zoomed in. */
function measured(view: GraphView, level: Level): Measured {
  const header = 30;
  const line = 20;
  const zoomedIn = level === "versions";
  return {
    size: id => {
      const box = view.boxes.get(id);
      if (box) {
        const w = box.role === "workflow" ? 200 : 150;
        return { w, h: header + (zoomedIn ? box.rows.length * line : 0) };
      }
      if (view.runs.has(id)) return { w: 150, h: 50 };
      if (view.results.has(id)) return { w: 120, h: 34 };
      return undefined;
    },
    row: (id, row) => {
      const at = view.boxes.get(id)?.rows.indexOf(row) ?? -1;
      return zoomedIn && at >= 0 ? header + at * line + line / 2 : undefined;
    },
  };
}

const lay = (graph: ResourceGraph, level: Level) => {
  const view = viewOf(graph);
  return { view, layout: layOut(view, measured(view, level), level, 12) };
};
const at = (l: Layout, id: string) => l.places.get(id) as Box;
const NAMES: Record<string, string> = { [D]: "D", [L]: "L", [W]: "W", [W2]: "W2", [M]: "M" };
/** A thing of the graph in short: D, W@2, an execution's number, a result's operator. */
const short = (id: string): string => {
  if (NAMES[id]) return NAMES[id];
  if (id.includes("/operators/")) return id.split("/operators/")[1]?.split("/")[0] ?? id;
  if (id.includes("/executions/")) return `e${id.split("/executions/")[1]?.slice(7, 8)}`;
  const box = boxOfRow(id);
  return NAMES[box] ? `${NAMES[box]}${id.slice(box.length)}` : id;
};
const said = (l: Layout, relations: string[]) =>
  l.arrows
    .filter(a => relations.includes(a.relation))
    .map(a => `${short(a.from)}>${short(a.to)}${a.dashed ? " dashed" : ""}`);
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("the lineage graph's layout", () => {
  it("zoomed out reads data, workflow, results: no execution, one arrow from each resource", () => {
    const { layout } = lay(versions, "resources");
    expect(layout.columns.map(c => c.label)).toEqual(["Data", "Model", "Workflow", "Result"]);
    expect(layout.places.has(exec(W, 1))).toBe(false);
    expect(at(layout, D).x + at(layout, D).w).toBeLessThan(at(layout, W).x);
    // The newest execution's table, level with the workflow.
    expect(at(layout, port(exec(W, 2), "t2")).y).toBe(at(layout, W).y);
    expect(layout.places.has(port(exec(W, 1), "t1"))).toBe(false);
    expect(said(layout, ["reads", "uses", "makes"])).toEqual(["D>W", "L>W", "M>W", "W>t2"]);
  });

  it("zoomed in stands each execution level with the row of the version it ran, its table level with it", () => {
    const { view, layout } = lay(versions, "versions");
    expect(layout.columns.map(c => c.label)).toEqual(["Data", "Model", "Workflow", "Execution", "Result"]);
    const card = at(layout, W);
    const rowY = (row: string) => card.y + (measured(view, "versions").row(W, row) as number);
    const e2 = at(layout, exec(W, 2));
    const e1 = at(layout, exec(W, 1));
    expect(e2.y).toBeLessThan(e1.y);
    // Each as level with its version's row as the one above allows.
    expect(e1.y + Math.min(e1.h / 2, 1.2 * 12)).toBeGreaterThanOrEqual(rowY(`${W}@1`));
    expect(at(layout, port(exec(W, 2), "t2")).y).toBe(e2.y);
    expect(at(layout, port(exec(W, 1), "t1")).y).toBe(e1.y);
    // The executions come out of their own rows.
    const runs = layout.arrows.filter(a => a.relation === "runs");
    expect(runs.map(a => `${short(a.from)}>${short(a.to)}`)).toEqual(["W@2>e2", "W@1>e1"]);
    expect(runs[1]?.path.startsWith(`M${card.x + card.w},${rowY(`${W}@1`)}`)).toBe(true);
  });

  it("zoomed in runs each arrow from the version read to the version that read it, dashed where only named", () => {
    const { layout } = lay(versions, "versions");
    expect(said(layout, ["reads", "uses"])).toEqual([
      "D@1>W@1",
      "D@1>W@2",
      "L@1>W@2",
      "D@1>W@3 dashed",
      "L@1>W@3 dashed",
      "M@1>W@2",
    ]);
    expect(said(layout, ["runs", "makes"])).toEqual(["W@2>e2", "e2>t2", "W@1>e1", "e1>t1"]);
  });

  it("stands what a version reads level with the row that reads it, and the models under all the data", () => {
    const { view, layout } = lay(versions, "versions");
    const m = measured(view, "versions");
    const card = at(layout, W);
    const d = at(layout, D);
    // The cohort's row is level with the first workflow row that reads it, the newest's.
    expect(d.y + (m.row(D, `${D}@1`) as number)).toBe(card.y + (m.row(W, `${W}@3`) as number));
    const lowest = Math.max(at(layout, D).y + at(layout, D).h, at(layout, L).y + at(layout, L).h);
    expect(at(layout, M).y).toBeGreaterThan(lowest);
    expect(layout.columns.find(c => c.label === "Model")?.y).toBeGreaterThan(lowest);
  });

  it("gives a later workflow the next band, and moves nothing drawn", () => {
    const more: ResourceGraph = {
      ...versions,
      nodes: [...versions.nodes, node(W2, "workflow", [version(1, { executions: 1 })])],
      executions: [...versions.executions, execution(exec(W2, 3), W2, 1)],
      edges: [...versions.edges, { from: `${L}@1`, to: `${W2}@1`, relation: "reads", executed: true }],
    };
    for (const level of ["resources", "versions"] as const) {
      const before = lay(versions, level).layout;
      const after = lay(more, level).layout;
      for (const [id, b] of before.places) expect(after.places.get(id)).toEqual(b);
      expect(at(after, W2).y).toBeGreaterThan(at(after, W).y + at(after, W).h);
    }
  });

  it("draws an elbow only where the ends are not level, turning where it is told", () => {
    expect(elbow(0, 10, 100, 10, 12)).toBe("M0,10H100");
    const turned = elbow(0, 10, 100, 60, 12, 80);
    expect(turned.startsWith("M0,10H")).toBe(true);
    expect(turned).toContain("V");
    expect(turned.endsWith("H100")).toBe(true);
  });
});

describe("the layout, whatever the plan says", () => {
  const plans: PlannedItem[][] = [
    [{ kind: "workflow", name: "Next", turn: "t2" }],
    [
      { kind: "workflow", name: "Next", turn: "t2" },
      { kind: "dataset", name: "Table", turn: "t2" },
      { kind: "computing-unit", name: "Medium", turn: "t2" },
    ],
    [
      { kind: "execution", name: "rerun", turn: "t2" },
      { kind: "dataset", name: "Alone", turn: "t2" },
    ],
  ];
  for (const level of ["resources", "versions"] as const)
    it(`overlaps nothing ${level === "resources" ? "zoomed out" : "zoomed in"}`, () => {
      for (const planned of plans) {
        const { layout } = lay({ ...versions, planned }, level);
        const boxes = [...layout.places.entries()];
        for (const [i, [a, ba]] of boxes.entries())
          for (const [b, bb] of boxes.slice(i + 1))
            if (overlaps(ba, bb)) throw new Error(`${a} overlaps ${b} with ${JSON.stringify(planned)}`);
        for (const a of layout.arrows) expect(a.path).not.toContain("NaN");
        expect(boxOfRow(`${W}@2`)).toBe(W);
      }
    });
});
