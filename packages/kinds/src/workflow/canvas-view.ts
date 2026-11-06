// How a canvas is looked at: how much each operator's card says, whether the map of a large
// workflow is open, which card is open for editing, and which result is on screen. None of it
// is the workflow's; it is the viewer's, so none of it is in the document or in a version.

import type { Compilation, OperatorSchema } from "@texera/workflow-model";
import { createContext, use } from "react";
import { createStore, type StoreApi } from "zustand";
import type { EditorStore } from "./editor";

/** How much a card says: its settings in one line, or each of them on a line of its own. */
export type Density = "compact" | "detailed";

// What the viewer chose for every canvas is kept in the browser, for the next one they open.
const DENSITY_KEY = "texera-canvas-density";
const MAP_KEY = "texera-canvas-map";

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* kept for this page only */
  }
}

/** An output port of an operator, as one key: the result it holds is named by it. */
export const portKey = (operatorID: string, portID: string) => `${operatorID}:${portID}`;

export interface CanvasViewState {
  density: Density;
  /** Whether the map of a workflow too large to see at once is open. It lies over the canvas, so it is closed until asked for. */
  map: boolean;
  /** The operator whose settings are open in its card. */
  editing: string | null;
  /** The result on screen under the canvas, by its port's key. */
  result: string | null;
  setDensity: (density: Density) => void;
  setMap: (open: boolean) => void;
  edit: (operatorID: string | null) => void;
  show: (result: string | null) => void;
}

export type CanvasView = StoreApi<CanvasViewState>;

export function createCanvasView(): CanvasView {
  return createStore<CanvasViewState>()(set => ({
    density: remembered(DENSITY_KEY) === "detailed" ? "detailed" : "compact",
    map: remembered(MAP_KEY) === "open",
    editing: null,
    result: null,
    setDensity: density => {
      remember(DENSITY_KEY, density);
      set({ density });
    },
    setMap: open => {
      remember(MAP_KEY, open ? "open" : "closed");
      set({ map: open });
    },
    edit: operatorID => set({ editing: operatorID }),
    show: result => set({ result }),
  }));
}

/** What a card needs from the canvas it is on. */
export interface Canvas {
  view: CanvasView;
  /** Every operator type's schema: its name, and its settings' titles. */
  schemas?: Map<string, OperatorSchema>;
  /** The workflow being edited; absent on a canvas that only shows one. */
  editor?: EditorStore;
  /** What the compiler says of the workflow on screen: the columns each operator reads. */
  compilation?: Compilation;
  /** Runs the workflow up to an operator; absent where nothing can be run from the canvas. */
  run?: (operatorID: string) => void;
  /** A small picture of a workflow (the card of one in a chat): an operator is its icon with its name under it. */
  picture?: boolean;
}

export const CanvasContext = createContext<Canvas | null>(null);

export function useCanvas(): Canvas {
  const canvas = use(CanvasContext);
  if (!canvas) throw new Error("an operator's card is on no canvas");
  return canvas;
}
