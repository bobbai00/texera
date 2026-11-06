import type { Edge } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import type { ResourceRef } from "../types";
import {
  buildLineage,
  type ExecutionFacts,
  type LineageGraph,
  operatorName,
  resourcesNamed,
  withoutGone,
} from "./model";

const W = "0b7a1c2d-0000-4000-8000-0000000000aa";
const D = "0b7a1c2d-0000-4000-8000-0000000000bb";
const OUT = "0b7a1c2d-0000-4000-8000-0000000000cc";
const E = (n: number) => `0b7a1c2d-0000-4000-8000-00000000e00${n}`;

const workflow = `texera://workflows/${W}`;
const dataset = `texera://datasets/${D}`;
const file = (path = "iris.csv", vno = 1) => `${dataset}@${vno}/files/${path}`;
const execution = (n: number) => `${workflow}/executions/${E(n)}`;
const port = (n: number, operator: string, id = "output-0") => `${execution(n)}/operators/${operator}/ports/${id}`;
const at = (minute: number) => `2026-11-05T10:${String(minute).padStart(2, "0")}:00Z`;

const used = (n: number, target = file(), operator = "scan"): Edge => ({
  from: execution(n),
  relation: "used",
  to: target,
  execution: E(n),
  attrs: { operatorID: operator },
  at: at(n),
});
const produced = (n: number, operator: string, rows: number): Edge => ({
  from: port(n, operator),
  relation: "produced",
  to: `iceberg://e_${n}.${operator}_output_0`,
  execution: E(n),
  attrs: { rows, table: `e_${n}.${operator}_output_0` },
  at: at(n),
});
const references = (vno: number, target = file()): Edge => ({
  from: `${workflow}@${vno}`,
  relation: "references",
  to: target,
  field: "/operators/0/operatorProperties/fileName",
  at: at(0),
});

/** The executions the catalog still lists, each a minute after the one before, running the version given. */
const listed = (...runs: [n: number, vno: number][]): Map<string, ExecutionFacts> =>
  new Map(
    runs.map(([n, vno]) => [
      E(n),
      { name: `execution ${n}`, phase: "completed", vno, createdAt: at(n), startedAt: at(n), finishedAt: at(n) },
    ])
  );

const ofWorkflow: ResourceRef = { kind: "workflow", rid: W };
const ids = (g: LineageGraph) => g.nodes.map(n => n.id);
const arrows = (g: LineageGraph) => g.arrows.map(a => `${a.from} -${a.relation}-> ${a.to}`);
const arrow = (g: LineageGraph, relation: string, from?: string) =>
  g.arrows.find(a => a.relation === relation && (from === undefined || a.from === from));

