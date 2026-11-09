// How the chat stands on its own page, beside the graph or the project: how wide it is, and whether
// it has the whole page. Those are a person's, and remembered in this browser from one chat to the
// next. What lies beside it keeps room to be read: on a page too narrow for both, the chat lies
// over it, and minimizing the chat shows it.

import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export const CHAT_DEFAULT_WIDTH = 480;
const CHAT_SMALLEST = 320;
/** The least what stands beside the chat is given. */
const BESIDE_SMALLEST = 380;
/** The room around the chat where it stands beside something: the grip on its left, a margin on its right. */
const AROUND = 24;

/** How far an arrow key moves the grip. */
const STEP = 24;

const KEY = "texera-chat-pane";

/** How wide the chat stands in a page this wide; undefined when it and what is beside it do not both fit. */
export function widthIn(room: number, wanted: number): number | undefined {
  const most = room - BESIDE_SMALLEST - AROUND;
  return most < CHAT_SMALLEST ? undefined : Math.round(Math.max(CHAT_SMALLEST, Math.min(wanted, most)));
}

interface Pane {
  maximized: boolean;
  width: number;
}

function read(): Pane {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Pane> | null;
    if (saved && typeof saved.width === "number") return { maximized: saved.maximized === true, width: saved.width };
  } catch {
    /* nothing kept, or nothing readable */
  }
  return { maximized: false, width: CHAT_DEFAULT_WIDTH };
}

/**
 * The chat on its own page. `root` goes on what the chat and what stands beside it share; `width`
 * is undefined when they do not both fit; `grip` makes an element the handle that sizes the chat.
 */
export function useChatPane(enabled: boolean) {
  const [pane, setPane] = useState(read);
  const root = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number>();
  useLayoutEffect(() => {
    const el = root.current;
    if (!enabled || !el) return;
    const measure = () => setRoom(el.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [enabled]);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(pane));
    } catch {
      /* kept for this page only */
    }
  }, [pane]);

  const width = room === undefined ? pane.width : widthIn(room, pane.width);
  const ask = (wanted: number) => {
    const fits = room === undefined ? undefined : widthIn(room, wanted);
    if (fits !== undefined) setPane(p => ({ ...p, width: fits }));
  };
  const held = useRef<{ x: number; from: number } | null>(null);
  const grip = {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize the chat",
    "aria-valuenow": width,
    "aria-valuemin": CHAT_SMALLEST,
    "aria-valuemax": room === undefined ? undefined : room - BESIDE_SMALLEST - AROUND,
    tabIndex: 0,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || width === undefined) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      held.current = { x: e.clientX, from: width };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (held.current) ask(held.current.from + held.current.x - e.clientX);
    },
    onLostPointerCapture: () => {
      held.current = null;
    },
    onDoubleClick: () => ask(CHAT_DEFAULT_WIDTH),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const step = e.key === "ArrowLeft" ? STEP : e.key === "ArrowRight" ? -STEP : 0;
      if (step === 0 || width === undefined) return;
      e.preventDefault();
      ask(width + step);
    },
  } as const;
  const setMaximized = useCallback((maximized: boolean) => setPane(p => ({ ...p, maximized })), []);
  return { root, maximized: pane.maximized, setMaximized, width, grip };
}
