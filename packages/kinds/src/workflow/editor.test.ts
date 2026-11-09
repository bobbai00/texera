import { addOperator, applySpec, EMPTY_SPEC, movePositions, positionsOf, specOf, type WorkflowSpec } from "@texera/workflow-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { documentOf, fixedDocument, historyIn, type SyncState, type WorkflowDocument } from "./document";
import { createEditorStore } from "./editor";

const op = (id: string) => ({ operatorID: id, operatorType: "Limit", operatorProperties: {} as Record<string, unknown> });
const ids = (spec: WorkflowSpec) => spec.operators.map(o => o.operatorID);
const workflow = { rid: "wf", name: "Sales", headVno: 1, readonly: false };
const none = { rename: async () => {} };

/** A session's document as the editor gets it, with the session's side of it in the test's hands. */
function session(doc: Y.Doc) {
  let state: SyncState = "saved";
  let refusal: string | undefined;
  const listeners = new Set<() => void>();
  const settled: number[] = [];
  const document: WorkflowDocument = {
    ...documentOf(doc),
    state: () => state,
    refusal: () => refusal,
    watchState: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settle: async () => {
      settled.push(Date.now());
      return 7;
    },
  };
  return {
    document,
    settled,
    /** The session reports where what was written stands. */
    is(next: SyncState, why?: string) {
      state = next;
      refusal = why;
      for (const listener of listeners) listener();
    },
  };
}

/** Someone else in the session: a second replica, kept level by hand. */
function someoneElse(doc: Y.Doc) {
  const theirs = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(theirs)));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(theirs, Y.encodeStateVector(doc)));
  };
  sync();
  return { theirs, sync };
}

describe("the workflow editor's store", () => {
  it("shows what the session's document holds and writes an edit into it", () => {
    const doc = new Y.Doc();
    applySpec(doc, addOperator(EMPTY_SPEC, op("a")));
    const store = createEditorStore(workflow, session(doc).document, none);
    expect(ids(store.getState().spec)).toEqual(["a"]);

    store.getState().edit(s => addOperator(s, op("b")));
    expect(ids(specOf(doc))).toEqual(["a", "b"]);
    expect(ids(store.getState().spec)).toEqual(["a", "b"]);
    // Every operator has a place on screen, also one the session has not placed yet.
    expect(store.getState().positions.b).toBeDefined();
  });

  it("shows a spec with its ports spelled out, and writes only what the person changed", () => {
    const doc = new Y.Doc();
    // As an agent or the API writes it: no port lists.
    applySpec(doc, addOperator(EMPTY_SPEC, { ...op("a"), operatorProperties: { limit: 1 } }));
    const store = createEditorStore(workflow, session(doc).document, none);
    expect(store.getState().spec.operators[0]?.outputPorts).toEqual([{ portID: "output-0" }]);

    store.getState().edit(s => ({ ...s, operators: s.operators.map(o => ({ ...o, operatorProperties: { limit: 5 } })) }));
    expect(specOf(doc).operators[0]).toEqual({ ...op("a"), operatorProperties: { limit: 5 } });
  });

  it("follows what someone else in the session does: an edit, a move", () => {
    const doc = new Y.Doc();
    applySpec(doc, addOperator(EMPTY_SPEC, op("a")));
    const store = createEditorStore(workflow, session(doc).document, none);
    const { theirs, sync } = someoneElse(doc);

    applySpec(theirs, addOperator(specOf(theirs), op("theirs")));
    movePositions(theirs, { a: { x: 640, y: 80 } });
    sync();
    expect(ids(store.getState().spec)).toEqual(["a", "theirs"]);
    expect(store.getState().positions.a).toEqual({ x: 640, y: 80 });
  });

  it("merges an edit made here with one made elsewhere to another property of the same operator", () => {
    const doc = new Y.Doc();
    applySpec(doc, addOperator(EMPTY_SPEC, { ...op("a"), operatorProperties: { limit: 1, offset: 0 } }));
    const store = createEditorStore(workflow, session(doc).document, none);
    const { theirs, sync } = someoneElse(doc);
    const set = (spec: WorkflowSpec, key: string, value: number): WorkflowSpec => ({
      ...spec,
      operators: spec.operators.map(o => ({ ...o, operatorProperties: { ...o.operatorProperties, [key]: value } })),
    });

    store.getState().edit(s => set(s, "limit", 5));
    applySpec(theirs, set(specOf(theirs), "offset", 9));
    sync();
    expect(store.getState().spec.operators[0]?.operatorProperties).toEqual({ limit: 5, offset: 9 });
  });

  it("keeps the spec it has while only the layout changes, so a move recompiles nothing", () => {
    const doc = new Y.Doc();
    applySpec(doc, addOperator(EMPTY_SPEC, op("a")));
    const store = createEditorStore(workflow, session(doc).document, none);
    const before = store.getState().spec;
    store.getState().move({ a: { x: 500, y: 500 } });
    expect(store.getState().spec).toBe(before);
    expect(store.getState().positions.a).toEqual({ x: 500, y: 500 });
    expect(positionsOf(doc).a).toEqual({ x: 500, y: 500 });
  });

  it("says whether what was written has reached the session", () => {
    const doc = new Y.Doc();
    const live = session(doc);
    const store = createEditorStore(workflow, live.document, none);
    expect(store.getState().saveState).toBe("saved");
    live.is("pending");
    expect(store.getState().saveState).toBe("pending");
    live.is("offline");
    expect(store.getState().saveState).toBe("offline");
    live.is("saved");
    expect(store.getState().saveState).toBe("saved");
  });

  it("says why the catalog did not take the workflow, for as long as that stands", () => {
    const live = session(new Y.Doc());
    const store = createEditorStore(workflow, live.document, none);
    live.is("refused", "texera://datasets/d@9/files/x.csv does not exist");
    expect([store.getState().saveState, store.getState().refusal]).toEqual(["refused", "texera://datasets/d@9/files/x.csv does not exist"]);
    live.is("saved");
    expect([store.getState().saveState, store.getState().refusal]).toEqual(["saved", undefined]);
  });

  it("has the session save before something reads the catalog's version", async () => {
    const live = session(new Y.Doc());
    const store = createEditorStore(workflow, live.document, none);
    // It hands back the version the catalog then has, so a run is of exactly that one.
    expect(await store.getState().flush()).toBe(7);
    expect(live.settled).toHaveLength(1);
  });

  it("changes nothing for someone who may only look, and on a version that is only shown", () => {
    const doc = new Y.Doc();
    applySpec(doc, addOperator(EMPTY_SPEC, op("a")));
    const viewer = createEditorStore({ ...workflow, readonly: true }, session(doc).document, none);
    viewer.getState().edit(s => addOperator(s, op("b")));
    viewer.getState().move({ a: { x: 1, y: 1 } });
    viewer.getState().rename("Nope");
    expect(ids(specOf(doc))).toEqual(["a"]);
    expect(positionsOf(doc)).toEqual({});
    expect(viewer.getState().name).toBe("Sales");

    const old = addOperator(addOperator(EMPTY_SPEC, op("x")), op("y"));
    const shown = createEditorStore({ ...workflow, readonly: true }, fixedDocument(old), none);
    expect(ids(shown.getState().spec)).toEqual(["x", "y"]);
    expect(Object.keys(shown.getState().positions).sort()).toEqual(["x", "y"]);
    expect(shown.getState().saveState).toBe("saved");
  });

  it("follows the head and the name the catalog reports, and saves a rename through its own call", () => {
    const renames: string[] = [];
    const store = createEditorStore(workflow, session(new Y.Doc()).document, {
      rename: async (_rid, name) => {
        renames.push(name);
      },
    });
    store.getState().follow(4, "Renamed elsewhere");
    expect(store.getState().headVno).toBe(4);
    expect(store.getState().name).toBe("Renamed elsewhere");
    store.getState().rename("  Sales 2026 ");
    expect(store.getState().name).toBe("Sales 2026");
    expect(renames).toEqual(["Sales 2026"]);
  });

  it("stops following the document once the view is gone", () => {
    const doc = new Y.Doc();
    const store = createEditorStore(workflow, session(doc).document, none);
    store.getState().close();
    applySpec(doc, addOperator(EMPTY_SPEC, op("late")));
    expect(ids(store.getState().spec)).toEqual([]);
  });
});

