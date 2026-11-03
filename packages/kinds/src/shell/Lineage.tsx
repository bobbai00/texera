import { useQuery } from "@tanstack/react-query";
import type { VersionEdge } from "@texera/catalog-client/types";
import { EmptyState, ErrorNote, SectionTitle, Skeleton } from "@texera/ui";
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { lineageQuery } from "../queries";
import type { ResourceRef } from "../types";
import { ResourceCard } from "../ResourceView";

/** How an edge reads from the version on screen: upstream edges point at its sources. */
const EDGE_LABEL: Record<"from" | "to", Record<VersionEdge["kind"], string>> = {
  from: { derived: "derived from", read: "read", produced: "produced by" },
  to: { derived: "derived into", read: "read by", produced: "produced" },
};

/** What a version came from and what came out of it, as cards, so lineage is walkable. */
export function Lineage({ ref }: { ref: ResourceRef }) {
  const { data, error, isPending } = useQuery(lineageQuery(ref));
  if (error) return <ErrorNote error={error} prefix="Could not load lineage" className="m-3" />;
  if (isPending) return <Skeleton className="m-3 h-24" />;
  if (!data.upstream.length && !data.downstream.length)
    return <EmptyState>No lineage recorded for this version yet.</EmptyState>;
  return (
    <div className="space-y-4 p-3" data-lineage>
      <EdgeList title="Upstream" icon={<ArrowDownToLine className="size-3.5" />} edges={data.upstream} side="from" />
      <EdgeList title="Downstream" icon={<ArrowUpFromLine className="size-3.5" />} edges={data.downstream} side="to" />
    </div>
  );
}

function EdgeList({
  title,
  icon,
  edges,
  side,
}: {
  title: string;
  icon: React.ReactNode;
  edges: VersionEdge[];
  side: "from" | "to";
}) {
  if (!edges.length) return null;
  return (
    <section className="space-y-2">
      <SectionTitle className="flex items-center gap-1.5">
        {icon} {title}
      </SectionTitle>
      {edges.map(e => {
        const other = e[side];
        return (
          <div key={`${e.kind}:${other.rid}@${other.vno}:${e.execution ?? ""}`} className="space-y-1">
            <p className="text-2xs text-muted-foreground">
              {EDGE_LABEL[side][e.kind]}
              {e.execution ? ` · run ${e.execution.slice(0, 8)}` : ""}
            </p>
            <LineageCard rid={other.rid} vno={other.vno} />
          </div>
        );
      })}
    </section>
  );
}

function LineageCard({ rid, vno }: { rid: string; vno: number }) {
  // The edge names a version but not its kind; the card resolves the envelope to find it.
  return <ResourceCard ref={{ kind: "workflow", rid, vno }} resolveKind />;
}
