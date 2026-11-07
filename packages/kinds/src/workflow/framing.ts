// What part of a canvas is on screen. A workflow is shown whole when it fits at a size its
// words can be read at; a longer one is shown from its beginning at that size, and is moved
// by hand from there. The operator whose result is on screen is kept in view, so its lit port
// can be seen, and so is an operator that just arrived from elsewhere.

import { CARD } from "@texera/workflow-model";
import { useNodesInitialized, useReactFlow, useStoreApi } from "@xyflow/react";
import { type RefObject, useCallback, useEffect } from "react";
import { useStore } from "zustand";
import type { CanvasView, Covered } from "./canvas-view";

/** Never smaller than this by itself: a card's words stay readable. */
export const FIT = { padding: 0.18, minZoom: 0.85, maxZoom: 1 };
const MARGIN = 48;

/** How far the bottom of a canvas is out of use at a card's place: under the results window when the card is above it. */
function coveredBelow(covered: Covered | null | undefined, left: number, right: number): number {
  if (!covered || right < covered.left || left > covered.left + covered.width) return 0;
  return covered.bottom + covered.height;
}

/** Moves the canvas, only as far as needed, so an operator's card is in view, clear of the results window. */
export function useShow(view?: CanvasView): (operatorID: string, animate?: boolean) => void {
  const flow = useReactFlow();
  const store = useStoreApi();
  return useCallback(
    (operatorID, animate = true) => {
      const node = store.getState().nodeLookup.get(operatorID);
      const { width, height: whole, transform } = store.getState();
      // A canvas that is not on screen (its tab is not the one shown) has no size to move within.
      if (!node || !width || !whole) return;
      const [x, y, zoom] = transform;
      const left = node.internals.positionAbsolute.x * zoom + x;
      const top = node.internals.positionAbsolute.y * zoom + y;
      const right = left + (node.measured.width ?? CARD.width) * zoom;
      const bottom = top + (node.measured.height ?? CARD.height) * zoom;
      const height = whole - coveredBelow(view?.getState().covered, left, right);
      // Room on the right for the line that arrives at the card's output port. A card taller
      // than the canvas shows its top.
      const dx = left < MARGIN ? MARGIN - left : right > width - 2 * MARGIN ? width - 2 * MARGIN - right : 0;
      const dy =
        top < MARGIN || bottom - top > height - 2 * MARGIN
          ? MARGIN - top
          : bottom > height - MARGIN
            ? height - MARGIN - bottom
            : 0;
      if ((dx !== 0 || dy !== 0) && Number.isFinite(dx) && Number.isFinite(dy))
        void flow.setViewport({ x: x + dx, y: y + dy, zoom }, animate ? { duration: 250 } : undefined);
    },
    [flow, store, view]
  );
}

const operatorOf = (result: string | null) => (result ? result.slice(0, result.lastIndexOf(":")) : undefined);

/**
 * Brings the workflow into view: all of it when it fits, else its beginning, moved as far as
 * needed for the operator whose result is on screen.
 */
export function useFrame(view: CanvasView): () => Promise<void> {
  const flow = useReactFlow();
  const store = useStoreApi();
  const show = useShow(view);
  return useCallback(async () => {
    // A canvas that is not on screen has no size to fit anything into.
    const seen = () => store.getState().width > 0 && store.getState().height > 0;
    if (!seen() || flow.getNodes().length === 0) return;
    // Over the results window's top, when it lies over the canvas.
    const covered = view.getState().covered;
    await flow.fitView(
      covered
        ? {
            ...FIT,
            padding: { top: "8%", left: "8%", right: "8%", bottom: `${covered.bottom + covered.height + 24}px` },
          }
        : FIT
    );
    // It may have gone from the screen meanwhile (another tab was picked): what was fitted
    // into no room is put right when it is back (`useReframe`).
    if (!seen()) return;
    const { width, transform } = store.getState();
    const [, y, zoom] = transform;
    const bounds = flow.getNodesBounds(flow.getNodes());
    const x = MARGIN - bounds.x * zoom;
    if (bounds.width * zoom > width - 2 * MARGIN && Number.isFinite(x) && Number.isFinite(y))
      await flow.setViewport({ x, y, zoom });
    const shown = operatorOf(view.getState().result);
    if (shown) show(shown, false);
  }, [flow, store, show, view]);
}

/** Keeps in view the operator whose result is on screen, and the card that is open. */
export function useFollow(view: CanvasView): void {
  const shown = useStore(view, s => operatorOf(s.result));
  const editing = useStore(view, s => s.editing);
  const show = useShow(view);
  const measured = useNodesInitialized();
  useEffect(() => {
    if (!shown || !measured) return;
    // After the canvas has settled from whatever else moved it.
    const settle = setTimeout(() => show(shown), 120);
    return () => clearTimeout(settle);
  }, [shown, measured, show]);
  useEffect(() => {
    if (!editing) return;
    // After the card has opened to its full size.
    const settle = setTimeout(() => show(editing), 120);
    return () => clearTimeout(settle);
  }, [editing, show]);
}

/**
 * Frames the canvas again when the room it has changes: its tab is shown again, the results
 * under it are resized. `still` says whether the canvas is still where the app put it; once
 * the person has moved it themselves it is theirs. A canvas left with no place at all (it was
 * framed while off screen) is always framed again.
 */
export function useReframe(
  wrapper: RefObject<HTMLElement | null>,
  frame: () => Promise<void>,
  still: () => boolean
): void {
  const store = useStoreApi();
  useEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    let last = { width: element.clientWidth, height: element.clientHeight };
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry?.contentRect ?? { width: 0, height: 0 };
      const changed = Math.abs(width - last.width) > 1 || Math.abs(height - last.height) > 1;
      last = { width, height };
      if (!changed || width === 0 || height === 0) return;
      const lost = store.getState().transform.some(n => !Number.isFinite(n));
      if (lost || still()) void frame();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [wrapper, frame, still, store]);
}
