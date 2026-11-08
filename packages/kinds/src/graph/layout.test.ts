import type { ConversationGraph, GraphNode, PlannedItem } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { elbow, footId, type Layout, layOut, type Measured } from "./layout";
import { runId, viewOf } from "./model";

const D = "texera://datasets/11111111-1111-1111-1111-111111111111";
const D2 = "texera://datasets/12121212-1212-1212-1212-121212121212";
const W = "texera://workflows/22222222-2222-2222-2222-222222222222";
const W2 = "texera://workflows/33333333-3333-3333-3333-333333333333";
const U = "texera://computing-units/66666666-6666-6666-6666-666666666666";
const U2 = "texera://computing-units/67676767-6767-6767-6767-676767676767";
const exec = (wf: string, n = 1) => `${wf}/executions/7777777${n}-7777-7777-7777-777777777777`;
const port = (wf: string, op: string, n = 1) => `${exec(wf, n)}/operators/${op}/ports/output-0`;
const node = (uri: string, role: GraphNode["role"], extra: Partial<GraphNode> = {}): GraphNode => ({
  uri,
  role,
  kind: role === "data" ? "dataset" : role,
  name: uri.slice(-4),
  made: true,
  ...extra,
});

const work = (uri: string, dataset: string, table: string, extra: Partial<GraphNode> = {}) =>
  node(uri, "workflow", {
    runs: [{ uri: exec(uri), phase: "completed", steps: 3, reused: 0, unit: U }],
    steps: [
      { id: "scan", type: "scan", settings: { file: `${dataset}@1/files/a.csv` } },
      { id: "mid", type: "filter", settings: { where: "x > 1" }, inputs: ["scan"] },
      { id: table, type: "aggregate", inputs: ["mid"] },
    ],
    ...extra,
  });

/** One workflow run on a unit: it reads a dataset and its run makes a table. */
const one: ConversationGraph = {
  nodes: [
    work(W, D, "t1"),
    node(D, "data"),
    node(U, "unit"),
    node(port(W, "t1"), "data", { kind: "execution", step: "t1", rows: 3, run: exec(W) }),
  ],
  edges: [
    { from: D, to: W, relation: "reads" },
    { from: W, to: U, relation: "runsOn" },
    { from: W, to: port(W, "t1"), relation: "makes" },
  ],
  planned: [],
  sources: [],
};
/** The same, and a second workflow run on the same unit that arrives later. */
const two: ConversationGraph = {
  ...one,
  nodes: [
    ...one.nodes,
    work(W2, D2, "t2"),
    node(D2, "data"),
    node(port(W2, "t2"), "data", { kind: "execution", step: "t2", rows: 5, run: exec(W2) }),
  ],
  edges: [
    ...one.edges,
    { from: D2, to: W2, relation: "reads" },
    { from: W2, to: U, relation: "runsOn" },
    { from: W2, to: port(W2, "t2"), relation: "makes" },
  ],
};

/** Sizes as the page would measure them: a dataset 140 by 40, a workflow 220 by 120, a run 110 by 30, a unit 160 by 44, a table 130 by 36; steps 20 apart. */
const measured: Measured = {
  size: id =>
    id.startsWith("run:")
      ? { w: 110, h: 30 }
      : id.startsWith("foot:")
        ? { w: 160, h: 44 }
        : id.includes("/executions/")
          ? { w: 130, h: 36 }
          : id.startsWith("texera://workflows/")
            ? { w: 220, h: 120 }
            : id.startsWith("texera://datasets/")
              ? { w: 140, h: 40 }
              : undefined,
  row: (id, row) => {
    if (id.startsWith("texera://datasets/")) return row === "file:a.csv" ? 30 : undefined;
    const at = ["scan", "mid", "t1", "t2"].indexOf(row);
    return at < 0 ? undefined : 50 + at * 20;
  },
};
const EM = 12.5;
const mid = (b: { y: number; h: number } | undefined) => (b?.y as number) + (b?.h as number) / 2;

