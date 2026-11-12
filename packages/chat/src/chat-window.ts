// How the chat stands on its own page. Until it has a graph the chat is the page: there is nothing
// to stand beside. With one it is a window over the graph, below the page's bar, at the page's
// right or its left: sized by its edges and corners, moved by its header. Where it stands is a
// person's, and remembered in this browser from one chat to the next. What the window stands over
// keeps clear of it: it is told how much of which side the chat takes, which always leaves it
// room to be read. On a page too narrow for both, the chat lies over all of it, and minimizing the
// chat shows it. The person can give the chat the whole page: it has it while the graph under it
// says what it said then, and is a window again when the graph has something new to show.

import { keepHere, recalled } from "@texera/ui";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/** A side of the page. */
export type Side = "left" | "right";

/**
 * The chat's window: how wide it is, how far it stands from the page's bar and bottom, and the
 * side of the page it stands at, with how far from it.
 */
export interface ChatWindow {
  width: number;
  top: number;
  bottom: number;
  side: Side;
  away: number;
}

/** How much of each side of what the window stands over it takes. */
export interface Covered {
  left: number;
  right: number;
}
export const UNCOVERED: Covered = { left: 0, right: 0 };

/** The room the page gives: its size, and how much of its top its bar takes. */
export interface Room {
  width: number;
  height: number;
  bar: number;
}

/** A side of the window, or a corner: what a pointer takes hold of to size it. */
export type Edge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const EDGES: Edge[] = ["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"];

/** The least the window stands from the page's bar and edges, and the room its grip has beside it. */
const GAP = 12;
export const DEFAULT_WINDOW: ChatWindow = { width: 480, top: GAP, bottom: GAP, side: "right", away: GAP };
const SMALLEST = { width: 320, height: 280 };
/** The least what the chat stands over is left with. */
const BESIDE_SMALLEST = 380;

/** How far an arrow key moves the grip. */
const STEP = 24;
/** What in the header is itself for the pointer: taking hold of it does not move the window. */
const ITS_OWN = "button, a, input, textarea, select, [contenteditable='true'], [role='button']";

const KEY = "texera-chat-pane";

/** The widest the window can be, as far from its side of the page as it is. */
const widest = (room: Room, away: number) => room.width - BESIDE_SMALLEST - GAP - away;
/** The farthest the window can stand from its side of the page, as wide as it is. */
const farthest = (room: Room, width: number) => room.width - BESIDE_SMALLEST - GAP - width;
/** The room below the page's bar. */
const below = (room: Room) => room.height - room.bar;
const within = (n: number, least: number, most: number) => Math.round(Math.max(least, Math.min(n, most)));

/** The window as it fits the page; undefined when it and what it stands over do not both fit. */
export function fitted(w: ChatWindow, room: Room): ChatWindow | undefined {
  if (widest(room, GAP) < SMALLEST.width) return undefined;
  const away = within(w.away, GAP, room.width - BESIDE_SMALLEST - GAP - SMALLEST.width);
  const width = within(w.width, SMALLEST.width, widest(room, away));
  // A page too short for the smallest window gives it all it has.
  const top = within(w.top, GAP, Math.max(GAP, below(room) - GAP - SMALLEST.height));
  const bottom = within(w.bottom, GAP, Math.max(GAP, below(room) - top - SMALLEST.height));
  return { width, top, bottom, side: w.side, away };
}

const other = (side: Side): Side => (side === "left" ? "right" : "left");
/** The side of the window that faces what it stands over: its grip is there. */
export const inner = (w: ChatWindow): Side => other(w.side);
/** The same edge or corner of a window standing at the page's other side. */
const mirrored = (edge: Edge) => (edge.includes("left") ? edge.replace("left", "right") : edge.replace("right", "left")) as Edge;

/**
 * The window with an edge or a corner taken dx right and dy down: the sides it does not name stay
 * where they are, and the one it names stops where the window would be too small, leave the page,
 * or leave too little beside it.
 */
export function resized(w: ChatWindow, edge: Edge, dx: number, dy: number, room: Room): ChatWindow {
  // Worked out for a window at the page's right; one at its left is that window's mirror.
  const [e, x] = w.side === "right" ? [edge, dx] : [mirrored(edge), -dx];
  const next = { ...w };
  const height = below(room) - w.top - w.bottom;
  if (e.includes("left")) next.width = within(w.width - x, SMALLEST.width, Math.max(SMALLEST.width, widest(room, w.away)));
  if (e.includes("right")) {
    const by = Math.max(SMALLEST.width - w.width, Math.min(x, w.away - GAP));
    next.away = Math.round(w.away - by);
    next.width = Math.round(w.width + by);
  }
  if (e.includes("top")) next.top = Math.round(w.top + Math.max(GAP - w.top, Math.min(dy, height - SMALLEST.height)));
  if (e.includes("bottom")) next.bottom = Math.round(w.bottom - Math.max(SMALLEST.height - height, Math.min(dy, w.bottom - GAP)));
  return next;
}

