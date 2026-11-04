import { useQuery } from "@tanstack/react-query";
import { Badge, EmptyState, ErrorNote, Skeleton, cn, timeAgo } from "@texera/ui";
import { GitCommitVertical } from "lucide-react";
import { versionsQuery } from "../queries";
import type { ResourceRef } from "../types";
import { OriginChip, PrincipalName } from "./Chips";
import { useOpenResource } from "./navigation";

/** The versions of a resource, newest first; picking one pins the view to it. */
export function Versions({
  rid,
  head,
  selected,
  onSelect,
}: {
  rid: string;
  head?: number;
  selected?: number;
  onSelect?: (vno: number | undefined) => void;
}) {
  const { data, error, isPending } = useQuery(versionsQuery(rid));
  if (error) return <ErrorNote error={error} prefix="Could not load versions" className="m-3" />;
  if (isPending) return <Skeleton className="m-3 h-24" />;
  if (!data.items.length) return <EmptyState>No versions yet.</EmptyState>;
  return (
    <ul className="divide-y" data-versions>
      {data.items.map(v => {
        const current = selected === v.vno || (selected === undefined && v.vno === head);
        return (
          <li key={v.vno} className={cn("flex items-start gap-3 px-3 py-2 text-sm", current && "bg-accent/40")}>
            <button
              type="button"
              onClick={() => onSelect?.(v.vno === head ? undefined : v.vno)}
              disabled={!onSelect}
              className="flex min-w-0 flex-1 items-start gap-3 text-left hover:text-foreground disabled:cursor-default">
              <GitCommitVertical className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium">v{v.vno}</span>
                  {v.vno === head && <Badge tone="primary">head</Badge>}
                  <span className="text-xs text-muted-foreground">{timeAgo(v.createdAt)}</span>
                </span>
                {v.message && <span className="block truncate text-xs text-muted-foreground">{v.message}</span>}
                <span className="block truncate text-2xs text-muted-foreground">
                  by <PrincipalName pid={v.createdBy} /> · <span className="font-mono">{v.digest.slice(7, 15)}</span>
                </span>
              </span>
            </button>
            {v.origin && <OriginChip origin={v.origin} />}
          </li>
        );
      })}
    </ul>
  );
}

export { useOpenResource, type ResourceRef };
