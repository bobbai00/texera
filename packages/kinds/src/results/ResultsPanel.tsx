// The results of an execution, under the canvas of the workflow that ran. One tab per output
// port that holds a result, named after its operator; the tab on screen is the one the canvas
// points at (the operator's card is ringed and a line joins the tab to its port). A result is
// a table, or the picture a visualization operator drew.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Execution, PortSummary } from "@texera/catalog-client/types";
import { Button, cn, DataTable, EmptyState, ErrorNote, formatNumber, SandboxedFrame, Skeleton } from "@texera/ui";
import { BarChart3, ChevronLeft, ChevronRight, Table2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useStore } from "zustand";
import { defaultResult, isChart } from "../execution/overlay";
import { isLive, PAGE_SIZE, rowsQuery } from "../execution/queries";
import { type CanvasView, portKey } from "../workflow/canvas-view";

/**
 * A page of a port's rows. While the execution goes, a port fills, and its page follows the
 * rows it has reported so far. The first page also says what the result is: its columns, or
 * that it is a picture.
 */
const pageOf = (workflow: string, eid: string, port: PortSummary, page: number, live: boolean) => ({
  ...rowsQuery(workflow, eid, port.operatorID, port.portID, page, live ? (port.rows ?? 0) : undefined),
  placeholderData: keepPreviousData,
  retry: false,
});

export function ResultsPanel({
  execution,
  workflow,
  view,
  nameOf,
  trailing,
  className,
}: {
  execution: Execution;
  /** The workflow the execution is of. */
  workflow: string;
  view: CanvasView;
  /** An operator's name as its card says it. */
  nameOf: (operatorID: string) => string;
  /** What stands at the right of the tabs: the execution this is, a way to it. */
  trailing?: ReactNode;
  className?: string;
}) {
  const eid = execution.metadata.rid;
  const ports = execution.status?.resultsExpiredAt ? [] : (execution.status?.ports ?? []);
  const chosen = useStore(view, s => s.result);
  const fallback = defaultResult(ports);
  const active =
    ports.find(p => portKey(p.operatorID, p.portID) === chosen) ??
    ports.find(p => portKey(p.operatorID, p.portID) === fallback);
  // The canvas points at the result on screen, also when nobody chose it.
  useEffect(() => {
    const key = active ? portKey(active.operatorID, active.portID) : null;
    if (view.getState().result !== key) view.getState().show(key);
  }, [active, view]);
  const live = isLive(execution);

  return (
    <section className={cn("flex min-h-0 flex-col bg-background", className)} aria-label="Results" data-results={eid}>
      <div className="flex shrink-0 items-center gap-2 border-b pr-3">
        <div
          className="scrollbar-thin flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 py-1.5"
          role="tablist"
          aria-label="Results by operator">
          {ports.map(port => (
            <ResultTab
              key={portKey(port.operatorID, port.portID)}
              workflow={workflow}
              eid={eid}
              port={port}
              name={nameOf(port.operatorID)}
              active={port === active}
              live={live}
              onPick={() => view.getState().show(portKey(port.operatorID, port.portID))}
            />
          ))}
          {ports.length === 0 && (
            <span className="px-1.5 py-1 text-xs text-muted-foreground">
              {execution.status?.resultsExpiredAt
                ? "The results expired under the retention policy."
                : "No results yet."}
            </span>
          )}
        </div>
        {trailing}
      </div>
      {active ? (
        <PortResult
          key={portKey(active.operatorID, active.portID)}
          workflow={workflow}
          eid={eid}
          port={active}
          live={live}
        />
      ) : (
        <EmptyState className="py-8">Results show here as operators finish.</EmptyState>
      )}
    </section>
  );
}

function ResultTab({
  workflow,
  eid,
  port,
  name,
  active,
  live,
  onPick,
}: {
  workflow: string;
  eid: string;
  port: PortSummary;
  name: string;
  active: boolean;
  /** The execution still goes: only the result on screen is read, as it fills. */
  live: boolean;
  onPick: () => void;
}) {
  const { data } = useQuery({ ...pageOf(workflow, eid, port, 1, live), enabled: !live || active });
  const chart = data ? isChart(data.schema) : false;
  const Icon = chart ? BarChart3 : Table2;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onPick}
      data-port={portKey(port.operatorID, port.portID)}
      data-result-tab={portKey(port.operatorID, port.portID)}
      data-result-kind={data ? (chart ? "chart" : "table") : ""}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
      )}>
      <Icon className={cn("size-3.5", active && "text-primary")} />
      {name}
      {!port.portID.endsWith("-0") && <span className="font-normal opacity-70">{port.portID}</span>}
      {!chart && port.rows !== undefined && (
        <span className="font-normal tabular-nums opacity-70">{formatNumber(port.rows)}</span>
      )}
    </button>
  );
}

function PortResult({
  workflow,
  eid,
  port,
  live,
}: {
  workflow: string;
  eid: string;
  port: PortSummary;
  live: boolean;
}) {
  const [page, setPage] = useState(1);
  const { data, error, isPending } = useQuery(pageOf(workflow, eid, port, page, live));
  if (error) {
    if ((error as { status?: number }).status === 404)
      return (
        <EmptyState className="py-8">
          {live
            ? "Nothing to read yet."
            : // A result the catalog names no table for is the unit's own: gone once that unit restarted.
              'This result is no longer there: it was not kept, and the computing unit that held it has restarted. Turn on "Keep the result" on the operator and run again to read it later.'}
        </EmptyState>
      );
    return <ErrorNote error={error} prefix="Could not load the result" className="m-3" />;
  }
  if (isPending) return <Skeleton className="m-3 h-32" />;
  if (isChart(data.schema)) {
    const html = data.rows[0]?.[0];
    return (
      <div className="min-h-0 flex-1 p-3" data-port-chart>
        {typeof html === "string" && html ? (
          <SandboxedFrame html={html} title="Visualization" className="h-full min-h-64 border-0" />
        ) : (
          <EmptyState className="py-8">The visualization is empty.</EmptyState>
        )}
      </div>
    );
  }
  const total = data.total ?? port.rows ?? data.rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-port-rows>
      <DataTable
        columns={data.schema.map(a => ({ name: a.attributeName, type: a.attributeType }))}
        rows={data.rows}
        className="min-h-0 flex-1"
      />
      {/* Everything at the left: the right corner of a page is under the button of the chat beside it. */}
      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1 text-xs text-muted-foreground">
        <span>
          {formatNumber(total)} row{total === 1 ? "" : "s"}
        </span>
        {pages > 1 && (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <span className="tabular-nums">
              {page} / {pages}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
              aria-label="Next page">
              <ChevronRight />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
