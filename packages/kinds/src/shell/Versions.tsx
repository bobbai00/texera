import { useQuery } from "@tanstack/react-query";
import { Badge, EmptyState, ErrorNote, Skeleton, cn, timeAgo } from "@texera/ui";
import { GitCommitVertical, MessagesSquare } from "lucide-react";
import { versionsQuery } from "../queries";
import type { ResourceRef } from "../types";
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
  const { beside } = useOpenResource();
  if (error) return <ErrorNote error={error} prefix="Could not load versions" className="m-3" />;
  if (isPending) return <Skeleton className="m-3 h-24" />;
  if (!data.items.length) return <EmptyState>No versions yet.</EmptyState>;
  return (
    <ul className="divide-y" data-versions>
      {data.items.map(v => {
        const current = selected === v.vno || (selected === undefined && v.vno === head);
        return (
          <li key={v.vno}>
            <button
              type="button"
              onClick={() => onSelect?.(v.vno === head ? undefined : v.vno)}
              className={cn(
                "flex w-full items-start gap-3 px-3 py-2 text-left text-sm hover:bg-accent/60",
                current && "bg-accent/40"
              )}>
              <GitCommitVertical className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium">v{v.vno}</span>
                  {v.vno === head && <Badge tone="primary">head</Badge>}
                  <span className="text-xs text-muted-foreground">{timeAgo(v.createdAt)}</span>
                </span>
                {v.message && <span className="block truncate text-xs text-muted-foreground">{v.message}</span>}
                <span className="block truncate text-2xs text-muted-foreground">
                  by {v.createdBy.slice(0, 8)}
                  {v.onBehalfOf ? ` for ${v.onBehalfOf.slice(0, 8)}` : ""}
                </span>
              </span>
              {v.origin && (
                <span
                  role="link"
                  tabIndex={0}
                  onClick={e => {
                    e.stopPropagation();
                    if (v.origin) beside({ kind: "conversation", rid: v.origin.conversation });
                  }}
                  onKeyDown={e => {
                    if ((e.key === "Enter" || e.key === " ") && v.origin) {
                      e.preventDefault();
                      e.stopPropagation();
                      beside({ kind: "conversation", rid: v.origin.conversation });
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs text-muted-foreground hover:text-foreground"
                  title="From a chat">
                  <MessagesSquare className="size-3" /> chat
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export type { ResourceRef };
