// The open workflow: one store per workflow, shared by every view of it, holding the
// content being edited and saving it shortly after each change as a new version
// (POST /workflows/{rid}/edit with the head the editor saw, so two writers never
// silently overwrite each other).

import { resourcesUpdateMetadata, workflowsEdit } from "@texera/catalog-client";
import type { ResourceVersion } from "@texera/catalog-client/types";
import type { WorkflowContent } from "@texera/workflow-model";
import { createStore, type StoreApi } from "zustand";
import { CatalogError, unwrap } from "../api";

export type SaveState = "saved" | "pending" | "saving" | "failed" | "conflict";

export interface OpenWorkflow {
  rid: string;
  name: string;
  headVno: number;
  content: WorkflowContent;
  readonly: boolean;
}

export interface EditorState {
  rid: string;
  name: string;
  /** The version this editor's content is based on; every save moves it forward. */
  headVno: number;
  content: WorkflowContent;
  readonly: boolean;
  selected: string | null;
  saveState: SaveState;
  saveError?: string;
  edit: (change: (content: WorkflowContent) => WorkflowContent) => void;
  rename: (name: string) => void;
  select: (operatorId: string | null) => void;
  /** Takes a newer version from the server unless edits of this view are waiting. */
  adopt: (content: WorkflowContent, vno: number, name?: string) => void;
  /** Saves now if a save is waiting. */
  flush: () => Promise<void>;
}

export interface EditorDeps {
  save: (rid: string, content: WorkflowContent, expectedHead: number) => Promise<ResourceVersion>;
  rename: (rid: string, name: string) => Promise<void>;
  /** Called with every version this editor created, so caches can follow. */
  onSaved?: (version: ResourceVersion, content: WorkflowContent) => void;
}

const SAVE_DELAY_MS = 800;

export type EditorStore = StoreApi<EditorState>;

export const catalogDeps: EditorDeps = {
  save: (rid, content, expectedHead) =>
    unwrap(workflowsEdit({ path: { rid }, body: { content, expectedHead, message: "Edited in the workflow editor" } })),
  rename: async (rid, name) => {
    await unwrap(resourcesUpdateMetadata({ path: { rid }, body: { name } }));
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
      const { rid, content, headVno } = get();
      set({ saveState: "saving" });
      inFlight = deps
        .save(rid, content, headVno)
        .then(version => {
          set({ headVno: version.vno });
          if (get().content === content) set({ saveState: "saved", saveError: undefined });
          deps.onSaved?.(version, content);
        })
        .catch(e => {
          const conflict = e instanceof CatalogError && e.status === 409;
          set({
            saveState: conflict ? "conflict" : "failed",
            saveError: e instanceof Error ? e.message : String(e),
          });
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
      content: workflow.content,
      readonly: workflow.readonly,
      selected: null,
      saveState: "saved",
      edit: change => {
        if (get().readonly) return;
        const content = change(get().content);
        if (content === get().content) return;
        set({ content, saveState: "pending" });
        schedule();
      },
      rename: name => {
        const next = name.trim();
        if (get().readonly || !next || next === get().name) return;
        set({ name: next });
        void deps.rename(get().rid, next).catch(e => set({ saveError: e instanceof Error ? e.message : String(e) }));
      },
      select: id => set({ selected: id }),
      adopt: (content, vno, name) => {
        const state = get().saveState;
        if (state === "pending" || state === "saving") return;
        if (vno < get().headVno && state !== "conflict") return;
        set({ content, headVno: vno, saveState: "saved", saveError: undefined, ...(name ? { name } : {}) });
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
