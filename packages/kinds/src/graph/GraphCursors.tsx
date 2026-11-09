// The others looking at a chat's graph: where each points, drawn where they point. Each says it
// through the chat's live session, as a thing on the graph and how far from its middle, in the
// drawing's type: people zoomed to different levels draw the same graph at different sizes.

import { useFramedField, usePresence } from "../live/room";
import { PointerMark, toneOf } from "../workflow/Cursors";
import type { Box } from "./layout";

/** Where someone points on the graph: a thing, and how far from its middle, in ems. */
interface GraphPoint {
  id: string;
  dx: number;
  dy: number;
}

const pointOf = (state: Record<string, unknown>): GraphPoint | undefined => {
  const at = state.graphCursor as GraphPoint | null | undefined;
  return at && typeof at.id === "string" && Number.isFinite(at.dx) && Number.isFinite(at.dy) ? at : undefined;
};

/** How this person says where they point on a chat's graph: at most once a frame; null when they leave it. */
export const useGraphPointer = (rid: string) => useFramedField<GraphPoint>(rid, "graphCursor");

/** The others' pointers, inside the graph's drawing. `k` is its zoom: a pointer stays one size. */
export function GraphCursors({
  rid,
  places,
  em,
  k,
}: {
  rid: string;
  places: Map<string, Box>;
  em: number;
  k: number;
}) {
  const people = usePresence(rid);
  return (
    <>
      {people.map(p => {
        if (p.self) return null;
        const at = pointOf(p.state);
        const b = at ? places.get(at.id) : undefined;
        if (!at || !b) return null;
        return (
          <div
            key={p.clientId}
            className="pointer-events-none absolute top-0 left-0 z-20 origin-top-left transition-transform duration-75"
            style={{
              transform: `translate(${b.x + b.w / 2 + at.dx * em}px, ${b.y + b.h / 2 + at.dy * em}px) scale(${1 / k})`,
              color: toneOf(p.pid),
            }}
            data-graph-cursor={p.name}>
            <PointerMark person={p} />
          </div>
        );
      })}
    </>
  );
}
