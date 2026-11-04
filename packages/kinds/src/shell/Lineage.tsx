import { useQuery } from "@tanstack/react-query";
import type { Edge } from "@texera/catalog-client/types";
import { EmptyState, ErrorNote, SectionTitle, Skeleton, timeAgo } from "@texera/ui";
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, Link2 } from "lucide-react";
import { dependentsQuery, lineageQuery } from "../queries";
import type { ResourceRef } from "../types";
import { baseUri, uriOf } from "../uri";
import { UriChip } from "./Chips";

/** How a relation reads, from the arrow's tail to its head. */
const RELATION: Record<Edge["relation"], string> = {
  references: "references",
  used: "read",
  produced: "produced",
  derivedFrom: "derived from",
  reused: "reused",
};

/**
 * Where a version came from and what came out of it, as the edge table has it: every
 * arrow upstream of the resource (toward its sources) and downstream (what used it),
 * plus the specs that reference it. Each end opens beside.
 */
export function Lineage({ ref }: { ref: ResourceRef }) {
  const up = useQuery(lineageQuery(ref, "upstream"));
  const down = useQuery(lineageQuery(ref, "downstream"));
  const dependents = useQuery(dependentsQuery(ref.rid));
  const error = up.error ?? down.error;
  if (error) return <ErrorNote error={error} prefix="Could not load lineage" className="m-3" />;
  if (!up.data || !down.data) return <Skeleton className="m-3 h-24" />;
  const root = baseUri(uriOf(ref));
  const upstream = up.data.edges;
  const downstream = down.data.edges.filter(e => !upstream.some(u => sameEdge(u, e)));
  const refs = (dependents.data ?? []).filter(e => e.relation === "references");
  if (!upstream.length && !downstream.length && !refs.length) return <EmptyState>No lineage recorded for this resource yet.</EmptyState>;
  return (
    <div className="space-y-4 p-3" data-lineage>
      <EdgeList title="Upstream" icon={<ArrowDownToLine className="size-3.5" />} edges={upstream} root={root} />
      <EdgeList title="Downstream" icon={<ArrowUpFromLine className="size-3.5" />} edges={downstream} root={root} />
      {refs.length > 0 && (
        <section className="space-y-2">
          <SectionTitle className="flex items-center gap-1.5">
            <Link2 className="size-3.5" /> Referenced by
          </SectionTitle>
          <ul className="space-y-1" data-dependents>
            {refs.map(e => (
              <li key={`${e.from}${e.field ?? ""}`} className="flex flex-wrap items-center gap-1.5 text-xs">
                <UriChip uri={e.from} emphasis />
                {e.field && <span className="font-mono text-2xs text-muted-foreground">{e.field}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const sameEdge = (a: Edge, b: Edge) => a.from === b.from && a.to === b.to && a.relation === b.relation;

function EdgeList({ title, icon, edges, root }: { title: string; icon: React.ReactNode; edges: Edge[]; root: string }) {
  if (!edges.length) return null;
  return (
    <section className="space-y-2">
      <SectionTitle className="flex items-center gap-1.5">
        {icon} {title}
      </SectionTitle>
      <ul className="space-y-1.5">
        {edges.map(e => (
          <li key={`${e.from}|${e.relation}|${e.to}|${e.execution ?? ""}`} className="flex flex-wrap items-center gap-1.5 text-xs" data-edge={e.relation}>
            <UriChip uri={e.from} emphasis={baseUri(e.from) === root} />
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <ArrowRight className="size-3" /> {RELATION[e.relation]} <ArrowRight className="size-3" />
            </span>
            <UriChip uri={e.to} emphasis={baseUri(e.to) === root} />
            <span className="text-2xs text-muted-foreground">{timeAgo(e.at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
