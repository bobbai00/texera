// One result of an execution, as the results window shows it: a page of a port's rows in a
// table, or the picture a visualization operator drew.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { PortSummary } from "@texera/catalog-client/types";
import { Button, DataTable, EmptyState, ErrorNote, formatNumber, SandboxedFrame, Skeleton } from "@texera/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { isChart } from "../execution/overlay";
import { PAGE_SIZE, rowsQuery } from "../execution/queries";

/**
 * A page of a port's rows. While the execution goes, a port fills, and its page follows the
 * rows it has reported so far. The first page also says what the result is: its columns, or
 * that it is a picture.
 */
export const pageOf = (workflow: string, eid: string, port: PortSummary, page: number, live: boolean) => ({
  ...rowsQuery(workflow, eid, port.operatorID, port.portID, page, live ? (port.rows ?? 0) : undefined),
  placeholderData: keepPreviousData,
  retry: false,
});

export function PortResult({
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
    if (live && (error as { status?: number }).status === 404)
      return <EmptyState className="py-8">Nothing to read yet.</EmptyState>;
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
