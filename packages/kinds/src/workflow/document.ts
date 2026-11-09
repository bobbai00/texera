// Where the workflow an editor shows lives. While people edit the head it is the document of
// the workflow's live session: every edit goes into it and comes out of it, whoever made it,
// and the live service saves it into the catalog's versions. An older version is only looked
// at: the same interface over a spec that never changes.

import { applyChange, historyOf, movePositions, operatorsOfStep, type Positions, positionsOf, readSaveAnswer, type SaveAnswer, saveRequest, specOf, standingIn, type WorkflowSpec } from "@texera/workflow-model";
import type * as Y from "yjs";
import type { Room } from "../live/room";

/**
 * Where what was written here stands: with the session and saved, on its way, unable to go
 * right now, or with the session but not taken by the catalog as a version.
 */
export type SyncState = "saved" | "pending" | "offline" | "refused";

/** What this person did to the document, to take back and do again; what others did stays. */
export interface History {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** The operators taking back, or doing again, the last step would change. */
  touches(step: "undo" | "redo"): ReadonlySet<string>;
  /** Calls back whenever what can be taken back or done again changes. */
  watch(listener: () => void): () => void;
  /** Stops recording: the view is gone. */
  destroy(): void;
}

export interface WorkflowDocument {
  /** The spec it holds; operators and links it shares with `previous` come in that order. */
  spec(previous?: WorkflowSpec): WorkflowSpec;
  /** Where the operators sit, for the ones that have been placed. */
  positions(): Positions;
  /** Writes what a person changed: the difference between the spec they saw and what they made of it. */
  change(from: WorkflowSpec, to: WorkflowSpec): void;
  move(moves: Positions): void;
  /** Calls back whenever the spec or the layout changes, whoever changed it. */
  watch(listener: () => void): () => void;
  state(): SyncState;
  /** Why the catalog did not take the workflow as a version, while that stands. */
  refusal(): string | undefined;
  watchState(listener: () => void): () => void;
  /** Resolves once the catalog has a version of everything written here, with that version's number. */
  settle(): Promise<number | undefined>;
  /** This person's edits, to take back; none for a version that is only shown. */
  history?: History;
}

/** A Yjs document's history of this person's edits. */
export function historyIn(doc: Y.Doc): History {
  const manager = historyOf(doc);
  const events = ["stack-item-added", "stack-item-popped", "stack-cleared"] as const;
  return {
    undo: () => void manager.undo(),
    redo: () => void manager.redo(),
    canUndo: () => manager.canUndo(),
    canRedo: () => manager.canRedo(),
    touches: step => operatorsOfStep(manager, step),
    watch: listener => {
      for (const event of events) manager.on(event, listener);
      return () => {
        for (const event of events) manager.off(event, listener);
      };
    },
    destroy: () => manager.destroy(),
  };
}

/** A Yjs document as a workflow's document: the part that needs no connection. */
export function documentOf(doc: Y.Doc): Pick<WorkflowDocument, "spec" | "positions" | "change" | "move" | "watch"> {
  return {
    spec: previous => specOf(doc, previous),
    positions: () => positionsOf(doc),
    change: (from, to) => applyChange(doc, from, to),
    move: moves => movePositions(doc, moves),
    watch: listener => {
      doc.on("update", listener);
      return () => doc.off("update", listener);
    },
  };
}

const SETTLE_WITHIN_MS = 15_000;

/** The document of a workflow's live session. */
export function liveDocument(room: Room): WorkflowDocument {
  let connected = true;
  // The session says in its awareness state how the document stands with the catalog.
  const refusal = () => standingIn((room.awareness?.getStates().values() ?? []) as Iterable<Record<string, unknown>>)?.refused;
  const state = (): SyncState => (refusal() !== undefined ? "refused" : !room.hasUnsyncedChanges ? "saved" : connected ? "pending" : "offline");
  const watchState = (listener: () => void) => {
    const onStatus = ({ status }: { status: string }) => {
      connected = status === "connected";
      listener();
    };
    room.on("unsyncedChanges", listener);
    room.on("status", onStatus);
    room.awareness?.on("change", listener);
    return () => {
      room.off("unsyncedChanges", listener);
      room.off("status", onStatus);
      room.awareness?.off("change", listener);
    };
  };
  /** Resolves with what an event of the session yields, or fails after a while. */
  const until = <E, T>(event: string, yields: (payload?: E) => T | undefined, ask?: () => void) =>
    new Promise<T>((resolve, reject) => {
      const done = (finish: () => void) => {
        clearTimeout(timer);
        room.off(event, on);
        finish();
      };
      const on = (payload?: E) => {
        const value = yields(payload);
        if (value !== undefined) done(() => resolve(value));
      };
      const timer = setTimeout(() => done(() => reject(new Error("the workflow's session did not answer; it has not been saved"))), SETTLE_WITHIN_MS);
      room.on(event, on);
      if (ask) ask();
      else on();
    });
  return {
    ...documentOf(room.document),
    history: historyIn(room.document),
    state,
    refusal,
    watchState,
    async settle() {
      // First everything written here reaches the session, then the session saves it.
      await until("unsyncedChanges", () => (room.hasUnsyncedChanges ? undefined : true));
      const id = crypto.randomUUID();
      const answer = await until<{ payload: string }, SaveAnswer>(
        "stateless",
        said => {
          const heard = readSaveAnswer(said?.payload ?? "");
          return heard?.id === id ? heard : undefined;
        },
        () => room.sendStateless(saveRequest(id))
      );
      if (answer.refused !== undefined) throw new Error(`the workflow is not saved: ${answer.refused}`);
      return answer.vno;
    },
  };
}

/**
 * One version of a workflow, to look at: it holds what it was given, its operators where they
 * sat when it was made, and takes no change.
 */
export function fixedDocument(spec: WorkflowSpec): WorkflowDocument {
  const { layout, ...run } = spec;
  return {
    spec: () => run,
    positions: () => layout ?? {},
    change: () => undefined,
    move: () => undefined,
    watch: () => () => undefined,
    state: () => "saved",
    refusal: () => undefined,
    watchState: () => () => undefined,
    settle: async () => undefined,
  };
}
