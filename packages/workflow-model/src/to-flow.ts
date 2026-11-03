import type { Edge, Node } from "@xyflow/react";
import type { WorkflowContent } from "./types";

export type OperatorStatus = "running" | "completed" | "failed";

export interface OperatorNodeData extends Record<string, unknown> {
  operatorType: string;
  label: string;
  inputs: { id: string; label?: string }[];
  outputs: { id: string; label?: string }[];
  disabled?: boolean;
  /** Execution state from the latest run, if any. */
  status?: OperatorStatus;
  /** Rows the operator output in the latest run. */
  rows?: number;
  /** A compile error (bad property, missing input), shown on the node. */
  error?: string;
}

/** Per-operator facts the canvas shows on nodes: run state, output rows, compile errors. */
export interface OperatorOverlay {
  status?: OperatorStatus;
  rows?: number;
  error?: string;
}

export type OperatorNode = Node<OperatorNodeData, "operator">;

/** Maps the workflow JSON onto React Flow nodes and edges. Pure. */
export function toFlow(
  content: WorkflowContent,
  overlay: Record<string, OperatorOverlay> = {}
): { nodes: OperatorNode[]; edges: Edge[] } {
  const nodes: OperatorNode[] = content.operators.map(op => ({
    id: op.operatorID,
    type: "operator",
    position: content.operatorPositions[op.operatorID] ?? { x: 0, y: 0 },
    data: {
      operatorType: op.operatorType,
      label: op.customDisplayName ?? op.operatorType,
      inputs: op.inputPorts.map(p => ({ id: p.portID, label: p.displayName || undefined })),
      outputs: op.outputPorts.map(p => ({ id: p.portID, label: p.displayName || undefined })),
      disabled: op.isDisabled,
      ...overlay[op.operatorID],
    },
  }));
  const edges: Edge[] = content.links.map(l => ({
    id: l.linkID,
    source: l.source.operatorID,
    sourceHandle: l.source.portID,
    target: l.target.operatorID,
    targetHandle: l.target.portID,
  }));
  return { nodes, edges };
}

/** Engine operator states as node status. */
export const STATUS_OF: Record<string, OperatorStatus> = {
  Initializing: "running",
  Ready: "running",
  Running: "running",
  Pausing: "running",
  Paused: "running",
  Resuming: "running",
  Completed: "completed",
  Failed: "failed",
  Killed: "failed",
};
