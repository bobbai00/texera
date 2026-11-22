// What an execution kept of a workflow's operators, as a canvas draws it: each result is a small
// cylinder under the card it came out of, joined to its port by a dashed line, as the data an
// operator reads stands above it. And which results are no longer what the workflow on screen
// would put out: the operator, or one it reads from, changed since the version that ran. Pure,
// so it is tested on its own.

import type { Edge, Node } from "@xyflow/react";
import { CARD } from "./layout";
import type { OperatorOverlay } from "./to-flow";
import type { Positions, WorkflowLink, WorkflowOperator, WorkflowSpec } from "./types";

/** A result's cylinder on a canvas, and the room between it and the card above it. */
export const RESULT_CHIP = { width: 116, height: 30, gap: 22 };

export interface ResultNodeData extends Record<string, unknown> {
  operatorID: string;
  port: string;
  /** The port's name, when the operator has more than one output. */
  label?: string;
  /** The rows the execution kept of it. */
  rows?: number;
  /** The version the result is of, when the operator or one it reads from changed since. */
  stale?: number;
}

export type ResultNode = Node<ResultNodeData, "result">;

/** The handle on a result's cylinder that the dashed line from its port ends at. */
export const RESULT_HANDLE = "port";

/** How far below a card its results reach, on a canvas where some operator has one. */
export const resultRoom = (overlay: Record<string, OperatorOverlay> | undefined): number =>
  Object.values(overlay ?? {}).some(o => (o.results?.length ?? 0) > 0) ? RESULT_CHIP.height + RESULT_CHIP.gap : 0;

/**
 * The cylinders of the results the overlay holds and their lines, each under the right edge of
 * its card, where its port is; a card with several results has them side by side, leftwards.
 * `heightOf` is how tall a card is drawn.
 */
export function resultLayer(
  spec: WorkflowSpec,
  positions: Positions,
  overlay: Record<string, OperatorOverlay> | undefined,
  heightOf: (operatorID: string) => number
): { nodes: ResultNode[]; edges: Edge[] } {
  const nodes: ResultNode[] = [];
  const edges: Edge[] = [];
  const { width, gap } = RESULT_CHIP;
  for (const op of spec.operators) {
    const at = positions[op.operatorID];
    const said = overlay?.[op.operatorID];
    if (!at || !said?.results?.length) continue;
    const several = (op.outputPorts?.length ?? 0) > 1;
    said.results.forEach((result, i) => {
      const id = `result:${op.operatorID}:${result.port}`;
      const label = several
        ? op.outputPorts?.find(p => p.portID === result.port)?.displayName || result.port
        : undefined;
      nodes.push({
        id,
        type: "result",
        position: { x: at.x + CARD.width - width / 2 - i * (width + 8), y: at.y + heightOf(op.operatorID) + gap },
        draggable: false,
        selectable: false,
        connectable: false,
        data: {
          operatorID: op.operatorID,
          port: result.port,
          ...(label ? { label } : {}),
          ...(result.rows !== undefined ? { rows: result.rows } : {}),
          ...(said.stale !== undefined ? { stale: said.stale } : {}),
        },
      });
      edges.push({
        id: `${id}:line`,
        source: op.operatorID,
        sourceHandle: result.port,
        target: id,
        targetHandle: RESULT_HANDLE,
        selectable: false,
        focusable: false,
        deletable: false,
        markerEnd: undefined,
        style: { strokeWidth: 1.25, strokeDasharray: "4 4" },
      });
    });
  }
  return { nodes, edges };
}

/** A value written the same way whatever the order of its keys. */
function settled(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(settled).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(k => `${JSON.stringify(k)}:${settled((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** What an operator does to its rows: its type, its settings and whether it is turned off. */
const work = (op: WorkflowOperator) =>
  `${op.operatorType}|${op.isDisabled === true}|${settled(op.operatorProperties ?? {})}`;

/** What an operator reads, port by port. */
const reads = (links: WorkflowLink[], operatorID: string) =>
  links
    .filter(l => l.target.operatorID === operatorID)
    .map(l => `${l.source.operatorID}:${l.source.portID}>${l.target.portID}`)
    .sort()
    .join(",");

/**
 * The operators of `now` whose result an execution of `ran` does not hold: one `ran` has not,
 * one whose work or inputs differ, and one that reads, however far back, from such an operator.
 * A name or where a card stands changes no result.
 */
export function changedSince(ran: WorkflowSpec, now: WorkflowSpec): Set<string> {
  const before = new Map(ran.operators.map(op => [op.operatorID, op]));
  const operators = new Map(now.operators.map(op => [op.operatorID, op]));
  const changed = new Map<string, boolean>();
  const visit = (id: string): boolean => {
    const known = changed.get(id);
    if (known !== undefined) return known;
    // A loop, which a workflow never has, would otherwise not end: counted as changed.
    changed.set(id, true);
    const op = operators.get(id);
    const was = before.get(id);
    const differs =
      !op ||
      !was ||
      work(op) !== work(was) ||
      reads(now.links, id) !== reads(ran.links, id) ||
      now.links.some(l => l.target.operatorID === id && visit(l.source.operatorID));
    changed.set(id, differs);
    return differs;
  };
  return new Set(now.operators.map(op => op.operatorID).filter(visit));
}
