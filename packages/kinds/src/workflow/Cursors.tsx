// The other people on a canvas: where each points and the card each has open. Each says it
// through the session's awareness, which is never saved and goes when they leave; a canvas
// says its own the same way.

import { cn } from "@texera/ui";
import type { Point } from "@texera/workflow-model";
import { ViewportPortal } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { type Present, presenceTone } from "../live/presence";
import { usePresence, useRoom } from "../live/room";

/** A person's colour, as every page shows it. */
export const toneOf = (pid: string) => `var(--presence-${presenceTone(pid) + 1})`;

const pointOf = (state: Record<string, unknown>): Point | undefined => {
  const at = state.cursor as Point | null | undefined;
  return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : undefined;
};

/**
 * The others on a workflow's canvas, and how this canvas tells them where it points (on the
 * canvas, or null when it leaves) and which card it has open.
 */
export function useCanvasPeople(rid: string, editing: string | null) {
  const room = useRoom(rid);
  const people = usePresence(rid);
  const others = useMemo(() => people.filter(p => !p.self), [people]);
  useEffect(() => {
    room?.awareness?.setLocalStateField("editing", editing);
  }, [room, editing]);
  // At most once a frame: a pointer moves faster than anyone needs to see it.
  const frame = useRef(0);
  const next = useRef<Point | null>(null);
  const point = useCallback(
    (at: Point | null) => {
      next.current = at;
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        room?.awareness?.setLocalStateField("cursor", next.current);
      });
    },
    [room]
  );
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  /** The person who has each card open, by operator. */
  const openBy = useMemo(() => {
    const open = new Map<string, Present>();
    for (const p of others) if (typeof p.state.editing === "string") open.set(p.state.editing, p);
    return open;
  }, [others]);
  return { others, openBy, point };
}

/** Where the others point, drawn on the canvas where they point, with their names. */
export function Cursors({ people }: { people: Present[] }) {
  return (
    <ViewportPortal>
      {people.map(p => {
        const at = pointOf(p.state);
        if (!at) return null;
        return (
          <div
            key={p.clientId}
            className="pointer-events-none absolute top-0 left-0 z-[1000] transition-transform duration-75"
            style={{ transform: `translate(${at.x}px, ${at.y}px)`, color: toneOf(p.pid) }}
            data-cursor={p.name}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M1 1 L15 7 L8 9 L5 15 Z" fill="currentColor" stroke="white" strokeWidth="1.2" />
            </svg>
            <span
              className={cn(
                "ml-3 inline-block rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-white"
              )}
              style={{ background: toneOf(p.pid) }}>
              {p.name}
            </span>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
