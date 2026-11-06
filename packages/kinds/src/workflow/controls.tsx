// The buttons at the corner of a canvas: zoom in, zoom out, bring the workflow into view, and
// for a workflow too large to see at once, a map of it. The map lies over the canvas, so it
// is there only when the viewer opens it, and never on a canvas with little room.

import { cn } from "@texera/ui";
import { ControlButton, Controls, MiniMap, useStore as useFlowStore } from "@xyflow/react";
import { Map as MapIcon } from "lucide-react";
import { useStore } from "zustand";
import type { CanvasView } from "./canvas-view";

/** From this many operators on a workflow is rarely seen whole, and a map helps to move about it. */
const MAP_FROM = 12;
/** The least room a canvas needs for a map to leave enough of it free. */
const ROOM = { width: 640, height: 420 };

export function CanvasControls({ view }: { view: CanvasView }) {
  const open = useStore(view, s => s.map);
  const offered = useFlowStore(s => s.nodeLookup.size >= MAP_FROM && s.width >= ROOM.width && s.height >= ROOM.height);
  return (
    <>
      <Controls showInteractive={false} className="!rounded-lg !border !shadow-none">
        {offered && (
          <ControlButton
            onClick={() => view.getState().setMap(!open)}
            aria-pressed={open}
            aria-label={open ? "Hide the map" : "Show a map of the workflow"}
            title={open ? "Hide the map" : "Show a map of the workflow"}
            data-canvas-map>
            {/* The other buttons' icons are filled shapes; this one is drawn in lines. */}
            <MapIcon className={cn("!max-h-3.5 !max-w-3.5 !fill-none", open && "text-primary")} />
          </ControlButton>
        )}
      </Controls>
      {offered && open && (
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          // Beside the buttons, not over them.
          className="!ml-14 !rounded-lg !border"
          style={{ width: 176, height: 112 }}
          bgColor="var(--card)"
          maskColor="color-mix(in oklch, var(--muted-foreground) 16%, transparent)"
          nodeColor="var(--edge)"
          nodeStrokeWidth={0}
          nodeBorderRadius={8}
        />
      )}
    </>
  );
}
