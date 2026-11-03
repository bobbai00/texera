import type { ResourceVersion } from "@texera/catalog-client/types";
import { EMPTY_CONTENT, moveOperators, type WorkflowContent } from "@texera/workflow-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogError } from "../api";
import { createEditorStore, type EditorDeps } from "./editor";

const version = (vno: number): ResourceVersion => ({
  rid: "wf",
  vno,
  contentKind: "json",
  createdBy: "p",
  createdAt: "2026-11-03T00:00:00Z",
});

const saves: { content: WorkflowContent; expectedHead: number }[] = [];
let nextVno = 2;
let deps: EditorDeps;

beforeEach(() => {
  vi.useFakeTimers();
  saves.length = 0;
  nextVno = 2;
  deps = {
    save: async (_rid, content, expectedHead) => {
      saves.push({ content, expectedHead });
      return version(nextVno++);
    },
    rename: async () => {},
  };
});
afterEach(() => vi.useRealTimers());

const workflow = { rid: "wf", name: "Sales", headVno: 1, content: EMPTY_CONTENT, readonly: false };

describe("editor store", () => {
  it("coalesces quick edits into one new version based on the head it saw", async () => {
    const store = createEditorStore(workflow, deps);
    store.getState().edit(c => moveOperators(c, { a: { x: 1, y: 1 } }));
    store.getState().edit(c => moveOperators(c, { a: { x: 2, y: 2 } }));
    expect(store.getState().saveState).toBe("pending");
    await vi.runAllTimersAsync();
    expect(saves).toHaveLength(1);
    expect(saves[0]?.expectedHead).toBe(1);
    expect(saves[0]?.content.operatorPositions.a).toEqual({ x: 2, y: 2 });
    expect(store.getState().saveState).toBe("saved");
    expect(store.getState().headVno).toBe(2);
  });

  it("does not let a version saved elsewhere overwrite edits waiting to be saved", async () => {
    const store = createEditorStore(workflow, deps);
    store.getState().edit(c => moveOperators(c, { a: { x: 1, y: 1 } }));
    store.getState().adopt(EMPTY_CONTENT, 5, "Renamed by the agent");
    expect(store.getState().content.operatorPositions.a).toEqual({ x: 1, y: 1 });
    await vi.runAllTimersAsync();
    store.getState().adopt(EMPTY_CONTENT, 5, "Renamed by the agent");
    expect(store.getState().name).toBe("Renamed by the agent");
    expect(store.getState().headVno).toBe(5);
  });

  it("ignores an older version than the one it is on", () => {
    const store = createEditorStore({ ...workflow, headVno: 4 }, deps);
    store.getState().adopt(moveOperators(EMPTY_CONTENT, { z: { x: 0, y: 0 } }), 3);
    expect(store.getState().content.operatorPositions.z).toBeUndefined();
  });

  it("marks a conflict when the head moved under it, then takes the newer version", async () => {
    deps.save = async () => {
      throw new CatalogError(409, "head moved");
    };
    const store = createEditorStore(workflow, deps);
    store.getState().edit(c => moveOperators(c, { a: { x: 1, y: 1 } }));
    await vi.runAllTimersAsync();
    expect(store.getState().saveState).toBe("conflict");
    store.getState().adopt(EMPTY_CONTENT, 7);
    expect(store.getState().headVno).toBe(7);
    expect(store.getState().saveState).toBe("saved");
  });

  it("ignores edits to a read-only workflow", () => {
    const store = createEditorStore({ ...workflow, readonly: true }, deps);
    store.getState().edit(c => moveOperators(c, { a: { x: 1, y: 1 } }));
    store.getState().rename("Mine now");
    expect(store.getState().saveState).toBe("saved");
    expect(store.getState().name).toBe("Sales");
  });
});
