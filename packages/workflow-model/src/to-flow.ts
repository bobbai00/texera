import type { Edge, Node } from "@xyflow/react";
import type { Positions, WorkflowSpec } from "./types";

/** Where an operator stands in an execution. */
export type OperatorStatus = "waiting" | "running" | "paused" | "completed" | "failed";

/** What a card shows of an execution and of the compiler, per operator. */
export interface OperatorOverlay {
  /** The operator's state in the execution on screen, if any. */
  status?: OperatorStatus;
  /** Rows the operator has put out in that execution. */
  rows?: number;
  /** Why it failed, or what the compiler says is wrong with it. */
  error?: string;
  /** The output ports whose result the execution on screen holds. */
  results?: string[];
}

export interface OperatorNodeData extends Record<string, unknown>, OperatorOverlay {
  operatorType: string;
  label: string;
  inputs: { id: string; label?: string }[];
  outputs: { id: string; label?: string }[];
  /** The operator's settings, which its card says in words. */
  properties: Record<string, unknown>;
  disabled?: boolean;
  /** Its result is kept after an execution, to be read later. */
  keepsResult: boolean;
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
      properties: op.operatorProperties ?? {},
      disabled: op.isDisabled,
      keepsResult: op.viewResult === true,
      ...overlay[op.operatorID],
    },
  }));
  const edges: Edge[] = spec.links.map(l => ({
    id: l.linkID,
    source: l.source.operatorID,
    sourceHandle: l.source.portID,
    target: l.target.operatorID,
    targetHandle: l.target.portID,
    // Rows are on their way along the arrows out of an operator that is running.
    ...(overlay[l.source.operatorID]?.status === "running" ? { animated: true } : {}),
  }));
  return { nodes, edges };
}

/** The engine's operator states (as the catalog records them) as where an operator stands. */
export const STATUS_OF: Record<string, OperatorStatus> = {
  uninitialized: "waiting",
  initializing: "waiting",
  ready: "waiting",
  running: "running",
  pausing: "running",
  resuming: "running",
  paused: "paused",
  completed: "completed",
  failed: "failed",
  killed: "failed",
};

export const statusOf = (state: string | undefined): OperatorStatus | undefined =>
  state ? STATUS_OF[state.toLowerCase()] : undefined;