describe("the resource graph's layout", () => {
  it("puts a workflow's inputs level with it, its run beside it in its unit's lane, the unit at the lane's foot, and the tables level with the run", () => {
    const layout = layOut(viewOf(one), measured, "standard", EM);
    const at = (id: string) => layout.places.get(id);
    const run = runId(W, U);
    expect(at(D)?.x).toBeLessThan(at(W)?.x as number);
    expect(at(run)?.x).toBeGreaterThan((at(W)?.x as number) + 220);
    expect(at(port(W, "t1"))?.x).toBeGreaterThan((at(run)?.x as number) + 110);
    // Level: the dataset's middle, the run's and the table's meet the workflow's head.
    const head = (at(W)?.y as number) + 20;
    expect(mid(at(D))).toBe(head);
    expect(mid(at(run))).toBe(head);
    expect(mid(at(port(W, "t1")))).toBe(head);
    // The unit at the foot of its lane, under the row; the lane's middle is the run's.
    expect(layout.lanes).toHaveLength(1);
    const [lane] = layout.lanes;
    expect(lane?.unit).toBe(U);
    expect(lane?.x).toBe((at(run)?.x as number) + 55);
    expect(lane?.foot.y).toBeGreaterThan((at(W)?.y as number) + 120);
    expect((lane?.foot.x as number) + 80).toBe(lane?.x);
    // Ties: the run to its workflow, level; the lane's rail down to the unit.
    expect(layout.ties.map(t => [t.kind, t.ends])).toEqual([
      ["tether", [W, run]],
      ["rail", [U]],
    ]);
    expect(layout.ties[0]?.path).toBe(`M${(at(W)?.x as number) + 220},${head}L${at(run)?.x},${head}`);
    expect(layout.ties[1]?.path).toBe(`M${lane?.x},${head}V${lane?.foot.y}`);
    expect(layout.columns.map(c => c.label)).toEqual(["Data", "Computation", "Results"]);
    // Arrows are data only, and run straight between things that are level.
    expect(layout.arrows.map(a => [a.relation, a.from, a.to])).toEqual([
      ["reads", D, W],
      ["makes", run, port(W, "t1")],
    ]);
    for (const a of layout.arrows) expect(a.path).not.toContain("Q");
  });

  it("gives a later workflow the next row, its run in the same lane, and moves nothing but the unit down", () => {
    const before = layOut(viewOf(one), measured, "standard", EM);
    const after = layOut(viewOf(two), measured, "standard", EM);
    for (const [id, box] of before.places) expect(after.places.get(id), id).toEqual(box);
    expect((after.places.get(W2)?.y as number) > (after.places.get(W)?.y as number) + 120).toBe(true);
    expect(after.places.get(runId(W2, U))?.x).toBe(after.places.get(runId(W, U))?.x);
    expect(after.lanes).toHaveLength(1);
    expect(after.lanes[0]?.foot.y).toBeGreaterThan((after.places.get(W2)?.y as number) + 120);
  });

  it("at the closest level runs the run the height of the steps, and stands each table and file level with its step", () => {
    const layout = layOut(viewOf(one), measured, "detail", EM);
    const w = layout.places.get(W) as { x: number; y: number; w: number; h: number };
    const run = layout.places.get(runId(W, U));
    expect(run?.y).toBeCloseTo(w.y + 0.35 * EM);
    expect(run?.h).toBeCloseTo(w.h - 0.7 * EM);
    const t = layout.places.get(port(W, "t1"));
    expect((t?.y as number) + 18).toBe(w.y + 50 + 2 * 20);
    const d = layout.places.get(D);
    expect((d?.y as number) + 30).toBe(w.y + 50);
    // The table's arrow leaves the run level with the table.
    const makes = layout.arrows.find(a => a.relation === "makes");
    const end = Math.round(((t?.x as number) - 0.5 * EM * 0.85) * 100) / 100;
    expect(makes?.path).toBe(`M${(run?.x as number) + 110},${w.y + 90}H${end}`);
  });

  it("gives a workflow run on two units a box in each lane, one under the other, and the units side by side at the foot", () => {
    const moved: ConversationGraph = {
      ...one,
      nodes: [
        work(W, D, "t1", {
          runs: [
            { uri: exec(W, 2), phase: "running", steps: 3, reused: 0, unit: U2 },
            { uri: exec(W, 1), phase: "completed", steps: 3, reused: 0, unit: U },
          ],
        }),
        ...one.nodes.slice(1),
        node(U2, "unit"),
      ],
    };
    const layout = layOut(viewOf(moved), measured, "standard", EM);
    const [a, b] = [layout.places.get(runId(W, U2)), layout.places.get(runId(W, U))];
    // The newest run's unit first, so its lane is the first.
    expect(layout.lanes.map(l => l.unit)).toEqual([U2, U]);
    expect((a?.x as number) < (b?.x as number)).toBe(true);
    expect((b?.y as number) >= (a?.y as number) + (a?.h as number)).toBe(true);
    expect(layout.lanes[0]?.foot.y).toBe(layout.lanes[1]?.foot.y);
    // The table the older run made is level with that run, and its arrow comes out of it.
    expect(mid(layout.places.get(port(W, "t1")))).toBe(mid(b));
    expect(layout.arrows.find(a => a.relation === "makes")?.from).toBe(runId(W, U));
    // The tether to the second lane passes the first lane's rail, not its run.
    expect(noOverlaps(layout)).toEqual([]);
  });

  it("draws an elbow only where the ends are not level, turning where it is told", () => {
    expect(elbow(0, 10, 100, 10, EM)).toBe("M0,10H100");
    expect(elbow(0, 10, 100, 60, EM)).toMatch(/^M0,10H\d.*Q.*V.*Q.*H100$/);
    expect(elbow(0, 10, 100, 60, EM, 80)).toMatch(/^M0,10H7\d.*Q80,10 80,/);
  });
});

