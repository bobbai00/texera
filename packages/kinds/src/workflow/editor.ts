// The open workflow, as its views read and change it: the spec, where its operators sit, what
// is selected. The store holds none of it by itself. It mirrors the workflow's document (the
// live session's, or one version to look at): an edit is written into the document and comes
// back from it, the same way someone else's edit arrives. Saving is the session's work, so
// the store only says whether what was written has got there and whether the catalog took it.
// Everything a person changes comes through here, so this is where what someone else holds is
// refused.

import { changedOperators, normalizeSpec, type Point, type Positions, placeMissing, same, type WorkflowSpec } from "@texera/workflow-model";
import { createStore, type StoreApi } from "zustand";
import { updateMetadata } from "../api";
import type { SyncState, WorkflowDocument } from "./document";

export type SaveState = SyncState;

export interface OpenWorkflow {
  rid: string;
  name: string;
  headVno: number;
  /** A version that is only shown, or a person who may only look. */
  readonly: boolean;
}

export interface EditorState {
  rid: string;
  name: string;
  /** The workflow's newest version, as the catalog reports it. */
  headVno: number;
  spec: WorkflowSpec;
  /** A place for every operator: where the session put it, or laid out until it has. */
  positions: Positions;
  readonly: boolean;
  selected: string | null;
  /** The operators someone else holds: looked at here, not changed. Where they sit and their wires stay free. */
  held: ReadonlySet<string>;
  saveState: SaveState;
  /** Why the catalog did not take the workflow as a version, while that stands. */
  refusal?: string;
  /** Why a new name was not saved. */
  saveError?: string;
  /** Whether this person has an edit to take back, or one taken back to do again. */
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  edit: (change: (spec: WorkflowSpec) => WorkflowSpec) => void;
  move: (moves: Record<string, Point>) => void;
  rename: (name: string) => void;
  select: (operatorId: string | null) => void;
  setHeld: (held: ReadonlySet<string>) => void;
  /** Takes the head and the name the catalog reports for the workflow. */
  follow: (headVno: number, name: string) => void;
  /** Resolves once the catalog has a version of everything written here, with that version's number. */
  flush: () => Promise<number | undefined>;
  /** Stops following the document: the view is gone. */
  close: () => void;
}

export interface EditorDeps {
  rename: (rid: string, name: string) => Promise<void>;
}

export type EditorStore = StoreApi<EditorState>;

export const catalogDeps: EditorDeps = {
  rename: async (rid, name) => {
    await updateMetadata(rid, { name });
  },
};

export function createEditorStore(workflow: OpenWorkflow, document: WorkflowDocument, deps: EditorDeps = catalogDeps): EditorStore {
  return createStore<EditorState>()((set, get) => {
    // What the views read has its ports spelled out, as every spec the app shows; the document
    // holds what the catalog has, and takes only what a person changes.
    const read = (previous?: WorkflowSpec) => normalizeSpec(document.spec(previous));
    const first = read();
    const isHeld = (ids: Iterable<string>) => [...ids].some(id => get().held.has(id));
    /** Whether a step of this person's history may be taken: not over an operator someone else holds. */
    const free = (step: "undo" | "redo") => !get().readonly && !isHeld(document.history?.touches(step) ?? []);
    const steps = () => ({
      canUndo: !!document.history?.canUndo() && free("undo"),
      canRedo: !!document.history?.canRedo() && free("redo"),
    });
    const stop = [
      document.watch(() => {
        // The same spec object while only the layout changed: whatever is computed from the
        // spec (a compile) is not redone for a move.
        const next = read(get().spec);
        const spec = same(next, get().spec) ? get().spec : next;
        set({ spec, positions: placeMissing(spec, document.positions()) });
      }),
      document.watchState(() => set({ saveState: document.state(), refusal: document.refusal() })),
      document.history?.watch(() => set(steps())) ?? (() => undefined),
    ];
    return {
      rid: workflow.rid,
      name: workflow.name,
      headVno: workflow.headVno,
      spec: first,
      positions: placeMissing(first, document.positions()),
      readonly: workflow.readonly,
      selected: null,
      held: new Set(),
      saveState: document.state(),
      refusal: document.refusal(),
      canUndo: false,
      canRedo: false,
      undo: () => {
        if (free("undo")) document.history?.undo();
      },
      redo: () => {
        if (free("redo")) document.history?.redo();
      },
      edit: change => {
        if (get().readonly) return;
        const before = get().spec;
        const next = change(before);
        if (next !== before && !isHeld(changedOperators(before, next))) document.change(before, next);
      },
      move: moves => {
        if (!get().readonly) document.move(moves);
      },
      rename: name => {
        const next = name.trim();
        if (get().readonly || !next || next === get().name) return;
        set({ name: next });
        void deps.rename(get().rid, next).catch(e => set({ saveError: e instanceof Error ? e.message : String(e) }));
      },
      select: id => set({ selected: id }),
      setHeld: held => {
        set({ held });
        set(steps());
      },
      follow: (headVno, name) => set({ headVno, name }),
      flush: () => document.settle(),
      close: () => {
        for (const unsubscribe of stop) unsubscribe();
        document.history?.destroy();
      },
    };
  });
}
