import { useQuery } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { Button, cn, Skeleton, Tooltip } from "@texera/ui";
import { Maximize2, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { executionSummaryQuery, resourceQuery } from "../queries";
import { KINDS } from "../registry";
import type { ResourceRef } from "../types";
import { KindIcon } from "./KindIcon";
import { useOpenResource } from "./navigation";

/** What a card header needs to show, for resources and for runs alike. */
export interface CardSummary {
  name: string;
  facts?: string[];
}

/** Loads the summary of a reference: the envelope for resources, the execution for runs. */
export function useCardSummary(ref: ResourceRef, given?: Resource): { summary?: CardSummary; error?: unknown } {
  const spec = KINDS[ref.kind];
  const isRun = ref.kind === "execution";
  const resource = useQuery({ ...resourceQuery(ref.rid), enabled: !given && !isRun });
  const run = useQuery({ ...executionSummaryQuery(ref.rid), enabled: isRun });
  if (isRun) {
    if (!run.data) return { error: run.error };
    return { summary: { name: run.data.name || "Run", facts: [run.data.status] } };
  }
  const r = given ?? resource.data;
  if (!r) return { error: resource.error };
  return { summary: { name: r.metadata.name, facts: spec.facts?.(r) } };
}

/**
 * The frame every card shares: kind, name, open-beside and expand, facts. Kind-specific
 * content goes in `children`.
 */
export function CardShell({
  ref,
  summary,
  children,
  actions,
  className,
}: {
  ref: ResourceRef;
  summary?: CardSummary;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const spec = KINDS[ref.kind];
  const { beside, expand } = useOpenResource();
  return (
    <div
      data-resource-card={ref.kind}
      data-rid={ref.rid}
      className={cn("not-prose overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs", className)}>
      <div className="flex items-center gap-3 border-b px-3 py-2.5">
        <KindIcon kind={ref.kind} />
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            {spec.label}
            {ref.vno !== undefined && <span className="ml-1 normal-case">v{ref.vno}</span>}
          </div>
          {summary ? <div className="truncate text-sm font-semibold">{summary.name}</div> : <Skeleton className="mt-1 h-4 w-40" />}
        </div>
        {actions}
        <Tooltip content="Open beside">
          <Button variant="ghost" size="icon-sm" onClick={() => beside(ref)} aria-label="Open beside">
            <PanelRight />
          </Button>
        </Tooltip>
        <Tooltip content="Open full page">
          <Button variant="ghost" size="icon-sm" onClick={() => expand(ref)} aria-label="Open full page">
            <Maximize2 />
          </Button>
        </Tooltip>
      </div>
      {children}
      {!!summary?.facts?.length && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
          {summary.facts.map(f => (
            <span key={f}>{f}</span>
          ))}
        </div>
      )}
    </div>
  );
}
