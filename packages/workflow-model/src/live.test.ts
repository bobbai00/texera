import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { STANDING, applyChange, applySpec, dropLeftovers, movePositions, placeOperators, positionsOf, readSaveAnswer, readSaveRequest, runOf, saveAnswer, saveRequest, specOf, standingIn, versionSpecOf } from "./live";
import type { WorkflowSpec } from "./types";

const scan = { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: "texera://datasets/d@1/files/iris.csv", hasHeader: true } };
const avg = { operatorID: "avg", operatorType: "Aggregate", viewResult: true, operatorProperties: { groupByKeys: ["Species"], aggregations: [{ aggFunction: "average", attribute: "PetalLengthCm" }] } };
const link = { linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "avg", portID: "input-0" } };
const base: WorkflowSpec = { operators: [scan, avg], links: [link], defaultComputingUnit: "texera://computing-units/u" };

const docOf = (spec: WorkflowSpec) => {
  const doc = new Y.Doc();
  applySpec(doc, spec);
  return doc;
};

/** A second replica of a document, as a browser gets it from the server. */
const replicaOf = (doc: Y.Doc) => {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  return replica;
};

/** Exchanges what each replica has that the other lacks. */
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
};

describe("a workflow as a live document", () => {
  it("holds the spec it was given, and says it back the same", () => {
    expect(specOf(docOf(base), base)).toEqual(base);
    expect(specOf(new Y.Doc())).toEqual({ operators: [], links: [] });
  });

  it("merges two people's edits of one operator field by field", () => {
    const alice = docOf(base);
    const bob = replicaOf(alice);
    const edit = (doc: Y.Doc, change: (spec: WorkflowSpec) => void) => {
      const next = structuredClone(specOf(doc));
      change(next);
      applySpec(doc, next);
    };
    edit(alice, s => {
      (s.operators[1] as typeof avg).operatorProperties.groupByKeys = ["Species", "Id"];
    });
    edit(bob, s => {
      (s.operators[1] as typeof avg).customDisplayName = "mean petal";
      (s.operators[1] as typeof avg).operatorProperties.aggregations = [{ aggFunction: "max", attribute: "PetalLengthCm" }];
    });
    sync(alice, bob);
    const merged = specOf(alice).operators[1] as typeof avg & { customDisplayName?: string };
    expect(specOf(bob)).toEqual(specOf(alice));
    expect(merged.operatorProperties.groupByKeys).toEqual(["Species", "Id"]);
    expect(merged.operatorProperties.aggregations).toEqual([{ aggFunction: "max", attribute: "PetalLengthCm" }]);
    expect(merged.customDisplayName).toBe("mean petal");
  });

  it("writes only what an edit changed", () => {
    const doc = docOf(base);
    let updates = 0;
    doc.on("update", () => updates++);
    applySpec(doc, structuredClone(base));
    expect(updates).toBe(0);
  });

  it("takes in a version written elsewhere without losing an edit not saved yet", () => {
    const doc = docOf(base);
    // Someone renamed an operator; the room has not saved it.
    applySpec(doc, { ...base, operators: [scan, { ...avg, customDisplayName: "mean petal" }] });
    // Meanwhile an agent wrote the next version from the saved one: a limit after the average.
    const limit = { operatorID: "limit", operatorType: "Limit", operatorProperties: { limit: 2 } };
    const l2 = { linkID: "l2", source: { operatorID: "avg", portID: "output-0" }, target: { operatorID: "limit", portID: "input-0" } };
    const next: WorkflowSpec = { ...base, operators: [scan, { ...avg, viewResult: false }, limit], links: [link, l2] };
    applyChange(doc, base, next);
    expect(specOf(doc, next)).toEqual({ ...next, operators: [scan, { ...avg, viewResult: false, customDisplayName: "mean petal" }, limit] });
  });

  it("removes what a change removes: an operator, a link, a property, a setting", () => {
    const doc = docOf(base);
    const next: WorkflowSpec = { operators: [{ ...scan, operatorProperties: { fileName: scan.operatorProperties.fileName } }], links: [] };
    applyChange(doc, base, next);
    expect(specOf(doc)).toEqual(next);
  });

  it("lets a removal stand over a change to what was removed", () => {
    const doc = docOf(base);
    applySpec(doc, { ...base, operators: [scan], links: [] });
    // A change written elsewhere to the operator the room no longer has.
    applyChange(doc, base, { ...base, operators: [scan, { ...avg, viewResult: false }] });
    expect(specOf(doc).operators.map(o => o.operatorID)).toEqual(["scan"]);
  });

  it("leaves out a link whose operator another person removed at the same moment", () => {
    const alice = docOf(base);
    const bob = replicaOf(alice);
    applySpec(alice, { ...base, operators: [scan], links: [] });
    const sort = { operatorID: "sort", operatorType: "Sort", operatorProperties: {} };
    const l2 = { linkID: "l2", source: { operatorID: "avg", portID: "output-0" }, target: { operatorID: "sort", portID: "input-0" } };
    applySpec(bob, { ...base, operators: [scan, avg, sort], links: [link, l2] });
    sync(alice, bob);
    expect(specOf(alice)).toEqual(specOf(bob));
    expect(specOf(alice).operators.map(o => o.operatorID)).toEqual(["scan", "sort"]);
    expect(specOf(alice).links).toEqual([]);
  });

  it("keeps the order a version had and puts what is new after it, the same on every replica", () => {
    const doc = docOf(base);
    const added: WorkflowSpec = { ...base, operators: [...base.operators, { operatorID: "b", operatorType: "Limit", operatorProperties: {} }, { operatorID: "a", operatorType: "Sort", operatorProperties: {} }] };
    applySpec(doc, added);
    const ids = (d: Y.Doc) => specOf(d, base).operators.map(o => o.operatorID);
    expect(ids(doc)).toEqual(["scan", "avg", "a", "b"]);
    expect(ids(replicaOf(doc))).toEqual(["scan", "avg", "a", "b"]);
  });
});

