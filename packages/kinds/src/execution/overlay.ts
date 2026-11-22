// An execution as a canvas shows it: what each operator's card says (its state, the rows it
// read and put out, why it failed), the results it kept, which of them the workflow on screen no
// longer puts out, and whether a result is a table or a picture.

import type { Attribute, ExecutionSpec, ExecutionStatus, PortSummary } from "@texera/catalog-client/types";
import { changedSince, type OperatorOverlay, statusOf, type WorkflowSpec } from "@texera/workflow-model";

const wordsOf = (error: unknown): string | undefined => {
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return JSON.stringify(error);
};

/** The execution a port's URI belongs to: texera://workflows/{w}/executions/{e}/operators/... */
const executionOfPort = (port: string) => port.split("/operators/")[0] ?? port;

/**
 * What each operator's card says of an execution: from its status, how each did; from its
 * spec, which read an earlier run's rows instead of running, and which did not run at all.
 */
export function executionOverlay(
  status: ExecutionStatus | undefined,
  spec?: Pick<ExecutionSpec, "reused" | "skipped">
): Record<string, OperatorOverlay> {
  const overlay: Record<string, OperatorOverlay> = {};
  for (const reused of spec?.reused ?? []) overlay[reused.operatorID] = { reusedFrom: executionOfPort(reused.from) };
  for (const id of spec?.skipped ?? []) overlay[id] = { skipped: true };
  for (const [id, operator] of Object.entries(status?.operators ?? {})) {
    const error = wordsOf(operator.error);
    overlay[id] = {
      ...overlay[id],
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
      overlay[port.operatorID] = {
        ...of,
        results: [
          ...(of.results ?? []),
          { port: port.portID, ...(port.rows !== undefined ? { rows: port.rows } : {}) },
        ],
      };
    }
  return overlay;
}

/**
 * An execution of another version, as the workflow on screen shows it: an operator that changed
 * since, or reads from one that did, says nothing of how it did then, and its results say the
 * version they are of. `ran` is the version the execution ran, `vno` its number.
 */
export function asOf(
  overlay: Record<string, OperatorOverlay>,
  ran: WorkflowSpec,
  vno: number,
  now: WorkflowSpec
): Record<string, OperatorOverlay> {
  const changed = changedSince(ran, now);
  return Object.fromEntries(
    Object.entries(overlay).map(([id, said]) =>
      changed.has(id) ? [id, said.results ? { results: said.results, stale: vno } : {}] : [id, said]
    )
  );
}

/**
 * Whether a port's result is kept: the catalog keeps a table for it in the execution's
 * warehouse. An execution of an earlier release may list a port the engine stored for its own
 * schedule; that is no result.
 */
export function keptResult(port: PortSummary): boolean {
  return port.table !== undefined && !port.table.startsWith("vfs:");
}

/** A result that is a picture: its one column is the page a visualization operator drew. */
export const isChart = (schema: Attribute[]) => schema.length === 1 && schema[0]?.attributeName === "html-content";
