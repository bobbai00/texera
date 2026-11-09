// The other people on a canvas: where each points and what each holds. Each says it through the
// session's awareness, which is never saved and goes when they leave; a canvas says its own the
// same way.

import type { Point } from "@texera/workflow-model";
import { ViewportPortal } from "@xyflow/react";
import { useMemo } from "react";
import type { Wanted } from "../live/holds";
import { type Present, presenceTone } from "../live/presence";
import { useFramedField, useHolds, usePresence } from "../live/room";

/** A person's colour, as every page shows it. */
export const toneOf = (pid: string) => `var(--presence-${presenceTone(pid) + 1})`;

const pointOf = (state: Record<string, unknown>): Point | undefined => {
  const at = state.cursor as Point | null | undefined;
  return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : undefined;
};

/**
 * The others on a workflow's canvas, what they hold, and how this canvas tells them where it
 * points (on the canvas, or null when it leaves). `wanted` is what this person would hold.
 */
export function useCanvasPeople(rid: string, wanted: Wanted | null) {
  const people = usePresence(rid);
  const others = useMemo(() => people.filter(p => !p.self), [people]);
  const holds = useHolds(rid, wanted);
  return { others, holds, point: useFramedField<Point>(rid, "cursor") };
}

/** Someone's pointer: the arrow, and their name, in their colour. */
export function PointerMark({ person }: { person: Present }) {
  return (
    <>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <path d="M1 1 L15 7 L8 9 L5 15 Z" fill="currentColor" stroke="white" strokeWidth="1.2" />
      </svg>
      <span
        className="ml-3 inline-block rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-white"
        style={{ background: toneOf(person.pid) }}>
        {person.name}
      </span>
    </>
  );
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
            <PointerMark person={p} />
          </div>
        );
      })}
    </ViewportPortal>
  );
}
