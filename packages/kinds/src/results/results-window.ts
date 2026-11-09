// Where the results of an execution sit over its canvas: a window held by its bottom left
// corner, moved by its title bar and sized by its top right corner, the corner that faces the
// canvas. It stays within the canvas, may be folded to its title bar, and is remembered in
// this browser, since where it goes depends on the screen.

export interface ResultsPlace {
  /** From the left and the bottom of the canvas to the window. */
  left: number;
  bottom: number;
  width: number;
  height: number;
  /** Folded to its title bar. */
  folded: boolean;
}

export const DEFAULT_PLACE: ResultsPlace = { left: 16, bottom: 16, width: 720, height: 320, folded: false };
const SMALLEST = { width: 360, height: 180 };
/** How tall the window is folded: its title bar. */
export const TITLE_HEIGHT = 44;
const MARGIN = 8;
import { keepHere, recalled } from "@texera/ui";

const KEY = "texera-results-window";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** The window as it fits the canvas: no smaller than it can be used, no larger than the canvas, all of it within. */
export function fitted(w: ResultsPlace, area: { width: number; height: number }): ResultsPlace {
  const width = Math.round(
    Math.max(Math.min(SMALLEST.width, area.width - 2 * MARGIN), Math.min(w.width, area.width - 2 * MARGIN))
  );
  const height = Math.round(
    Math.max(Math.min(SMALLEST.height, area.height - 2 * MARGIN), Math.min(w.height, area.height - 2 * MARGIN))
  );
  const tall = w.folded ? TITLE_HEIGHT : height;
  const left = Math.round(clamp(w.left, MARGIN, Math.max(MARGIN, area.width - width - MARGIN)));
  const bottom = Math.round(clamp(w.bottom, MARGIN, Math.max(MARGIN, area.height - tall - MARGIN)));
  return { left, bottom, width, height, folded: w.folded };
}

/** Moved by a pointer that went dx right and dy down: the window goes with it. */
export const moved = (w: ResultsPlace, dx: number, dy: number): ResultsPlace => ({
  ...w,
  left: w.left + dx,
  bottom: w.bottom - dy,
});

/** Its top right corner dragged dx right and dy down: the bottom left corner stays where it is. */
export const resized = (w: ResultsPlace, dx: number, dy: number): ResultsPlace => ({
  ...w,
  width: w.width + dx,
  height: w.height - dy,
});

export const remembered = (): ResultsPlace =>
  recalled(KEY, saved => {
    const place = saved as Partial<ResultsPlace> | null;
    return place && ["left", "bottom", "width", "height"].every(k => typeof place[k as keyof ResultsPlace] === "number")
      ? { ...DEFAULT_PLACE, ...place, folded: place.folded === true }
      : undefined;
  }) ?? DEFAULT_PLACE;

export const remember = (w: ResultsPlace | undefined): void => keepHere(KEY, w);
