// What a model is: what it reads and what it adds, drawn, then the card its version carries
// (its README).

import { useQuery } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { EmptyState, SectionTitle, Skeleton } from "@texera/ui";
import { lazy, Suspense } from "react";
import { filesQuery, textQuery } from "./api";
import { ModelSignature } from "./ModelSignature";

const Markdown = lazy(() => import("@texera/ui/markdown"));

export function AboutModel({ resource }: { resource: Resource }) {
  const rid = resource.metadata.rid;
  const vno = resource.metadata.head;
  const { data: manifest } = useQuery({ ...filesQuery("model", rid, vno), enabled: vno > 0 });
  const readme = manifest?.files.find(f => /^readme\.md$/i.test(f.path));
  const { data: card, isPending } = useQuery({ ...textQuery("model", rid, vno, readme?.path ?? ""), enabled: readme !== undefined });
  if (vno === 0) return <EmptyState>No version yet. Upload the model's files, then commit them as the first version.</EmptyState>;
  if (!manifest) return <Skeleton className="m-6 h-56" />;
  return (
    <div className="scrollbar-thin space-y-8 overflow-y-auto p-6">
      {manifest.contract && (
        <section className="max-w-6xl space-y-3">
          <SectionTitle>What it reads and what it adds</SectionTitle>
          <ModelSignature name={resource.metadata.name} contract={manifest.contract} />
        </section>
      )}
      {readme &&
        (isPending ? (
          <Skeleton className="h-40 max-w-3xl" />
        ) : (
          <Suspense fallback={<Skeleton className="h-40 max-w-3xl" />}>
            <section className="max-w-3xl space-y-3">
              {manifest.contract && <SectionTitle>About this model</SectionTitle>}
              <div className="text-sm" data-model-card>
                <Markdown text={card?.text ?? ""} animating={false} whole />
              </div>
            </section>
          </Suspense>
        ))}
      {!readme && !manifest.contract && <EmptyState>This model has no card yet. Add a README.md to say what it is.</EmptyState>}
    </div>
  );
}
