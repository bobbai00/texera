// The panel stack: what is open beside the page. The top entry shows; opening another
// resource pushes it; closing pops. The app mirrors the stack into the URL so a link
// reopens the same view. The stack knows nothing about kinds: entries are references.

import { create } from "zustand";

export interface PanelRef {
  kind: string;
  rid: string;
  vno?: number;
}

export const panelKey = (r: PanelRef) => `${r.kind}:${r.rid}${r.vno !== undefined ? `@${r.vno}` : ""}`;

/** Parses `kind:rid[@vno]`; undefined when malformed. */
export function parsePanelRef(text: string | undefined): PanelRef | undefined {
  if (!text) return undefined;
  const m = /^([a-z_]+):([^@]+)(?:@(\d+))?$/.exec(text);
  if (!m?.[1] || !m[2]) return undefined;
  return { kind: m[1], rid: m[2], ...(m[3] ? { vno: Number(m[3]) } : {}) };
}

interface PanelState {
  stack: PanelRef[];
  open: (ref: PanelRef) => void;
  /** Replaces the whole stack (from the URL). */
  set: (stack: PanelRef[]) => void;
  back: () => void;
  close: () => void;
}

export const usePanelStack = create<PanelState>(set => ({
  stack: [],
  open: ref =>
    set(s => {
      const key = panelKey(ref);
      const without = s.stack.filter(r => panelKey(r) !== key);
      return { stack: [...without, ref] };
    }),
  set: stack => set({ stack }),
  back: () => set(s => ({ stack: s.stack.slice(0, -1) })),
  close: () => set({ stack: [] }),
}));

export const useOpenPanel = () => usePanelStack(s => s.stack.at(-1));
