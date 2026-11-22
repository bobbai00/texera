// How much the cards of a canvas say, and the room that takes. The places of operators are
// kept for cards that say their settings in one line. Cards that say every setting are
// taller, so while they do, the rows are drawn further apart by one factor for the whole
// canvas: nothing is moved in the workflow, and a card does not lie on the one below it.

import { Button, Segmented } from "@texera/ui";
import { CARD, ORIGIN, type Point, type Positions, ROW } from "@texera/workflow-model";
import { useStore as useFlowStore } from "@xyflow/react";
import { Cylinder, LayoutList, Link2, Rows3 } from "lucide-react";
import { useMemo } from "react";
import { useStore } from "zustand";
import type { CanvasView, Density } from "./canvas-view";

/** The least room between a card and the one under it. */
const GAP = 32;

/** How much further apart rows are drawn, from the tallest card on the canvas. */
export const rowSpread = (tallest: number) => Math.max(1, (tallest + GAP) / ROW);

/** Places as they are drawn while rows are `k` times further apart. */
export function spread<T extends Positions>(positions: T, k: number): T {
  if (k === 1) return positions;
  return Object.fromEntries(
    Object.entries(positions).map(([id, p]) => [id, { x: p.x, y: ORIGIN.y + (p.y - ORIGIN.y) * k }])
  ) as T;
}

/** The place kept for a card drawn at `at` while rows are `k` times further apart. */
export const unspread = (at: Point, k: number): Point =>
  k === 1 ? at : { x: at.x, y: ORIGIN.y + (at.y - ORIGIN.y) / k };

/**
 * The spread of the canvas this is on, from the cards as they are measured and the room `around`
 * them (what operators read stands above a card, what an execution kept under it); the card open
 * for editing lies over the others and is not counted.
 */
export function useRowSpread(editing: string | null, around: number): number {
  const tallest = useFlowStore(s => {
    let max = 0;
    for (const node of s.nodeLookup.values())
      if (node.id !== editing && node.type === "operator") max = Math.max(max, node.measured.height ?? 0);
    return max;
  });
  // In steps, so a pixel more or less on one card does not move the whole canvas.
  return Math.ceil(rowSpread(tallest + around) * 8) / 8;
}

/** How tall each card of the canvas this is on is drawn, as measured; a card not measured yet, as tall as a card is at least. */
export function useCardHeights(): (operatorID: string) => number {
  // One string, so the canvas is laid out again only when a card's height changes.
  const said = useFlowStore(s => {
    const heights: string[] = [];
    for (const node of s.nodeLookup.values())
      if (node.type === "operator") heights.push(`${node.id}=${Math.round(node.measured.height ?? 0)}`);
    return heights.join(",");
  });
  return useMemo(() => {
    const height = new Map(
      said
        .split(",")
        .filter(Boolean)
        .map(pair => {
          const at = pair.lastIndexOf("=");
          return [pair.slice(0, at), Number(pair.slice(at + 1))] as const;
        })
    );
    return (id: string) => height.get(id) || CARD.height;
  }, [said]);
}

/** The viewer's choice of how much every card says. */
export function DensityToggle({ view }: { view: CanvasView }) {
  const density = useStore(view, s => s.density);
  return (
    <Segmented<Density>
      label="How much each operator shows"
      value={density}
      onChange={view.getState().setDensity}
      options={[
        {
          value: "compact",
          label: (
            <>
              <Rows3 /> <span className="sr-only">Compact</span>
            </>
          ),
          title: "Each operator says its settings in one line",
        },
        {
          value: "detailed",
          label: (
            <>
              <LayoutList /> <span className="sr-only">Detailed</span>
            </>
          ),
          title: "Each operator lists every setting",
        },
      ]}
    />
  );
}

/** The viewer's choice of whether the datasets and models operators use are drawn. */
export function ResourcesToggle({ view }: { view: CanvasView }) {
  const shown = useStore(view, s => s.resources);
  const label = shown ? "Hide the data and models operators use" : "Show the data and models operators use";
  return (
    <Button
      variant={shown ? "secondary" : "outline"}
      size="icon-sm"
      className="shadow-xs"
      aria-label={label}
      aria-pressed={shown}
      title={label}
      onClick={() => view.getState().setResources(!shown)}
      data-canvas-resources={shown ? "shown" : "hidden"}>
      <Link2 />
    </Button>
  );
}

/** The viewer's choice of whether, while editing, the results of the execution on screen are drawn. */
export function ResultsToggle({ view }: { view: CanvasView }) {
  const shown = useStore(view, s => s.results);
  const label = shown ? "Hide the results of the execution" : "Show the results of the execution";
  return (
    <Button
      variant={shown ? "secondary" : "outline"}
      size="icon-sm"
      className="shadow-xs"
      aria-label={label}
      aria-pressed={shown}
      title={label}
      onClick={() => view.getState().setResults(!shown)}
      data-canvas-results={shown ? "shown" : "hidden"}>
      <Cylinder />
    </Button>
  );
}