describe("what a workflow names beside its graph", () => {
  it("is kept by the document and changes like the rest: the unit it runs on, where it keeps results, its environment", () => {
    const named: WorkflowSpec = {
      ...base,
      defaultEnvironment: "texera://environments/e",
      defaultWarehouse: "texera://warehouses/w",
    };
    const doc = docOf(named);
    expect(specOf(doc, named)).toEqual(named);
    // Another warehouse, and no environment any more.
    const { defaultEnvironment: _, ...rest } = named;
    applySpec(doc, { ...rest, defaultWarehouse: "texera://warehouses/other" });
    expect(specOf(replicaOf(doc), named)).toEqual({ ...rest, defaultWarehouse: "texera://warehouses/other" });
  });
});

describe("where the operators of a live document sit", () => {
  it("is one layout for everyone: laid out where nobody placed an operator, kept where someone did", () => {
    const doc = docOf(base);
    expect(positionsOf(doc)).toEqual({});
    placeOperators(doc);
    const laid = positionsOf(doc);
    expect(Object.keys(laid).sort()).toEqual(["avg", "scan"]);
    movePositions(doc, { avg: { x: 500, y: 60 } });
    placeOperators(doc);
    expect(positionsOf(doc)).toEqual({ ...laid, avg: { x: 500, y: 60 } });
    expect(positionsOf(replicaOf(doc))).toEqual(positionsOf(doc));
  });

  it("forgets the place of an operator that is gone", () => {
    const doc = docOf(base);
    placeOperators(doc);
    applySpec(doc, { ...base, operators: [scan], links: [] });
    expect(Object.keys(positionsOf(doc))).toEqual(["scan"]);
  });
});

describe("where the operators sit, in a version", () => {
  it("is said beside the spec when a version is made: where each operator of the spec sits", () => {
    const doc = docOf(base);
    placeOperators(doc);
    movePositions(doc, { avg: { x: 640, y: 80 } });
    const version = versionSpecOf(doc);
    expect(version.layout?.avg).toEqual({ x: 640, y: 80 });
    expect(Object.keys(version.layout ?? {}).sort()).toEqual(["avg", "scan"]);
    // What runs is the rest: the same whatever the layout.
    expect(runOf(version)).toEqual(specOf(doc));
  });

  it("is put on the canvas when a version is taken in, and an operator a version gives no place keeps its own", () => {
    const doc = docOf(base);
    placeOperators(doc);
    movePositions(doc, { scan: { x: 7, y: 9 } });
    const before = versionSpecOf(doc);
    // A version written elsewhere moved avg and said nothing of scan.
    applyChange(doc, before, { ...base, layout: { avg: { x: 1000, y: 500 } } });
    expect(positionsOf(doc).avg).toEqual({ x: 1000, y: 500 });
    expect(positionsOf(doc).scan).toEqual({ x: 7, y: 9 });
  });

  it("is laid out from a version that has it when the document is opened", () => {
    const doc = docOf({ ...base, layout: { scan: { x: 11, y: 22 }, avg: { x: 333, y: 22 } } });
    expect(positionsOf(doc)).toEqual({ scan: { x: 11, y: 22 }, avg: { x: 333, y: 22 } });
  });
});

