// The line from the result on screen to where it came from: from its tab up to the output
// port of its operator on the canvas. It is drawn over the canvas and the results together,
// and follows the canvas as it is moved, zoomed or rearranged. While a card is open for
// editing its form is what is looked at, and lies over its neighbours: the line is not drawn.

import { useStoreApi } from "@xyflow/react";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useStore } from "zustand";
import type { CanvasView } from "../workflow/canvas-view";

interface Line {
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** The port is outside what the canvas shows: the line ends at the canvas's edge. */
  beyond: boolean;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const sameLine = (a: Line | null, b: Line | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.beyond === b.beyond &&
    a.from.x === b.from.x &&
    a.from.y === b.from.y &&
    a.to.x === b.to.x &&
    a.to.y === b.to.y);

/** Draws the line inside `container`, which holds the canvas and the results. Needs the canvas's ReactFlowProvider above. */
export function ResultConnector({ container, view }: { container: RefObject<HTMLElement | null>; view: CanvasView }) {
  const result = useStore(view, s => s.result);
  const editing = useStore(view, s => s.editing !== null);
  const [line, setLine] = useState<Line | null>(null);
  const flow = useStoreApi();
  const [beat, setBeat] = useState(0);

  const measure = useCallback(() => {
    // Only a line that moved is drawn again.
    const draw = (next: Line | null) => setLine(previous => (sameLine(previous, next) ? previous : next));
    const root = container.current;
    const separator = result?.lastIndexOf(":") ?? -1;
    if (!root || !result || separator < 0 || editing) return draw(null);
    const operator = result.slice(0, separator);
    const port = result.slice(separator + 1);
    const tab = root.querySelector(`[data-result-tab="${CSS.escape(result)}"]`);
    const handle = root.querySelector(
      `.react-flow__node[data-id="${CSS.escape(operator)}"] .react-flow__handle.source[data-handleid="${CSS.escape(port)}"]`
    );
    const canvas = root.querySelector("[data-workflow-canvas]");
    if (!tab || !handle || !canvas) return draw(null);
    const r = root.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    const h = handle.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    // The tab may be scrolled out of its strip: the line then starts at the strip's edge.
    const strip = tab.parentElement?.getBoundingClientRect() ?? t;
    const from = { x: clamp(t.left + t.width / 2, strip.left + 8, strip.right - 8) - r.left, y: t.top - r.top };
    const at = { x: h.left + h.width / 2, y: h.top + h.height / 2 };
    const inside = { x: clamp(at.x, c.left + 8, c.right - 8), y: clamp(at.y, c.top + 8, c.bottom - 8) };
    draw({ from, to: { x: inside.x - r.left, y: inside.y - r.top }, beyond: inside.x !== at.x || inside.y !== at.y });
  }, [container, result, editing]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again on every beat
  useLayoutEffect(measure, [measure, beat]);
  // A beat, once a frame at most, for whatever may have moved either end: the canvas is
  // panned or zoomed, a card is moved or grows, the results are resized, the tabs scroll.
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let frame = 0;
    const again = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setBeat(b => b + 1);
      });
    };
    const stopFlow = flow.subscribe(again);
    const observer = new ResizeObserver(again);
    observer.observe(root);
    for (const part of root.querySelectorAll("[data-workflow-canvas], [data-results]")) observer.observe(part);
    // The tabs scroll sideways in their strip; a result's tab arrives after its first page.
    root.addEventListener("scroll", again, true);
    const tabs = new MutationObserver(again);
    tabs.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-result-kind", "aria-selected"],
    });
    return () => {
      cancelAnimationFrame(frame);
      stopFlow();
      observer.disconnect();
      tabs.disconnect();
      root.removeEventListener("scroll", again, true);
    };
  }, [container, flow]);

  if (!line) return null;
  const { from, to, beyond } = line;
  // Up out of the tab and under the cards to a point beside the port, right of its card, then
  // round into the port from the side an arrow leaves it: the line lies on no card.
  const beside = { x: to.x + 30, y: to.y + 44 };
  const rise = Math.max(40, (from.y - beside.y) * 0.5);
  const d = beyond
    ? `M ${from.x} ${from.y} C ${from.x} ${from.y - rise}, ${to.x} ${to.y + rise}, ${to.x} ${to.y}`
    : `M ${from.x} ${from.y} C ${from.x} ${from.y - rise}, ${beside.x} ${beside.y + rise}, ${beside.x} ${beside.y} Q ${beside.x} ${to.y}, ${to.x + 6} ${to.y}`;
  return (
    <svg
      className="pointer-events-none absolute inset-0 z-20 size-full overflow-visible"
      aria-hidden
      data-result-connector={result ?? ""}
      data-connector-beyond={beyond}>
      <path d={d} fill="none" stroke="var(--background)" strokeWidth={5} strokeLinecap="round" opacity={0.9} />
      <path
        d={d}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={beyond ? "2 6" : undefined}
      />
      <circle cx={from.x} cy={from.y} r={3} fill="var(--primary)" />
      {!beyond && <circle cx={to.x} cy={to.y} r={5} fill="var(--primary)" stroke="var(--background)" strokeWidth={2} />}
    </svg>
  );
}