describe("what someone else holds", () => {
  const start = () => {
    const doc = new Y.Doc();
    applySpec(doc, { operators: [op("a"), op("b")], links: [] });
    const { document } = session(doc);
    const store = createEditorStore(workflow, { ...document, history: historyIn(doc) }, none);
    return { doc, store };
  };
  const set = (id: string, n: number) => (spec: WorkflowSpec) => ({
    ...spec,
    operators: spec.operators.map(o => (o.operatorID === id ? { ...o, operatorProperties: { n } } : o)),
  });

  it("cannot be changed or dropped from here; the rest of the workflow can, and it can be moved and wired", () => {
    const { doc, store } = start();
    store.getState().setHeld(new Set(["a"]));
    store.getState().edit(set("a", 1));
    expect(specOf(doc).operators.find(o => o.operatorID === "a")?.operatorProperties).toEqual({});
    store.getState().edit(spec => ({ ...spec, operators: spec.operators.filter(o => o.operatorID !== "a") }));
    expect(ids(specOf(doc))).toContain("a");
    store.getState().edit(set("b", 2));
    expect(specOf(doc).operators.find(o => o.operatorID === "b")?.operatorProperties).toEqual({ n: 2 });
    store.getState().move({ a: { x: 5, y: 6 } });
    expect(positionsOf(doc).a).toEqual({ x: 5, y: 6 });
  });

  it("is not changed by taking back this person's own step, until it is free again", () => {
    const { doc, store } = start();
    store.getState().edit(set("a", 1));
    expect(store.getState().canUndo).toBe(true);
    store.getState().setHeld(new Set(["a"]));
    expect(store.getState().canUndo).toBe(false);
    store.getState().undo();
    expect(specOf(doc).operators.find(o => o.operatorID === "a")?.operatorProperties).toEqual({ n: 1 });
    store.getState().setHeld(new Set());
    expect(store.getState().canUndo).toBe(true);
    store.getState().undo();
    expect(specOf(doc).operators.find(o => o.operatorID === "a")?.operatorProperties).toEqual({});
  });
});

