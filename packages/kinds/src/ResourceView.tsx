import { useQuery } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { Skeleton } from "@texera/ui";
import { Suspense } from "react";
import { resourceQuery } from "./queries";
import { KINDS, isKindId } from "./registry";
import type { ResourceRef, ViewMode } from "./types";

/**
 * One component, three sizes: the kind's card, its side panel, or its full page. The
 * registry picks the code; the ref says what to show.
 */
export function ResourceView({ ref, mode }: { ref: ResourceRef; mode: ViewMode }) {
  const spec = KINDS[ref.kind];
  if (mode === "card") return <ResourceCard ref={ref} />;
  const View = spec.View;
  return (
    <Suspense fallback={<Skeleton className="m-4 h-64" />}>
      <View key={`${ref.kind}:${ref.rid}`} ref={ref} mode={mode} />
    </Suspense>
  );
}

/**
 * The card of a resource. With `resolveKind`, the ref's kind is only a guess (lineage
 * edges name versions, not kinds) and the envelope decides.
 */
export function ResourceCard({
  ref,
  resource,
  resolveKind = false,
}: {
  ref: ResourceRef;
  resource?: Resource;
  resolveKind?: boolean;
}) {
  const envelope = useQuery({ ...resourceQuery(ref.rid), enabled: resolveKind && !resource });
  const kindFromData = resource?.kind ?? envelope.data?.kind;
  const kind = resolveKind && kindFromData && isKindId(kindFromData) ? kindFromData : ref.kind;
  const Card = KINDS[kind].Card;
  if (resolveKind && !kindFromData) return <Skeleton className="h-16 w-full rounded-xl" />;
  return (
    <Suspense fallback={<Skeleton className="h-16 w-full rounded-xl" />}>
      <Card ref={{ ...ref, kind }} resource={resource ?? envelope.data} />
    </Suspense>
  );
}
