import { applySpec, EMPTY_SPEC, readSaveRequest, STANDING, saveAnswer } from "@texera/workflow-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Room } from "../live/room";
import { liveDocument } from "./document";

/** A workflow's session as the app has it, with the service's side of it in the test's hands. */
function session() {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const emit = (event: string, payload?: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload as never);
  };
  const states = new Map<number, Record<string, unknown>>();
  const awareness = {
    getStates: () => states,
    on: (event: string, listener: (payload: never) => void) => listeners.set(`awareness:${event}`, (listeners.get(`awareness:${event}`) ?? new Set()).add(listener)),
    off: (event: string, listener: (payload: never) => void) => listeners.get(`awareness:${event}`)?.delete(listener),
  };
  const asked: string[] = [];
  const room = {
    document: new Y.Doc(),
    awareness,
    hasUnsyncedChanges: false,
    on: (event: string, listener: (payload: never) => void) => listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
    off: (event: string, listener: (payload: never) => void) => listeners.get(event)?.delete(listener),
    sendStateless: (payload: string) => {
      const id = readSaveRequest(payload);
      if (id !== undefined) asked.push(id);
    },
  };
  return {
    room: room as unknown as Room,
    asked,
    /** The service says how the document stands with the catalog. */
    stands(standing: { vno: number; refused?: string }) {
      states.set(1, { [STANDING]: standing });
      emit("awareness:change");
    },
    /** The service says something to this person alone. */
    says: (payload: string) => emit("stateless", { payload }),
    unsynced(unsynced: boolean) {
      room.hasUnsyncedChanges = unsynced;
      emit("unsyncedChanges");
    },
    status: (status: string) => emit("status", { status }),
  };
}

describe("the document of a workflow's live session", () => {
  it("says whether what was written is on its way, with the session, or kept from it", () => {
    const live = session();
    const document = liveDocument(live.room);
    const seen: string[] = [];
    document.watchState(() => seen.push(document.state()));
    expect(document.state()).toBe("saved");
    live.unsynced(true);
    live.status("disconnected");
    live.status("connected");
    live.unsynced(false);
    expect(seen).toEqual(["pending", "offline", "pending", "saved"]);
  });

  it("says when the catalog did not take the workflow, and why, until it does", () => {
    const live = session();
    const document = liveDocument(live.room);
    const seen: [string, string | undefined][] = [];
    const stop = document.watchState(() => seen.push([document.state(), document.refusal()]));
    live.stands({ vno: 3 });
    live.stands({ vno: 3, refused: "texera://datasets/d@9/files/x.csv does not exist" });
    live.stands({ vno: 4 });
    expect(seen).toEqual([
      ["saved", undefined],
      ["refused", "texera://datasets/d@9/files/x.csv does not exist"],
      ["saved", undefined],
    ]);
    stop();
    live.stands({ vno: 4, refused: "later" });
    expect(seen).toHaveLength(3);
  });

  it("settles on the version the session saved for this request, once everything written has reached it", async () => {
    const live = session();
    const document = liveDocument(live.room);
    applySpec(live.room.document, EMPTY_SPEC);
    live.room.hasUnsyncedChanges = true;
    const settled = document.settle();
    // Nothing is asked while an edit is still on its way.
    await Promise.resolve();
    expect(live.asked).toEqual([]);
    live.unsynced(false);
    await Promise.resolve();
    expect(live.asked).toHaveLength(1);
    // An answer to someone else's request is not this one's.
    live.says(saveAnswer({ id: "another", vno: 6 }));
    live.says(saveAnswer({ id: live.asked[0] as string, vno: 7 }));
    expect(await settled).toBe(7);
  });

  it("takes back this person's own edits and moves, and does them again; what others did stays", () => {
    const live = session();
    const doc = live.room.document;
    const base = { operators: [{ operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: {} }], links: [] };
    // What the session loaded, and what another person did, arrive from the provider.
    const provider = { remote: true };
    applySpec(doc, base, provider);
    const document = liveDocument(live.room);
    const history = document.history;
    expect(history?.canUndo()).toBe(false);
    let told = 0;
    history?.watch(() => told++);
    const withLimit = { ...base, operators: [...base.operators, { operatorID: "limit", operatorType: "Limit", operatorProperties: { limit: 5 } }] };
    document.change(base, withLimit);
    document.move({ limit: { x: 300, y: 40 } });
    // Someone else's edit, after this person's: undo leaves it in place.
    applySpec(doc, { ...withLimit, operators: withLimit.operators.map(o => (o.operatorID === "scan" ? { ...o, customDisplayName: "theirs" } : o)) }, provider);
    expect(history?.canUndo()).toBe(true);
    expect(told).toBeGreaterThan(0);
    history?.undo();
    const back = document.spec();
    expect(back.operators.map(o => o.operatorID)).toEqual(["scan"]);
    expect(back.operators[0]?.customDisplayName).toBe("theirs");
    expect(document.positions().limit).toBeUndefined();
    expect(history?.canRedo()).toBe(true);
    history?.redo();
    expect(document.spec().operators.map(o => o.operatorID).sort()).toEqual(["limit", "scan"]);
    expect(document.positions().limit).toEqual({ x: 300, y: 40 });
    history?.destroy();
  });

  it("does not settle on a workflow the catalog would not take: it says why", async () => {
    const live = session();
    const settled = liveDocument(live.room).settle();
    await Promise.resolve();
    live.says(saveAnswer({ id: live.asked[0] as string, refused: "texera://datasets/d@9/files/x.csv does not exist" }));
    await expect(settled).rejects.toThrow("the workflow is not saved: texera://datasets/d@9/files/x.csv does not exist");
  });
});