/**
 * The window taken by its header dx right and dy down. It keeps its size and stays on the page,
 * below the bar; it stands at the side of the page it is nearer to, and no farther from it than
 * leaves what it stands over room on its other side.
 */
export function moved(w: ChatWindow, dx: number, dy: number, room: Room): ChatWindow {
  const fromLeft = (w.side === "left" ? w.away : room.width - w.away - w.width) + dx;
  const fromRight = room.width - w.width - fromLeft;
  const side: Side = fromRight <= fromLeft ? "right" : "left";
  const away = within(side === "right" ? fromRight : fromLeft, GAP, Math.max(GAP, farthest(room, w.width)));
  const down = Math.max(GAP - w.top, Math.min(dy, w.bottom - GAP));
  return { ...w, side, away, top: Math.round(w.top + down), bottom: Math.round(w.bottom - down) };
}

/** How much of its side of the page the window takes, its grip's room included. */
export const taken = (w: ChatWindow) => w.away + w.width + GAP;

/**
 * Whether the chat has the whole page: the person gave it the page, and what is under it shows
 * what it showed then. `under` says what is drawn there, in short; `took` is what it said when
 * the page was taken, undefined when it was not. A graph with something new to show has the page
 * back, and so has one the chat is opened with.
 */
export const hasThePage = (took: string | undefined, under: string | undefined) => under !== undefined && under === took;

const num = (v: unknown, otherwise: number) => (typeof v === "number" && Number.isFinite(v) ? v : otherwise);

const read = (): ChatWindow =>
  recalled(KEY, saved => {
    // What was kept before the window had four sides to size is a width alone; before it could
    // be moved, it stood from the page's right.
    const kept = saved as (Partial<ChatWindow> & { right?: number }) | null;
    if (!kept || typeof kept.width !== "number") return undefined;
    const d = DEFAULT_WINDOW;
    return {
      width: kept.width,
      top: num(kept.top, d.top),
      bottom: num(kept.bottom, d.bottom),
      side: kept.side === "left" ? "left" : "right",
      away: num(kept.away, num(kept.right, d.away)),
    };
  }) ?? DEFAULT_WINDOW;

const keep = (window: ChatWindow) => keepHere(KEY, window);

/**
 * The chat on its own page, beside its graph. `root` goes on what the chat and what it stands
 * over share, and a `data-page-bar` element in it is the page's bar, which the window stays
 * below. `box` is where the window stands in `root`, undefined when the two do not both fit;
 * `covered` is how much of which side of the page it takes; `edge` makes an element the handle
 * of one side or corner, and the handle of the side that faces the graph is the `grip` that the
 * keys move too; `header` makes the window's header what it is moved by. `under` is what the
 * graph under the chat draws, in short: when it changes, a chat that has the whole page gives it
 * back.
 */
