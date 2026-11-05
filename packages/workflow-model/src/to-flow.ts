import type { Edge, Node } from "@xyflow/react";
import type { Positions, WorkflowSpec } from "./types";

export type OperatorStatus = "running" | "completed" | "failed";

export interface OperatorNodeData extends Record<string, unknown> {
  operatorType: string;
  label: string;
  inputs: { id: string; label?: string }[];
  outputs: { id: string; label?: string }[];
  disabled?: boolean;
  /** The operator's state in the latest execution, if any. */
  status?: OperatorStatus;
  /** Rows the operator output in the latest execution. */
  rows?: number;
  /** A compile error (bad property, missing input), shown on the node. */
  error?: string;
}

/** Per-operator facts the canvas shows on nodes: execution state, output rows, compile errors. */
export interface OperatorOverlay {
  status?: OperatorStatus;
  rows?: number;
  error?: string;
}

export type OperatorNode = Node<OperatorNodeData, "operator">;

/** The label of an operator on the canvas: its custom name, else its type (a custom operator by its short name). */
export const operatorLabel = (op: { operatorType: string; customDisplayName?: string }) =>
  op.customDisplayName || (op.operatorType.startsWith("texera://") ? "Custom operator" : op.operatorType);

/** Maps the spec onto React Flow nodes and edges. Pure. */
export function toFlow(
  spec: WorkflowSpec,
  positions: Positions,
  overlay: Record<string, OperatorOverlay> = {}
): { nodes: OperatorNode[]; edges: Edge[] } {
  const nodes: OperatorNode[] = spec.operators.map(op => ({
    id: op.operatorID,
    type: "operator",
    position: positions[op.operatorID] ?? { x: 0, y: 0 },
    data: {
      operatorType: op.operatorType,
      label: operatorLabel(op),
      inputs: (op.inputPorts ?? []).map(p => ({ id: p.portID, label: p.displayName || undefined })),
      outputs: (op.outputPorts ?? []).map(p => ({ id: p.portID, label: p.displayName || undefined })),
      disabled: op.isDisabled,
      ...overlay[op.operatorID],
    },
  }));
  const edges: Edge[] = spec.links.map(l => ({
    id: l.linkID,
    source: l.source.operatorID,
    sourceHandle: l.source.portID,
    target: l.target.operatorID,
    targetHandle: l.target.portID,
  }));
  return { nodes, edges };
}

/** Engine operator states (as the catalog records them) as node status. */
export const STATUS_OF: Record<string, OperatorStatus> = {
  initializing: "running",
  ready: "running",
  running: "running",
  pausing: "running",
  paused: "running",
  resuming: "running",
  completed: "completed",
  failed: "failed",
  killed: "failed",
};

export const statusOf = (state: string | undefined): OperatorStatus | undefined =>
  state ? STATUS_OF[state.toLowerCase()] : undefined;
