// The open workflow: one store per workflow, shared by every view of it, holding the spec
// being edited and its canvas positions, and saving the spec shortly after each change as a
// new version (POST /workflows/{rid}/edit with the head the editor saw, so two writers never
// silently overwrite each other). Positions stay in the app: the spec is the engine's plan.

import { workflowsEdit } from "@texera/catalog-client";
import type { WorkflowVersion } from "@texera/catalog-client/types";
import { type Point, type Positions, reconcilePositions, type WorkflowSpec } from "@texera/workflow-model";
import { createStore, type StoreApi } from "zustand";
import { CatalogError, unwrap, updateMetadata } from "../api";

export type SaveState = "saved" | "pending" | "saving" | "failed" | "conflict";

export interface OpenWorkflow {
  rid: string;
  name: string;
  headVno: number;
  spec: WorkflowSpec;
  readonly: boolean;
}

export interface EditorState {
  rid: string;
  name: string;
  /** The version this editor's spec is based on; every save moves it forward. */
  headVno: number;
  spec: WorkflowSpec;
  positions: Positions;
  readonly: boolean;
  selected: string | null;
  saveState: SaveState;
  saveError?: string;
  edit: (change: (spec: WorkflowSpec) => WorkflowSpec) => void;
  move: (moves: Record<string, Point>) => void;
  rename: (name: string) => void;
  select: (operatorId: string | null) => void;
  /** Takes a newer version from the server unless edits of this view are waiting. */
  adopt: (spec: WorkflowSpec, vno: number, name?: string) => void;
  /** Saves now if a save is waiting. */
  flush: () => Promise<void>;
}

export interface EditorDeps {
  save: (rid: string, spec: WorkflowSpec, expectedHead: number) => Promise<WorkflowVersion>;
  rename: (rid: string, name: string) => Promise<void>;
  /** Called with every version this editor created, so caches can follow. */
  onSaved?: (version: WorkflowVersion, spec: WorkflowSpec) => void;
}

const SAVE_DELAY_MS = 800;

export type EditorStore = StoreApi<EditorState>;

export const catalogDeps: EditorDeps = {
  save: (rid, spec, expectedHead) => unwrap(workflowsEdit({ path: { rid }, body: { spec, expectedHead, message: "Edited in the workflow editor" } })),
  rename: async (rid, name) => {
    await updateMetadata(rid, { name });
  },
};

export function createEditorStore(workflow: OpenWorkflow, deps: EditorDeps): EditorStore {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const store = createStore<EditorState>()((set, get) => {
    const save = async (): Promise<void> => {
      timer = undefined;
      if (inFlight) {
        await inFlight;
        if (get().saveState === "pending") return save();
        return;
      }
      const { rid, spec, headVno } = get();
      set({ saveState: "saving" });
      inFlight = deps
        .save(rid, spec, headVno)
        .then(version => {
          set({ headVno: version.vno });
          if (get().spec === spec) set({ saveState: "saved", saveError: undefined });
          deps.onSaved?.(version, spec);
        })
        .catch(e => {
          const conflict = e instanceof CatalogError && e.status === 409;
          set({ saveState: conflict ? "conflict" : "failed", saveError: e instanceof Error ? e.message : String(e) });
        })
        .finally(() => {
          inFlight = undefined;
        });
      await inFlight;
      if (get().saveState === "pending" && !timer) schedule();
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void save(), SAVE_DELAY_MS);
    };

    return {
      rid: workflow.rid,
      name: workflow.name,
      headVno: workflow.headVno,
      spec: workflow.spec,
      positions: reconcilePositions(workflow.spec, {}),
      readonly: workflow.readonly,
      selected: null,
      saveState: "saved",
      edit: change => {
        if (get().readonly) return;
        const spec = change(get().spec);
        if (spec === get().spec) return;
        set({ spec, positions: reconcilePositions(spec, get().positions), saveState: "pending" });
        schedule();
      },
      move: moves => set({ positions: { ...get().positions, ...moves } }),
      rename: name => {
        const next = name.trim();
        if (get().readonly || !next || next === get().name) return;
        set({ name: next });
        void deps.rename(get().rid, next).catch(e => set({ saveError: e instanceof Error ? e.message : String(e) }));
      },
      select: id => set({ selected: id }),
      adopt: (spec, vno, name) => {
        const state = get().saveState;
        if (state === "pending" || state === "saving") return;
        if (vno < get().headVno && state !== "conflict") return;
        set({ spec, positions: reconcilePositions(spec, get().positions), headVno: vno, saveState: "saved", saveError: undefined, ...(name ? { name } : {}) });
      },
      flush: async () => {
        if (timer) {
          clearTimeout(timer);
          await save();
        } else if (inFlight) await inFlight;
      },
    };
  });
  return store;
}

// Views of the same workflow share one store; it lives while any of them is mounted.
const open = new Map<string, { store: EditorStore; users: number }>();

export function acquireEditor(workflow: OpenWorkflow, deps: EditorDeps = catalogDeps): EditorStore {
  const entry = open.get(workflow.rid);
  if (entry) {
    entry.users++;
    return entry.store;
  }
  const store = createEditorStore(workflow, deps);
  open.set(workflow.rid, { store, users: 1 });
  return store;
}

export function releaseEditor(rid: string): void {
  const entry = open.get(rid);
  if (!entry) return;
  if (--entry.users > 0) return;
  open.delete(rid);
  void entry.store.getState().flush();
}

/** The store of a workflow open in some view, if any (so the chat can push an agent's edits into it). */
export const openEditor = (rid: string): EditorStore | undefined => open.get(rid)?.store;
