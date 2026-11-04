import type { WorkflowVersion } from "@texera/catalog-client/types";
import { addOperator, EMPTY_SPEC, type WorkflowSpec } from "@texera/workflow-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogError } from "../api";
import { createEditorStore, type EditorDeps } from "./editor";

const version = (vno: number): WorkflowVersion => ({
  rid: "wf",
  uri: `texera://workflows/wf@${vno}`,
  kind: "workflow",
  vno,
  contentKind: "spec",
  digest: "sha256:0",
  content: EMPTY_SPEC,
  createdBy: "p",
  createdAt: "2026-11-03T00:00:00Z",
});

const op = (id: string) => ({ operatorID: id, operatorType: "Limit", operatorProperties: {} });

const saves: { spec: WorkflowSpec; expectedHead: number }[] = [];
let nextVno = 2;
let deps: EditorDeps;

beforeEach(() => {
  vi.useFakeTimers();
  saves.length = 0;
  nextVno = 2;
  deps = {
    save: async (_rid, spec, expectedHead) => {
      saves.push({ spec, expectedHead });
      return version(nextVno++);
    },
    rename: async () => {},
  };
});
afterEach(() => vi.useRealTimers());

const workflow = { rid: "wf", name: "Sales", headVno: 1, spec: EMPTY_SPEC, readonly: false };

describe("editor store", () => {
  it("coalesces quick edits into one new version based on the head it saw, and lays out new operators", async () => {
    const store = createEditorStore(workflow, deps);
    store.getState().edit(s => addOperator(s, op("a")));
    store.getState().edit(s => addOperator(s, op("b")));
    expect(store.getState().saveState).toBe("pending");
    expect(store.getState().positions.a).toBeDefined();
    expect(store.getState().positions.b?.y).toBeGreaterThan(store.getState().positions.a?.y ?? 0);
    await vi.runAllTimersAsync();
    expect(saves).toHaveLength(1);
    expect(saves[0]?.expectedHead).toBe(1);
    expect(saves[0]?.spec.operators.map(o => o.operatorID)).toEqual(["a", "b"]);
    expect(store.getState().saveState).toBe("saved");
    expect(store.getState().headVno).toBe(2);
  });

  it("keeps moves out of the spec and does not let a version saved elsewhere overwrite waiting edits", async () => {
    const store = createEditorStore(workflow, deps);
    store.getState().edit(s => addOperator(s, op("a")));
    store.getState().move({ a: { x: 500, y: 500 } });
    store.getState().adopt(EMPTY_SPEC, 5, "Renamed by the agent");
    expect(store.getState().spec.operators).toHaveLength(1);
    await vi.runAllTimersAsync();
    expect(saves[0]?.spec).not.toHaveProperty("positions");
    store.getState().adopt(EMPTY_SPEC, 5, "Renamed by the agent");
    expect(store.getState().name).toBe("Renamed by the agent");
    expect(store.getState().headVno).toBe(5);
  });

  it("ignores an older version than the one it is on", () => {
    const store = createEditorStore({ ...workflow, headVno: 4 }, deps);
    store.getState().adopt(addOperator(EMPTY_SPEC, op("old")), 3);
    expect(store.getState().spec.operators).toHaveLength(0);
  });

  it("reports a conflict when the head moved under it, and recovers by adopting the server's version", async () => {
    deps.save = async () => {
      throw new CatalogError(409, "head moved");
    };
    const store = createEditorStore(workflow, deps);
    store.getState().edit(s => addOperator(s, op("a")));
    await vi.runAllTimersAsync();
    expect(store.getState().saveState).toBe("conflict");
    store.getState().adopt(EMPTY_SPEC, 1);
    expect(store.getState().saveState).toBe("saved");
  });

  it("starts from the person's kept positions and keeps their moves, debounced, outside the spec", async () => {
    const kept: Record<string, unknown>[] = [];
    deps.savePositions = async (_rid, positions) => {
      kept.push(positions);
    };
    const spec = addOperator(addOperator(EMPTY_SPEC, op("a")), op("b"));
    const store = createEditorStore({ ...workflow, spec, positions: { a: { x: 300, y: 300 } } }, deps);
    expect(store.getState().positions.a).toEqual({ x: 300, y: 300 });
    expect(store.getState().positions.b).toBeDefined();
    store.getState().move({ b: { x: 1, y: 1 } });
    store.getState().move({ b: { x: 2, y: 2 } });
    await vi.runAllTimersAsync();
    expect(kept).toEqual([{ a: { x: 300, y: 300 }, b: { x: 2, y: 2 } }]);
    expect(saves).toHaveLength(0);
  });

  it("does nothing while read-only and saves a rename through its own call", async () => {
    const renames: string[] = [];
    deps.rename = async (_rid, name) => {
      renames.push(name);
    };
    const store = createEditorStore({ ...workflow, readonly: true }, deps);
    store.getState().edit(s => addOperator(s, op("a")));
    store.getState().rename("Nope");
    expect(store.getState().spec.operators).toHaveLength(0);
    const writable = createEditorStore(workflow, deps);
    writable.getState().rename("  Sales 2026 ");
    expect(writable.getState().name).toBe("Sales 2026");
    expect(renames).toEqual(["Sales 2026"]);
  });
});
