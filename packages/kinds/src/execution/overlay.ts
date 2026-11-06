// An execution as a canvas shows it: what each operator's card says (its state, the rows it
// read and put out, why it failed, which of its results are kept), which result is on screen
// when nobody chose one, and whether a result is a table or a picture.

import type { Attribute, ExecutionStatus, PortSummary } from "@texera/catalog-client/types";
import { type OperatorOverlay, statusOf } from "@texera/workflow-model";
import { portKey } from "../workflow/canvas-view";

const wordsOf = (error: unknown): string | undefined => {
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return JSON.stringify(error);
};

/** What each operator's card says of an execution. */
export function executionOverlay(status: ExecutionStatus | undefined): Record<string, OperatorOverlay> {
  const overlay: Record<string, OperatorOverlay> = {};
  for (const [id, operator] of Object.entries(status?.operators ?? {})) {
    const error = wordsOf(operator.error);
    overlay[id] = {
      status: statusOf(operator.state),
      ...(operator.rowsIn !== undefined ? { rowsIn: operator.rowsIn } : {}),
      ...(operator.rowsOut !== undefined ? { rowsOut: operator.rowsOut } : {}),
      ...(error ? { error } : {}),
    };
  }
  // The rows of an expired execution are gone; what its cards say of it stays.
  if (!status?.resultsExpiredAt)
    for (const port of (status?.ports ?? []).filter(keptResult)) {
      const of = overlay[port.operatorID] ?? {};
      overlay[port.operatorID] = { ...of, results: [...(of.results ?? []), port.portID] };
    }
  return overlay;
}

/**
 * Whether a port's result is kept: the catalog keeps a table for it in the execution's
 * warehouse. An execution of an earlier release may list a port the engine stored for its own
 * schedule; that is no result.
 */
export function keptResult(port: PortSummary): boolean {
  return port.table !== undefined && !port.table.startsWith("vfs:");
}

/** The result on screen when nobody chose one: the last one kept. */
export function defaultResult(ports: PortSummary[]): string | null {
  const port = ports.findLast(keptResult);
  return port ? portKey(port.operatorID, port.portID) : null;
}

/** A result that is a picture: its one column is the page a visualization operator drew. */
export const isChart = (schema: Attribute[]) => schema.length === 1 && schema[0]?.attributeName === "html-content";
