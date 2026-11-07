import { useQuery } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { Badge, EmptyState, Skeleton, timeAgo } from "@texera/ui";
import { KINDS, isKindId } from "../registry";
import { projectsQuery, useScope } from "../scope";
import { OriginChip, PrincipalName } from "../shell/Chips";
import { KindIcon } from "../shell/KindIcon";
import { useOpenResource } from "../shell/navigation";

/**
 * The library list. Identical for every kind: the point of one envelope. What the project in view
 * inherits says which project it comes from.
 */
export function ResourceTable({ resources, loading, empty = "Nothing here yet. Ask for one in a chat, or create one." }: { resources: Resource[] | undefined; loading: boolean; empty?: string }) {
  const { expand } = useOpenResource();
  const scope = useScope();
  const { data: projects } = useQuery(projectsQuery());
  const inherited = (r: Resource) =>
    r.kind !== "project" && scope !== undefined && r.metadata.project !== scope ? projects?.items.find(p => p.metadata.rid === r.metadata.project)?.metadata.name : undefined;
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    );
  }
  if (!resources?.length) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="divide-y overflow-hidden rounded-xl border bg-card" data-resource-table>
      {resources.map(r => {
        const kind = isKindId(r.kind) ? r.kind : "workflow";
        const ref = { kind, rid: r.metadata.rid, parent: r.metadata.parent };
        const facts = KINDS[kind].facts?.(r) ?? [];
        return (
          <div key={r.metadata.rid} data-resource-row={r.kind} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50">
            <KindIcon kind={kind} />
            <div className="min-w-0 flex-1">
              <button type="button" onClick={() => expand(ref)} className="block max-w-full truncate text-left text-sm font-medium hover:underline">
                {r.metadata.name}
              </button>
              <div className="truncate text-xs text-muted-foreground">
                {[r.metadata.description, ...facts].filter(Boolean).join(" · ")}
              </div>
            </div>
            {r.metadata.origin && <OriginChip origin={r.metadata.origin} className="hidden md:inline-flex" />}
            {inherited(r) && (
              <Badge className="hidden sm:inline-flex" data-inherited-from={inherited(r)}>
                from {inherited(r)}
              </Badge>
            )}
            <PrincipalName pid={r.metadata.owner} className="hidden w-24 truncate text-right text-xs text-muted-foreground sm:block" />
            <span className="w-28 text-right text-xs text-muted-foreground">{timeAgo(r.metadata.updatedAt)}</span>
          </div>
        );
      })}
    </div>
  );
}
