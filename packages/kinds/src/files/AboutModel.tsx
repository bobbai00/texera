// What a model is: its card, the README its version carries, and what it reads and puts out.

import { useQuery } from "@tanstack/react-query";
import type { Attribute, Resource } from "@texera/catalog-client/types";
import { EmptyState, SectionTitle, Skeleton } from "@texera/ui";
import { lazy, Suspense } from "react";
import { fileApi, filesQuery } from "./api";

const Markdown = lazy(() => import("@texera/ui/markdown"));

const README_BYTES = 64 * 1024;

function Columns({ title, columns }: { title: string; columns: Attribute[] }) {
  return (
    <section className="space-y-1.5">
      <SectionTitle>{title}</SectionTitle>
      <ul className="flex flex-wrap gap-1.5">
        {columns.map(c => (
          <li key={c.attributeName} className="rounded-md border bg-card px-2 py-1 text-xs">
            {c.attributeName} <span className="text-muted-foreground">{c.attributeType}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AboutModel({ resource }: { resource: Resource }) {
  const rid = resource.metadata.rid;
  const vno = resource.metadata.head;
  const { data: manifest } = useQuery({ ...filesQuery("model", rid, vno), enabled: vno > 0 });
  const readme = manifest?.files.find(f => /^readme\.md$/i.test(f.path));
  const { data: card, isPending } = useQuery({
    queryKey: ["model-card", rid, vno],
    queryFn: () => fileApi("model").download(rid, vno, readme?.path ?? "", README_BYTES),
    enabled: readme !== undefined,
  });
  if (vno === 0) return <EmptyState>No version yet. Upload the model's files, then commit them as the first version.</EmptyState>;
  return (
    <div className="scrollbar-thin space-y-6 overflow-y-auto p-6">
      {readme && (isPending ? <Skeleton className="h-40" /> : (
        <Suspense fallback={<Skeleton className="h-40" />}>
          <div className="max-w-3xl text-sm" data-model-card>
            <Markdown text={card ?? ""} animating={false} />
          </div>
        </Suspense>
      ))}
      {manifest?.contract && (
        <div className="max-w-3xl space-y-4" data-model-contract>
          <Columns title="What it reads" columns={manifest.contract.inputs} />
          <Columns title="What it adds" columns={manifest.contract.outputs} />
        </div>
      )}
      {manifest && !readme && !manifest.contract && <EmptyState>This model has no card yet. Add a README.md to say what it is.</EmptyState>}
    </div>
  );
}
