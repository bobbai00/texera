// What every graph in the app shares (a workflow's canvas, a lineage graph): how an arrow is
// drawn. The colours come from the theme (`--edge`, in the tokens).

import { MarkerType } from "@xyflow/react";

/** An arrow: a smooth curve from one card to the next, its head on the target. */
export const edgeOptions = {
  type: "default",
  markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: "var(--edge)" },
  style: { strokeWidth: 1.75 },
};
