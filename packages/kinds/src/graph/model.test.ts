import type { GraphExecution, GraphNode, GraphPart, GraphVersion, ResourceGraph } from "@texera/catalog-client/types";
import type { OperatorSchema } from "@texera/workflow-model";
import { describe, expect, it } from "vitest";
import {
  callsOf,
  commentTarget,
  inputsOf,
  nameOf,
  plannedId,
  relationsOf,
  rowId,
  runStateOf,
  touching,
  viewOf,
} from "./model";

const D = "texera://datasets/11111111-1111-1111-1111-111111111111";
const L = "texera://datasets/12121212-1212-1212-1212-121212121212";
const W = "texera://workflows/22222222-2222-2222-2222-222222222222";
const F = "texera://operators/44444444-4444-4444-4444-444444444444";
const M = "texera://models/55555555-5555-5555-5555-555555555555";
const U = "texera://computing-units/66666666-6666-6666-6666-666666666666";
const E1 = `${W}/executions/77777777-7777-7777-7777-777777777777`;
const E2 = `${W}/executions/99999999-9999-9999-9999-999999999999`;
const port = (exec: string, op: string) => `${exec}/operators/${op}/ports/output-0`;

const version = (vno: number, extra: Partial<GraphVersion> = {}): GraphVersion => ({ vno, made: false, ...extra });
/** An operator of a workflow version that reads a file, or uses a version whole. */
const part = (operator: string, file?: string, operatorType = "CSVFileScan"): GraphPart => ({
  ...(file ? { from: `files/${file}` } : {}),
  to: `operators/${operator}`,
  operatorType,
  executed: true,
});
const node = (
  uri: string,
  role: GraphNode["role"],
  versions: GraphVersion[],
  extra: Partial<GraphNode> = {}
): GraphNode => ({
  uri,
  role,
  kind: role === "data" ? "dataset" : role === "function" ? "operator" : role,
  name: uri.slice(-4),
  readable: true,
  versions,
  made: false,
  ...extra,
});
const execution = (uri: string, vno: number, extra: Partial<GraphExecution> = {}): GraphExecution => ({
  uri,
  workflow: W,
  version: vno,
  name: "execution",
  phase: "completed",
  steps: 3,
  reused: 0,
  made: true,
  createdBy: "alice",
  unit: { uri: U, name: "Small" },
  ...extra,
});

/**
 * The email's case: version 1 read the cohort and kept the lows; version 2 reads the labs too,
 * predicts with a model and calls a function, and kept the joined table. Each execution is of
 * its own version.
 */
const screening: ResourceGraph = {
  nodes: [
    node(W, "workflow", [version(2, { executions: 1 }), version(1, { executions: 1 })], {
      name: "Risk scoring",
      made: true,
      turn: "t1",
    }),
    node(D, "data", [version(1)], { name: "Pima cohort" }),
    node(L, "data", [version(1)], { name: "Labs" }),
    node(M, "model", [version(1)], { name: "Risk model" }),
    node(F, "function", [version(1)], { name: "Odds ratio" }),
  ],
  executions: [execution(E2, 2), execution(E1, 1)],
  results: [
    {
      uri: port(E2, "both"),
      execution: E2,
      operator: "both",
      operatorType: "HashJoin",
      displayName: "Both tables",
      rows: 614,
    },
    { uri: port(E1, "lows"), execution: E1, operator: "lows", operatorType: "Filter", rows: 12 },
  ],
  edges: [
    { from: `${D}@1`, to: `${W}@1`, relation: "reads", executed: true, parts: [part("cohort", "pima.csv")] },
    { from: `${D}@1`, to: `${W}@2`, relation: "reads", executed: true, parts: [part("cohort", "pima.csv")] },
    { from: `${L}@1`, to: `${W}@2`, relation: "reads", executed: true, parts: [part("labs", "labs.csv")] },
    { from: `${M}@1`, to: `${W}@2`, relation: "uses", executed: true, parts: [part("risk", undefined, "predict")] },
    { from: `${F}@1`, to: `${W}@2`, relation: "uses", executed: true, parts: [part("odds", undefined, `${F}@1`)] },
  ],
  planned: [],
  sources: [],
  units: [],
};

