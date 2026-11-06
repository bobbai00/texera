// Where the chat beside a page sits and how big it is: a window held by its bottom right corner,
// moved by its header and sized by its top left corner, the corner that faces the page. It is
// kept on screen, and remembered in this browser, since where it goes depends on the screen.

export interface DockWindow {
  /** From the right and the bottom of the screen to the window. */
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW: DockWindow = { right: 16, bottom: 16, width: 416, height: 640 };
const SMALLEST = { width: 320, height: 360 };
const MARGIN = 8;
const KEY = "texera-chat-window";

/** The window as it fits the screen: no smaller than it can be used, no larger than the screen, all of it on screen. */
export function fitted(w: DockWindow, screen: { width: number; height: number }): DockWindow {
  const width = Math.round(Math.max(SMALLEST.width, Math.min(w.width, screen.width - 2 * MARGIN)));
  const height = Math.round(Math.max(SMALLEST.height, Math.min(w.height, screen.height - 2 * MARGIN)));
  const right = Math.round(Math.max(MARGIN, Math.min(w.right, screen.width - width - MARGIN)));
  const bottom = Math.round(Math.max(MARGIN, Math.min(w.bottom, screen.height - height - MARGIN)));
  return { right, bottom, width, height };
}

/** Moved by a pointer that went dx right and dy down: the window goes with it. */
export const moved = (w: DockWindow, dx: number, dy: number): DockWindow => ({
  ...w,
  right: w.right - dx,
  bottom: w.bottom - dy,
});

/** Its top left corner dragged dx right and dy down: the bottom right corner stays where it is. */
export const resized = (w: DockWindow, dx: number, dy: number): DockWindow => ({
  ...w,
  width: w.width - dx,
  height: w.height - dy,
});

export function remembered(): DockWindow {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<DockWindow> | null;
    if (saved && ["right", "bottom", "width", "height"].every(k => typeof saved[k as keyof DockWindow] === "number"))
      return saved as DockWindow;
  } catch {
    /* nothing kept, or nothing readable */
  }
  return DEFAULT_WINDOW;
}

export function remember(w: DockWindow | undefined): void {
  try {
    if (w) localStorage.setItem(KEY, JSON.stringify(w));
    else localStorage.removeItem(KEY);
  } catch {
    /* kept for this page only */
  }
}
