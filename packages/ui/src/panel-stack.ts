// The panel stack: what is open beside the page. The top entry shows; opening another
// resource pushes it; closing pops. The app mirrors the stack into the URL so a link
// reopens the same view. Entries are resource paths (`datasets/{rid}@2`), the same text
// the URL carries; the stack knows nothing about kinds.

import { create } from "zustand";

interface PanelState {
  stack: string[];
  open: (entry: string) => void;
  /** Replaces the whole stack (from the URL). */
  set: (stack: string[]) => void;
  back: () => void;
  close: () => void;
}

export const usePanelStack = create<PanelState>(set => ({
  stack: [],
  open: entry => set(s => ({ stack: [...s.stack.filter(e => e !== entry), entry] })),
  set: stack => set({ stack }),
  back: () => set(s => ({ stack: s.stack.slice(0, -1) })),
  close: () => set({ stack: [] }),
}));

export const useOpenPanel = () => usePanelStack(s => s.stack.at(-1));