describe("the view of a lineage graph", () => {
  it("hangs each execution off the version it ran, with the results it kept after it", () => {
    const view = viewOf(screening);
    expect(view.works).toEqual([W]);
    expect(view.boxes.get(W)?.rows).toEqual([`${W}@2`, `${W}@1`]);
    expect(view.rows.get(`${W}@2`)?.runs).toEqual([E2]);
    expect(view.rows.get(`${W}@1`)?.runs).toEqual([E1]);
    expect(view.runs.get(E1)?.row).toBe(`${W}@1`);
    expect(view.runs.get(E2)?.results).toEqual([port(E2, "both")]);
    expect(view.runs.get(E1)?.results).toEqual([port(E1, "lows")]);
    expect(view.runsOf.get(W)).toEqual([E2, E1]);
  });

  it("runs an arrow from each version read or used into the workflow version, and says a function on the version that calls it", () => {
    const view = viewOf(screening);
    expect(view.links.map(l => `${l.from.slice(-6)}>${l.to.slice(-6)}`)).toEqual([
      `${D.slice(-4)}@1>${W.slice(-4)}@1`,
      `${D.slice(-4)}@1>${W.slice(-4)}@2`,
      `${L.slice(-4)}@1>${W.slice(-4)}@2`,
      `${M.slice(-4)}@1>${W.slice(-4)}@2`,
    ]);
    expect(view.rows.get(`${W}@2`)?.calls.map(c => [c.node.name, c.vno])).toEqual([["Odds ratio", 1]]);
    expect(callsOf(view, W).map(c => c.node.name)).toEqual(["Odds ratio"]);
    expect(inputsOf(view, W)).toEqual([D, L, M]);
    expect(view.loose).toEqual([]);
  });

  it("shows zoomed out the results of the newest execution that kept any", () => {
    const running: ResourceGraph = {
      ...screening,
      executions: [
        execution(`${W}/executions/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, 2, { phase: "running" }),
        ...screening.executions,
      ],
    };
    expect(viewOf(running).latest.get(W)).toEqual([port(E2, "both")]);
  });

  it("counts the executions of a version it does not list, and lists a version not executed", () => {
    const graph: ResourceGraph = {
      ...screening,
      nodes: [
        node(W, "workflow", [version(3), version(2, { executions: 5 }), version(1, { executions: 1 })]),
        ...screening.nodes.slice(1),
      ],
    };
    const view = viewOf(graph);
    expect(view.rows.get(`${W}@2`)?.earlier).toBe(4);
    expect(view.rows.get(`${W}@3`)?.runs).toEqual([]);
  });

  it("names a result as its operator's card does: the name given it, else its type's", () => {
    const schemas = new Map([["Filter", { userFriendlyName: "Filter rows" } as OperatorSchema]]);
    const view = viewOf(screening, schemas);
    expect(view.results.get(port(E2, "both"))?.title).toBe("Both tables");
    expect(view.results.get(port(E1, "lows"))?.title).toBe("Filter rows");
    expect(viewOf(screening).results.get(port(E1, "lows"))?.title).toBe("Filter");
  });

  it("stands each item of the plan where what it names will stand", () => {
    const graph: ResourceGraph = {
      ...screening,
      planned: [
        { kind: "workflow", name: "Calibration", turn: "t2" },
        { kind: "dataset", name: "Calibration table", turn: "t2" },
        { kind: "computing-unit", name: "Medium", turn: "t2" },
        { kind: "execution", name: "rerun Risk scoring", turn: "t2" },
        { kind: "operator", name: "Brier score", turn: "t2" },
      ],
    };
    const view = viewOf(graph);
    const calibration = plannedId({ kind: "workflow", name: "Calibration", turn: "t2" });
    expect(view.works).toEqual([W, calibration]);
    const ofPlan = view.runs.get(`planned:execution:${calibration}`);
    expect(ofPlan?.planned?.name).toBe("Calibration");
    expect(ofPlan?.results).toEqual([plannedId({ kind: "dataset", name: "Calibration table", turn: "t2" })]);
    expect(ofPlan?.plannedUnit?.name).toBe("Medium");
    // The rerun the plan names stands first on the newest version of the workflow it names.
    const rerun = view.runs.get(`planned:execution:${W}`);
    expect(rerun?.row).toBe(`${W}@2`);
    expect(view.rows.get(`${W}@2`)?.runs[0]).toBe(rerun?.id);
    expect(rerun && runStateOf(rerun)).toBe("planned");
    expect(view.plannedUses.get(calibration)?.map(p => p.name)).toEqual(["Brier score"]);
  });

  it("says the next execution of a workflow the chat made and has not executed on the unit it made for it", () => {
    const W2 = "texera://workflows/33333333-3333-3333-3333-333333333333";
    const fresh = "texera://computing-units/88888888-8888-8888-8888-888888888888";
    const graph: ResourceGraph = {
      ...screening,
      nodes: [
        ...screening.nodes,
        node(W2, "workflow", [version(1, { made: true })], { name: "Calibration", made: true }),
      ],
      units: [{ uri: fresh, name: "Medium", state: "starting" }],
    };
    const view = viewOf(graph);
    const next = view.runs.get(`planned:execution:${W2}`);
    expect(next?.row).toBe(`${W2}@1`);
    expect(next?.willRunOn?.name).toBe("Medium");
    expect(next && runStateOf(next)).toBe("waiting");
    expect(nameOf(view, next?.id ?? "")).toBe("Next execution of Calibration v1");
    // A workflow it executed already has no such execution.
    expect(view.runs.has(`planned:execution:${W}`)).toBe(false);
    expect(relationsOf(view, fresh)).toEqual([{ label: "Executions on it", ids: [`planned:execution:${W2}`] }]);
  });

  it("stands a resource the caller may not read unnamed, with nothing to comment on", () => {
    const graph: ResourceGraph = {
      ...screening,
      nodes: screening.nodes.map(n => (n.uri === L ? { ...n, name: "", readable: false } : n)),
    };
    const view = viewOf(graph);
    expect(nameOf(view, L)).toBe("Not shared with you");
    expect(commentTarget(view, L)).toBeUndefined();
  });

  it("lights up what a thing touches, and says how it stands to the rest", () => {
    const view = viewOf(screening);
    const v1 = touching(view, `${W}@1`);
    expect([...v1]).toEqual(expect.arrayContaining([`${W}@1`, W, `${D}@1`, D, E1, port(E1, "lows")]));
    expect(v1.has(E2)).toBe(false);
    expect(v1.has(`${L}@1`)).toBe(false);
    expect(touching(view, L).has(`${W}@2`)).toBe(true);
    expect(relationsOf(view, E1)).toEqual([
      { label: "Of", ids: [`${W}@1`] },
      { label: "Read", ids: [`${D}@1`] },
      { label: "Made", ids: [port(E1, "lows")] },
    ]);
    expect(relationsOf(view, D)).toEqual([{ label: "Read by", ids: [`${W}@1`, `${W}@2`] }]);
    expect(relationsOf(view, F)).toEqual([{ label: "Used by", ids: [`${W}@2`] }]);
    expect(nameOf(view, `${W}@2`)).toBe("Risk scoring v2");
    expect(nameOf(view, E1)).toBe("Execution of Risk scoring v1");
  });

  it("says what a comment is about: a resource, a version, an execution, a result; nothing for what is only planned", () => {
    const view = viewOf({ ...screening, planned: [{ kind: "workflow", name: "Later", turn: "t2" }] });
    expect(commentTarget(view, W)).toEqual({ uri: W, name: "Risk scoring" });
    expect(commentTarget(view, `${W}@1`)).toEqual({ uri: `${W}@1`, name: "Risk scoring v1" });
    expect(commentTarget(view, E2)).toEqual({ uri: E2, name: "execution of Risk scoring v2" });
    expect(commentTarget(view, port(E2, "both"))?.uri).toBe(port(E2, "both"));
    expect(commentTarget(view, plannedId({ kind: "workflow", name: "Later", turn: "t2" }))).toBeUndefined();
    expect(rowId(W, 2)).toBe(`${W}@2`);
  });
});

describe("what a result was saved as", () => {
  const S = "texera://datasets/13131313-1313-1313-1313-131313131313";
  const graph: ResourceGraph = {
    ...screening,
    nodes: [...screening.nodes, node(S, "data", [version(1)], { name: "Low readings" })],
    edges: [
      ...screening.edges,
      {
        from: E1,
        to: `${S}@1`,
        relation: "keeps",
        executed: true,
        parts: [
          {
            from: "operators/lows/ports/output-0",
            to: "files/lows.csv",
            operatorType: "Filter",
            displayName: "Lows",
            executed: true,
          },
        ],
      },
    ],
  };

  it("is an arrow from the result to the version, and the file it became is said on the version's row", () => {
    const view = viewOf(graph);
    expect(view.kept).toEqual([
      {
        key: `${E1}>${S}@1`,
        run: E1,
        result: port(E1, "lows"),
        to: `${S}@1`,
        parts: [{ file: "lows.csv", operator: "Lows", executed: true }],
      },
    ]);
    expect(view.rows.get(`${S}@1`)?.files).toEqual(["lows.csv"]);
    expect(view.loose).not.toContain(S);
  });

  it("names on each arrow into a workflow version the operator that reads and the file it reads", () => {
    const view = viewOf(graph);
    expect(view.rows.get(`${D}@1`)?.files).toEqual(["pima.csv"]);
    expect(view.links.find(l => l.from === `${L}@1`)?.parts).toEqual([
      { file: "labs.csv", operator: "CSVFileScan", executed: true },
    ]);
  });

  it("is what the result, its execution and the version are to each other", () => {
    const view = viewOf(graph);
    expect(relationsOf(view, port(E1, "lows"))).toContainEqual({ label: "Saved as", ids: [`${S}@1`] });
    expect(relationsOf(view, E1)).toContainEqual({ label: "Saved as", ids: [`${S}@1`] });
    expect(relationsOf(view, S)).toContainEqual({ label: "Saved from", ids: [port(E1, "lows")] });
    const near = touching(view, `${S}@1`);
    expect([E1, port(E1, "lows"), W, `${W}@1`].every(id => near.has(id))).toBe(true);
    expect(touching(view, E1).has(`${S}@1`)).toBe(true);
  });
});