describe("asking a workflow's session to save now", () => {
  it("names the request, and the answer names it back with the version the catalog then has", () => {
    expect(readSaveRequest(saveRequest("r1"))).toBe("r1");
    expect(readSaveAnswer(saveAnswer({ id: "r1", vno: 7 }))).toEqual({ id: "r1", vno: 7 });
    // A session with nothing to save into still answers.
    expect(readSaveAnswer(saveAnswer({ id: "r1" }))).toEqual({ id: "r1" });
  });

  it("says why when the catalog did not take the document, whatever the reason holds", () => {
    const refused = "texera://datasets/d@1/files/x.csv does not exist: no such file";
    expect(readSaveAnswer(saveAnswer({ id: "r1", refused }))).toEqual({ id: "r1", refused });
  });

  it("is not read out of anything else said in the session", () => {
    expect(readSaveRequest("saved:r1:2")).toBeUndefined();
    expect(readSaveAnswer("save:r1")).toBeUndefined();
    expect(readSaveAnswer("saved")).toBeUndefined();
    expect(readSaveAnswer("saved:r1:soon")).toBeUndefined();
  });
});

describe("how a session's document stands with the catalog", () => {
  it("is read from the session's own state among everyone's, and is absent until the session says it", () => {
    const alice = { user: { pid: "p-alice", name: "Alice" } };
    expect(standingIn([alice])).toBeUndefined();
    expect(standingIn([alice, { [STANDING]: { vno: 4 } }])).toEqual({ vno: 4 });
    expect(standingIn([{ [STANDING]: { vno: 4, refused: "the catalog could not be reached" } }, alice])).toEqual({ vno: 4, refused: "the catalog could not be reached" });
  });
});

describe("what a document's spec leaves out", () => {
  it("forgets the places kept for the icons operators once were", () => {
    const doc = docOf(base);
    // A document kept from before: places for icons, closer together than a card is wide.
    doc.getMap("positions").set("scan", { x: 40, y: 40 });
    doc.getMap("positions").set("avg", { x: 220, y: 40 });
    expect(positionsOf(doc)).toEqual({});
    dropLeftovers(doc);
    expect(doc.getMap("positions").size).toBe(0);
    movePositions(doc, { scan: { x: 40, y: 40 } });
    dropLeftovers(doc);
    expect(positionsOf(doc)).toEqual({ scan: { x: 40, y: 40 } });
  });

  it("is taken out of the document for good, so it does not come back with an operator of the same id", () => {
    const alice = docOf(base);
    placeOperators(alice);
    const bob = replicaOf(alice);
    // Alice removes the aggregate; at the same moment bob connects it onward and moves it.
    applySpec(alice, { ...base, operators: [scan], links: [] });
    const sort = { operatorID: "sort", operatorType: "Sort", operatorProperties: {} };
    const l2 = { linkID: "l2", source: { operatorID: "avg", portID: "output-0" }, target: { operatorID: "sort", portID: "input-0" } };
    applySpec(bob, { ...base, operators: [scan, avg, sort], links: [link, l2] });
    movePositions(bob, { avg: { x: 900, y: 900 } });
    sync(alice, bob);
    expect(specOf(alice).links).toEqual([]);

    dropLeftovers(alice);
    sync(alice, bob);
    // An agent names its operators as it likes: one called avg again is a new operator.
    applySpec(alice, { ...specOf(alice), operators: [...specOf(alice).operators, avg] });
    sync(alice, bob);
    expect(specOf(bob).links).toEqual([]);
    expect(positionsOf(bob).avg).toBeUndefined();
  });

  it("leaves a document alone that has nothing loose", () => {
    const doc = docOf(base);
    placeOperators(doc);
    let updates = 0;
    doc.on("update", () => updates++);
    dropLeftovers(doc);
    expect(updates).toBe(0);
    expect(specOf(doc, base)).toEqual(base);
  });
});