export function useChatPane(enabled: boolean, under?: string) {
  const [pane, setPane] = useState(read);
  // What was under the chat when the person gave it the whole page.
  const [took, setTook] = useState<string>();
  const maximized = hasThePage(took, under);
  const root = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<Room>();
  useLayoutEffect(() => {
    const el = root.current;
    if (!enabled || !el) return;
    let bar: HTMLElement | null = null;
    const measure = () => {
      const next = { width: el.clientWidth, height: el.clientHeight, bar: bar?.isConnected ? bar.offsetHeight : 0 };
      setRoom(was => (was && was.width === next.width && was.height === next.height && was.bar === next.bar ? was : next));
    };
    const sizes = new ResizeObserver(measure);
    sizes.observe(el);
    // The bar comes and goes with what stands under the chat: the graph has one, the project none.
    const find = () => {
      const now = el.querySelector<HTMLElement>("[data-page-bar]");
      if (now !== bar) {
        if (bar) sizes.unobserve(bar);
        bar = now;
        if (bar) sizes.observe(bar);
      }
      measure();
    };
    find();
    const parts = new MutationObserver(find);
    parts.observe(el, { childList: true, subtree: true });
    return () => {
      sizes.disconnect();
      parts.disconnect();
    };
  }, [enabled]);
  const held = useRef<{ x: number; y: number; from: ChatWindow; edge: Edge } | null>(null);
  const carried = useRef<{ x: number; y: number; from: ChatWindow } | null>(null);
  const latest = useRef(pane);
  latest.current = pane;
  // Kept when the window is let go, not at every step of a drag.
  useEffect(() => {
    if (!held.current && !carried.current) keep(pane);
  }, [pane]);

  // Before the page is measured the window stands as it was left.
  const box = room === undefined ? pane : fitted(pane, room);
  const to = (next: ChatWindow) => {
    const fits = room === undefined ? undefined : fitted(next, room);
    if (fits !== undefined) setPane(fits);
  };
  const edge = (which: Edge) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || box === undefined) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      held.current = { x: e.clientX, y: e.clientY, from: box, edge: which };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const h = held.current;
      if (h && room) to(resized(h.from, h.edge, e.clientX - h.x, e.clientY - h.y, room));
    },
    onLostPointerCapture: () => {
      held.current = null;
      keep(latest.current);
    },
    // A double click on any side puts the window back as it first stood.
    onDoubleClick: () => to(DEFAULT_WINDOW),
  });
  const facing = inner(box ?? pane);
  const grip = {
    ...edge(facing),
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize the chat",
    "aria-valuenow": box?.width,
    "aria-valuemin": SMALLEST.width,
    "aria-valuemax": room === undefined || box === undefined ? undefined : widest(room, box.away),
    tabIndex: 0,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const step = e.key === "ArrowLeft" ? -STEP : e.key === "ArrowRight" ? STEP : 0;
      if (step === 0 || box === undefined || room === undefined) return;
      e.preventDefault();
      to(resized(box, facing, step, 0, room));
    },
  } as const;
  // The header moves the window, taken anywhere but by what it holds for the pointer itself.
  const header = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || box === undefined || (e.target as Element).closest(ITS_OWN)) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      carried.current = { x: e.clientX, y: e.clientY, from: box };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const c = carried.current;
      if (c && room) to(moved(c.from, e.clientX - c.x, e.clientY - c.y, room));
    },
    onLostPointerCapture: () => {
      carried.current = null;
      keep(latest.current);
    },
  };
  const setMaximized = useCallback((maximized: boolean) => setTook(maximized ? under : undefined), [under]);
  /** Where the window stands in `root`. */
  const place: Place | undefined = box && { top: (room?.bar ?? 0) + box.top, bottom: box.bottom, width: box.width, side: box.side, away: box.away };
  const [side, takes] = [box?.side, box ? taken(box) : 0];
  const covered = useMemo<Covered>(() => (side === undefined ? UNCOVERED : side === "right" ? { left: 0, right: takes } : { left: takes, right: 0 }), [side, takes]);
  return { root, maximized, setMaximized, box, place, covered, edge, grip, facing, header };
}

/** Where the window stands in what it shares with the graph: from the top, the bottom and its side. */
export interface Place {
  top: number;
  bottom: number;
  width: number;
  side: Side;
  away: number;
}

/** A place as a style: an element that stands there. */
export const placed = ({ top, bottom, width, side, away }: Place): CSSProperties => ({ top, bottom, width, [side]: away });

/**
 * Where a side's or a corner's handle lies around the window: a strip along the side, a square on
 * the corner, more outside the window than in it, so what is at the window's rim (a scrollbar, the
 * header's buttons) stays the window's. The handle of the side that faces the graph is the grip,
 * in the room the window keeps beside it.
 */
export function handlePlace(which: Edge, { top, bottom, width, side, away }: Place): CSSProperties {
  const [inside, outside, corner] = [2, 6, 14];
  const across = inside + outside;
  // Along the page, a handle is placed from the window's own side of it.
  const from = (n: number) => ({ [side]: n });
  if (which === other(side)) return { top: top + corner, bottom: bottom + corner, ...from(away + width), width: GAP };
  if (which === side) return { top: top + corner, bottom: bottom + corner, ...from(away - outside), width: across };
  if (which === "top") return { top: top - outside, ...from(away + corner), width: width - 2 * corner, height: across };
  if (which === "bottom") return { bottom: bottom - outside, ...from(away + corner), width: width - 2 * corner, height: across };
  return {
    ...(which.startsWith("top") ? { top: top - outside } : { bottom: bottom - outside }),
    ...from(which.endsWith(side) ? away - outside : away + width - (corner - outside)),
    width: corner,
    height: corner,
  };
}
