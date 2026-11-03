import { useQuery } from "@tanstack/react-query";
import { ErrorNote, SectionTitle, Skeleton } from "@texera/ui";
import { ResourceTable } from "../library/ResourceTable";
import { searchQuery } from "../queries";
import { KINDS } from "../registry";
import { KindHeader } from "../shell/KindHeader";
import { metaLine } from "../shell/MetaLine";
import type { KindViewProps } from "../types";
import { projectQuery } from "./spec";

/** A project: everything inside it, grouped by kind. */
export default function ProjectView({ ref, mode }: KindViewProps) {
  const { data, error } = useQuery(projectQuery(ref.rid));
  const { data: members, isPending } = useQuery(searchQuery({ project: ref.rid, limit: 200 }));
  if (error) return <ErrorNote error={error} prefix="Could not open this project" className="m-4" />;
  if (!data) return <Skeleton className="m-4 h-64" />;
  const groups = new Map<string, NonNullable<typeof members>["items"]>();
  for (const r of members?.items ?? []) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-project-view={ref.rid}>
      <KindHeader ref={{ kind: "project", rid: ref.rid }} mode={mode} name={data.metadata.name} meta={metaLine(data.metadata)} />
      <div className="scrollbar-thin flex-1 space-y-6 overflow-y-auto p-4">
        {data.metadata.description && <p className="text-sm text-muted-foreground">{data.metadata.description}</p>}
        {isPending && <Skeleton className="h-32" />}
        {[...groups.entries()].map(([kind, items]) => (
          <section key={kind} className="space-y-2">
            <SectionTitle>{kind in KINDS ? KINDS[kind as keyof typeof KINDS].plural : kind}</SectionTitle>
            <ResourceTable resources={items} loading={false} />
          </section>
        ))}
        {members && members.items.length === 0 && <ResourceTable resources={[]} loading={false} />}
      </div>
    </div>
  );
}
