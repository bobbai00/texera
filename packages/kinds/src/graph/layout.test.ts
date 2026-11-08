import type { ConversationGraph, GraphNode, PlannedItem } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { elbow, layOut, type Measured } from "./layout";
import { viewOf } from "./model";

const D = "texera://datasets/11111111-1111-1111-1111-111111111111";
const D2 = "texera://datasets/12121212-1212-1212-1212-121212121212";
const W = "texera://workflows/22222222-2222-2222-2222-222222222222";
const W2 = "texera://workflows/33333333-3333-3333-3333-333333333333";
const U = "texera://computing-units/66666666-6666-6666-6666-666666666666";
const port = (wf: string, op: string) =>
  `${wf}/executions/77777777-7777-7777-7777-777777777777/operators/${op}/ports/output-0`;
const node = (uri: string, role: GraphNode["role"], extra: Partial<GraphNode> = {}): GraphNode => ({
  uri,
  role,
  kind: role === "data" ? "dataset" : role,
  name: uri.slice(-4),
  made: true,
  ...extra,
});

const work = (uri: string, dataset: string, table: string) =>
  node(uri, "workflow", {
    runs: [{ uri: `${uri}/executions/1`, phase: "completed", steps: 3, reused: 0 }],
    steps: [
      { id: "scan", type: "scan", settings: { file: `${dataset}@1/files/a.csv` } },
      { id: "mid", type: "filter", settings: { where: "x > 1" }, inputs: ["scan"] },
      { id: table, type: "aggregate", inputs: ["mid"] },
    ],
  });

/** One workflow on a unit: it reads a dataset and makes a table. */
const one: ConversationGraph = {
  nodes: [
    work(W, D, "t1"),
    node(D, "data"),
    node(U, "unit"),
    node(port(W, "t1"), "data", { kind: "execution", step: "t1", rows: 3 }),
  ],
  edges: [
    { from: D, to: W, relation: "reads" },
    { from: W, to: U, relation: "runsOn" },
    { from: W, to: port(W, "t1"), relation: "makes" },
  ],
  planned: [],
  sources: [],
};
/** The same, and a second workflow on the same unit that arrives later. */
const two: ConversationGraph = {
  ...one,
  nodes: [
    ...one.nodes,
    work(W2, D2, "t2"),
    node(D2, "data"),
    node(port(W2, "t2"), "data", { kind: "execution", step: "t2", rows: 5 }),
  ],
  edges: [
    ...one.edges,
    { from: D2, to: W2, relation: "reads" },
    { from: W2, to: U, relation: "runsOn" },
    { from: W2, to: port(W2, "t2"), relation: "makes" },
  ],
};

/** Sizes as the page would measure them: a dataset 140 by 40, a workflow 220 by 120, a table 130 by 36; steps 20 apart. */
const measured: Measured = {
  size: id =>
    id.includes("/executions/")
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
  head: () => 30,
};
const EM = 12.5;

describe("the resource graph's layout", () => {
  it("puts a workflow's inputs and tables level with it, in a frame of its unit, under column heads", () => {
    const layout = layOut(viewOf(one), measured, "standard", EM);
    const at = (id: string) => layout.places.get(id);
    expect(at(D)?.x).toBeLessThan(at(W)?.x as number);
    expect(at(port(W, "t1"))?.x).toBeGreaterThan((at(W)?.x as number) + 220);
    // Level: the table starts with the workflow, and the dataset's middle meets the workflow's head.
    expect(at(port(W, "t1"))?.y).toBe(at(W)?.y);
    expect(layout.frames).toHaveLength(1);
    expect(layout.frames[0]).toMatchObject({ id: U, y: (at(W)?.y as number) - 30 });
    expect(layout.columns.map(c => c.label)).toEqual(["Data", "Computation", "Results"]);
    // Arrows run straight between things that are level.
    expect(layout.arrows.map(a => a.relation)).toEqual(["reads", "makes"]);
    for (const a of layout.arrows) expect(a.path).not.toContain("Q");
  });

  it("gives a later workflow the next row in the same frame, and moves nothing already placed", () => {
    const before = layOut(viewOf(one), measured, "standard", EM);
    const after = layOut(viewOf(two), measured, "standard", EM);
    for (const [id, box] of before.places) expect(after.places.get(id), id).toEqual(box);
    expect((after.places.get(W2)?.y as number) > (after.places.get(W)?.y as number) + 120).toBe(true);
    expect(after.frames).toHaveLength(1);
    expect((after.frames[0]?.h as number) > (before.frames[0]?.h as number)).toBe(true);
  });

  it("at the closest level stands each table level with the step that made it, and each file with the step that reads it", () => {
    const layout = layOut(viewOf(one), measured, "detail", EM);
    const w = layout.places.get(W);
    const t = layout.places.get(port(W, "t1"));
    expect((t?.y as number) + 18).toBe((w?.y as number) + 50 + 2 * 20);
    const d = layout.places.get(D);
    expect((d?.y as number) + 30).toBe((w?.y as number) + 50);
  });

  it("draws an elbow only where the ends are not level", () => {
    expect(elbow(0, 10, 100, 10, EM)).toBe("M0,10H100");
    expect(elbow(0, 10, 100, 60, EM)).toMatch(/^M0,10H\d.*Q.*V.*Q.*H100$/);
  });
});

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
      : id.startsWith("planned:computing") || id.startsWith("texera://computing")
        ? { w: 235, h: 40 }
        : { w: 160, h: 40 },
  row: () => undefined,
  head: () => 40,
};
const overlaps = (g: ConversationGraph) => {
  const layout = layOut(viewOf(g), sized, "standard", 12.5);
  const boxes = [...layout.places.entries()];
  const bad: string[] = [];
  for (const [a, x] of boxes)
    for (const [b, y] of boxes)
      if (a < b && x.x < y.x + y.w && y.x < x.x + x.w && x.y < y.y + y.h && y.y < x.y + x.h) bad.push(`${a} ~ ${b}`);
  for (const f of layout.frames)
    for (const [id, x] of boxes)
      if (
        !id.startsWith("texera://workflows") &&
        !id.startsWith("planned:workflow") &&
        x.x < f.x + f.w &&
        f.x < x.x + x.w &&
        x.y < f.y + f.h &&
        f.y < x.y + x.h
      )
        bad.push(`frame ${f.id} ~ ${id}`);
  return bad;
};

describe("the layout, whatever the plan says", () => {
  const ran = placed(W, "workflow", {
    runs: [{ uri: `${W}/executions/1`, phase: "completed", steps: 1, reused: 0 }],
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
      it(`overlaps nothing: a workflow ${label}, a plan of ${planned.map(p => p.kind).join(" and ") || "nothing"}`, () => {
        const g: ConversationGraph = {
          nodes: [work, placed(D, "data"), placed(U, "unit")],
          edges: [...edges],
          planned,
          sources: [],
        };
        expect(overlaps(g)).toEqual([]);
      });
});