/** What overlaps: any two things placed, or a unit at a foot and a thing. */
function noOverlaps(layout: Layout): string[] {
  const boxes = [...layout.places.entries(), ...layout.lanes.map(l => [footId(l.unit), l.foot] as const)];
  const bad: string[] = [];
  for (const [a, x] of boxes)
    for (const [b, y] of boxes)
      if (a < b && x.x < y.x + y.w && y.x < x.x + x.w && x.y < y.y + y.h && y.y < x.y + x.h) bad.push(`${a} ~ ${b}`);
  return bad;
}

const placed = (uri: string, role: GraphNode["role"], extra: Partial<GraphNode> = {}): GraphNode => ({
  uri,
  role,
  kind: role === "data" ? "dataset" : role === "unit" ? "computing-unit" : role,
  name: uri.slice(-4),
  made: true,
  turn: "t2",
  ...extra,
});
const sized: Measured = {
  size: id =>
    id.startsWith("planned:workflow") || id.startsWith("texera://workflows/")
      ? { w: 212, h: 130 }
      : id.startsWith("run:")
        ? { w: 120, h: 32 }
        : id.startsWith("foot:")
          ? { w: 180, h: 44 }
          : { w: 160, h: 40 },
  row: () => undefined,
};

describe("the layout, whatever the plan says", () => {
  const ran = placed(W, "workflow", {
    runs: [{ uri: exec(W), phase: "completed", steps: 1, reused: 0, unit: U }],
    steps: [],
  });
  const unrun = placed(W, "workflow", { steps: [] });
  const plans: PlannedItem[][] = [
    [],
    [{ kind: "workflow", name: "other", turn: "t2" }],
    [{ kind: "computing-unit", name: "X", turn: "t2" }],
    [
      { kind: "workflow", name: "other", turn: "t2" },
      { kind: "computing-unit", name: "X", turn: "t2" },
    ],
    [{ kind: "dataset", name: "Out", turn: "t2" }],
    [{ kind: "execution", name: "run it", turn: "t2" }],
    [
      { kind: "execution", name: "run it", turn: "t2" },
      { kind: "computing-unit", name: "X", turn: "t2" },
    ],
  ];
  for (const [label, work, edges] of [
    [
      "ran on U",
      ran,
      [
        { from: D, to: W, relation: "reads" as const },
        { from: W, to: U, relation: "runsOn" as const },
      ],
    ],
    ["unrun, default U", unrun, [{ from: W, to: U, relation: "runsOn" as const }]],
    ["unrun, no unit", unrun, []],
  ] as const)
    for (const planned of plans)
      for (const level of ["overview", "standard", "detail"] as const)
        it(`overlaps nothing at ${level}: a workflow ${label}, a plan of ${planned.map(p => p.kind).join(" and ") || "nothing"}`, () => {
          const g: ConversationGraph = {
            nodes: [work, placed(D, "data"), placed(U, "unit")],
            edges: [...edges],
            planned,
            sources: [],
          };
          expect(noOverlaps(layOut(viewOf(g), sized, level, 12.5))).toEqual([]);
        });
});