describe("the lineage of a resource, as a graph", () => {
  it("is empty when nothing was recorded", () => {
    expect(buildLineage({ root: ofWorkflow, edges: [], executions: new Map(), level: "resources" })).toEqual({
      nodes: [],
      arrows: [],
      folded: 0,
    });
  });

  describe("at the level of resources", () => {
    const edges = [references(1), used(1), produced(1, "avg", 3), produced(1, "chart", 1)];
    const graph = buildLineage({ root: ofWorkflow, edges, executions: listed([1, 1]), level: "resources" });

    it("has one card per resource: the dataset read, the workflow, its execution", () => {
      expect(ids(graph)).toEqual([dataset, workflow, execution(1)]);
      expect(graph.nodes.map(n => n.type)).toEqual(["resource", "resource", "execution"]);
      expect(graph.nodes[0]?.ref).toEqual({ kind: "dataset", rid: D });
      expect(graph.nodes[0]?.versions).toEqual([1]);
    });

    it("draws data left to right: the dataset is read by the workflow, which ran as the execution", () => {
      expect(arrows(graph)).toEqual([`${dataset} -used-> ${workflow}`, `${workflow} -ran-> ${execution(1)}`]);
      expect(arrow(graph, "used")).toMatchObject({ label: "read", detail: "iris.csv" });
      expect(arrow(graph, "used")?.declared).toBeUndefined();
      expect(arrow(graph, "ran")).toMatchObject({ label: "ran" });
    });

    it("folds an execution's results into it, as a count", () => {
      expect(graph.nodes[2]).toMatchObject({
        results: 2,
        execution: { name: "execution 1", phase: "completed", vno: 1 },
      });
      expect(graph.nodes.some(n => n.type === "result")).toBe(false);
    });

    it("marks the workflow whose page it is", () => {
      expect(graph.nodes.filter(n => n.root).map(n => n.id)).toEqual([workflow]);
    });

    it("merges the files of one dataset into one arrow that says how many", () => {
      const two = buildLineage({
        root: ofWorkflow,
        edges: [used(1, file("a.csv")), used(1, file("dir/b.csv"))],
        executions: listed([1, 1]),
        level: "resources",
      });
      expect(two.arrows.filter(a => a.relation === "used")).toHaveLength(1);
      expect(arrow(two, "used")).toMatchObject({ label: "read", detail: "2 files" });
      const nested = buildLineage({
        root: ofWorkflow,
        edges: [used(1, file("dir/b.csv"))],
        executions: listed([1, 1]),
        level: "resources",
      });
      expect(arrow(nested, "used")?.detail).toBe("b.csv");
    });

    it("says how many versions of a resource the arrows name", () => {
      const both = buildLineage({
        root: ofWorkflow,
        edges: [used(1, file("iris.csv", 1)), used(2, file("iris.csv", 2))],
        executions: listed([1, 1], [2, 2]),
        level: "resources",
      });
      expect(both.nodes.find(n => n.id === dataset)?.versions).toEqual([1, 2]);
      expect(both.nodes.find(n => n.id === workflow)?.versions).toEqual([1, 2]);
    });
  });

  describe("at the level of data flow", () => {
    const edges = [references(1), used(1), produced(1, "avg", 3), produced(1, "chart", 1)];
    const graph = buildLineage({ root: ofWorkflow, edges, executions: listed([1, 1]), level: "flow" });

    it("has a card for the file, the version that ran, the execution and each result", () => {
      expect(ids(graph)).toEqual([file(), `${workflow}@1`, execution(1), port(1, "avg"), port(1, "chart")]);
      expect(graph.nodes.map(n => n.type)).toEqual(["file", "resource", "execution", "result", "result"]);
      expect(graph.nodes[0]).toMatchObject({ path: "iris.csv", ref: { kind: "dataset", rid: D, vno: 1 } });
      expect(graph.nodes[1]?.ref).toEqual({ kind: "workflow", rid: W, vno: 1 });
      expect(graph.nodes[3]).toMatchObject({
        operator: "avg",
        port: "output-0",
        rows: 3,
        table: "e_1.avg_output_0",
        ref: { kind: "execution", rid: E(1), parent: W },
      });
    });

    it("says which operator read the file, and that the execution produced each result", () => {
      expect(arrows(graph)).toEqual([
        `${file()} -used-> ${workflow}@1`,
        `${workflow}@1 -ran-> ${execution(1)}`,
        `${execution(1)} -produced-> ${port(1, "avg")}`,
        `${execution(1)} -produced-> ${port(1, "chart")}`,
      ]);
      expect(arrow(graph, "used")).toMatchObject({ label: "read", detail: "by scan" });
      expect(arrow(graph, "produced")).toMatchObject({ label: "produced" });
    });

    it("hangs an execution on the workflow at large until its version is known", () => {
      const unknown = new Map<string, ExecutionFacts>([
        [E(1), { name: "execution 1", phase: "running", createdAt: at(1) }],
      ]);
      const g = buildLineage({ root: ofWorkflow, edges: [used(1)], executions: unknown, level: "flow" });
      expect(arrows(g)).toEqual([`${file()} -used-> ${workflow}`, `${workflow} -ran-> ${execution(1)}`]);
    });

    it("marks the version a page is pinned to, and every version otherwise", () => {
      const two = [references(1), references(2), used(1), used(2)];
      const all = buildLineage({ root: ofWorkflow, edges: two, executions: listed([1, 1], [2, 2]), level: "flow" });
      expect(all.nodes.filter(n => n.root).map(n => n.id)).toEqual([`${workflow}@2`, `${workflow}@1`]);
      const pinned = buildLineage({
        root: { ...ofWorkflow, vno: 1 },
        edges: two,
        executions: listed([1, 1], [2, 2]),
        level: "flow",
      });
      expect(pinned.nodes.filter(n => n.root).map(n => n.id)).toEqual([`${workflow}@1`]);
    });
  });

  it("draws a file a version names and no execution read as declared, not as read", () => {
    for (const level of ["resources", "flow"] as const) {
      const g = buildLineage({ root: ofWorkflow, edges: [references(1)], executions: new Map(), level });
      expect(g.arrows).toHaveLength(1);
      expect(g.arrows[0]).toMatchObject({ relation: "references", label: "referenced by", declared: true });
      expect(g.arrows[0]?.from).toBe(level === "flow" ? file() : dataset);
      expect(g.arrows[0]?.to).toBe(level === "flow" ? `${workflow}@1` : workflow);
    }
  });

  it("says a file is read, not only named, as soon as one execution of that version read it", () => {
    const g = buildLineage({
      root: ofWorkflow,
      edges: [references(1), references(2), used(1)],
      executions: listed([1, 1]),
      level: "flow",
    });
    expect(arrows(g)).toEqual([
      `${file()} -used-> ${workflow}@1`,
      `${file()} -references-> ${workflow}@2`,
      `${workflow}@1 -ran-> ${execution(1)}`,
    ]);
  });

  it("leaves out an execution that no longer exists, with what it read and produced", () => {
    const edges = [references(1), used(1), produced(1, "avg", 3), used(2), produced(2, "avg", 3)];
    for (const level of ["resources", "flow"] as const) {
      const g = buildLineage({ root: ofWorkflow, edges, executions: listed([2, 1]), level });
      expect(ids(g).filter(id => id.includes(E(1)))).toEqual([]);
      expect(ids(g)).toContain(execution(2));
    }
    // With no execution left, the file is only named again.
    const none = buildLineage({ root: ofWorkflow, edges, executions: new Map(), level: "resources" });
    expect(arrows(none)).toEqual([`${dataset} -references-> ${workflow}`]);
  });

  describe("a workflow that ran many times", () => {
    const edges = [1, 2, 3, 4].flatMap(n => [used(n), produced(n, "avg", n)]);
    const runs = listed([1, 1], [2, 1], [3, 2], [4, 2]);

    it("shows its two most recent executions and folds the earlier ones into one card", () => {
      const g = buildLineage({ root: ofWorkflow, edges, executions: runs, level: "resources" });
      expect(ids(g)).toEqual([dataset, workflow, execution(4), execution(3), `fold:${workflow}`]);
      expect(g.nodes.at(-1)).toMatchObject({ type: "fold", count: 2 });
      expect(g.folded).toBe(2);
      expect(arrows(g)).toContain(`${workflow} -ran-> fold:${workflow}`);
    });

    it("hangs the folded card on every version the folded executions ran, and shows no result of theirs", () => {
      const g = buildLineage({ root: ofWorkflow, edges, executions: runs, level: "flow" });
      expect(arrows(g).filter(a => a.includes("fold:"))).toEqual([`${workflow}@1 -ran-> fold:${workflow}`]);
      expect(g.nodes.filter(n => n.type === "result").map(n => n.id)).toEqual([port(4, "avg"), port(3, "avg")]);
      // What the folded executions read still counts: version 1 read the file.
      expect(arrow(g, "used", file())).toBeDefined();
      expect(arrows(g)).toContain(`${file()} -used-> ${workflow}@1`);
    });

    it("unfolds them all when asked", () => {
      const g = buildLineage({ root: ofWorkflow, edges, executions: runs, level: "resources", showAll: true });
      expect(ids(g)).toEqual([dataset, workflow, execution(4), execution(3), execution(2), execution(1)]);
      expect(g.folded).toBe(0);
    });

    it("never folds the execution whose page it is", () => {
      const g = buildLineage({
        root: { kind: "execution", rid: E(1), parent: W },
        edges,
        executions: runs,
        level: "resources",
      });
      expect(ids(g)).toContain(execution(1));
      expect(g.nodes.filter(n => n.root).map(n => n.id)).toEqual([execution(1)]);
      expect(g.nodes.find(n => n.type === "fold")).toMatchObject({ count: 1 });
    });
  });

  describe("a version saved from a result", () => {
    const saved: Edge = {
      from: `texera://datasets/${OUT}@1`,
      relation: "derivedFrom",
      to: port(1, "avg"),
      execution: E(1),
      at: at(2),
    };
    const edges = [used(1), produced(1, "avg", 3), saved];

    it("hangs off that result at the level of data flow", () => {
      const g = buildLineage({ root: { kind: "dataset", rid: OUT }, edges, executions: listed([1, 1]), level: "flow" });
      expect(arrows(g)).toContain(`${port(1, "avg")} -derivedFrom-> texera://datasets/${OUT}@1`);
      expect(arrow(g, "derivedFrom")).toMatchObject({ label: "saved as" });
      expect(g.nodes.filter(n => n.root).map(n => n.id)).toEqual([`texera://datasets/${OUT}@1`]);
    });

    it("hangs off the execution at the level of resources, with the version", () => {
      const g = buildLineage({
        root: { kind: "dataset", rid: OUT },
        edges,
        executions: listed([1, 1]),
        level: "resources",
      });
      expect(arrows(g)).toContain(`${execution(1)} -derivedFrom-> texera://datasets/${OUT}`);
      expect(arrow(g, "derivedFrom")).toMatchObject({ label: "saved as", detail: "v1" });
    });

    it("keeps the execution on screen however old it is, and makes a card for a result nothing else names", () => {
      const many = [...[2, 3, 4].flatMap(n => [used(n), produced(n, "avg", 3)]), used(1), saved];
      const g = buildLineage({
        root: ofWorkflow,
        edges: many,
        executions: listed([1, 1], [2, 1], [3, 1], [4, 1]),
        level: "flow",
      });
      expect(ids(g)).toContain(execution(1));
      expect(ids(g)).toContain(port(1, "avg"));
      expect(arrows(g)).toContain(`${execution(1)} -produced-> ${port(1, "avg")}`);
    });
  });

  it("draws a result an execution reused from an earlier one", () => {
    const reused: Edge = { from: port(2, "scan"), relation: "reused", to: port(1, "scan"), execution: E(2), at: at(2) };
    const edges = [produced(1, "scan", 150), reused];
    const flow = buildLineage({ root: ofWorkflow, edges, executions: listed([1, 1], [2, 1]), level: "flow" });
    expect(arrows(flow)).toContain(`${port(1, "scan")} -reused-> ${port(2, "scan")}`);
    expect(arrow(flow, "reused")).toMatchObject({ label: "reused" });
    const coarse = buildLineage({ root: ofWorkflow, edges, executions: listed([1, 1], [2, 1]), level: "resources" });
    expect(arrows(coarse)).toContain(`${execution(1)} -reused-> ${execution(2)}`);
  });

  it("draws what a spec names, whatever its kind, from the thing named to the one that names it", () => {
    const credential = "texera://credentials/0b7a1c2d-0000-4000-8000-0000000000dd";
    const warehouse = "texera://warehouses/0b7a1c2d-0000-4000-8000-0000000000ee";
    const g = buildLineage({
      root: { kind: "credential", rid: "0b7a1c2d-0000-4000-8000-0000000000dd" },
      edges: [{ from: warehouse, relation: "references", to: credential, field: "/storage/credential", at: at(0) }],
      executions: new Map(),
      level: "flow",
    });
    expect(arrows(g)).toEqual([`${credential} -references-> ${warehouse}`]);
    expect(g.nodes.map(n => n.root)).toEqual([true, false]);
  });

  it("gives a result that is no catalog resource a card of its own, never its address", () => {
    const g = buildLineage({
      root: { kind: "execution", rid: E(1), parent: W },
      edges: [produced(1, "Limit-operator-3f2c1a9e-0000-4000-8000-000000000001", 15)],
      executions: listed([1, 2]),
      level: "flow",
    });
    const result = g.nodes.find(n => n.type === "result");
    expect(result).toMatchObject({ operator: "Limit", rows: 15 });
    expect(ids(g).some(id => id.startsWith("iceberg://"))).toBe(false);
  });

  it("names each resource of the arrows once, executions aside, and drops the arrows of one that is gone", () => {
    const retired = "texera://mcp-servers/0b7a1c2d-0000-4000-8000-0000000000ff";
    const agent = "texera://agent-templates/0b7a1c2d-0000-4000-8000-000000000011";
    const edges: Edge[] = [
      references(1),
      references(2),
      used(1),
      produced(1, "avg", 3),
      { from: `${agent}@1`, relation: "references", to: retired, at: at(0) },
    ];
    expect(resourcesNamed(edges)).toEqual([workflow, dataset, agent, retired]);
    expect(withoutGone(edges, new Set([retired]))).toEqual(edges.slice(0, 4));
    expect(withoutGone(edges, new Set([dataset])).map(e => e.relation)).toEqual(["produced", "references"]);
  });

  it("reads an operator's name without the suffix the editor gives its id", () => {
    expect(operatorName("Limit-operator-3f2c1a9e-0000-4000-8000-000000000001")).toBe("Limit");
    expect(operatorName("scan")).toBe("scan");
  });
});
