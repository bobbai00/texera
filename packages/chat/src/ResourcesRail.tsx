import { useQuery } from "@tanstack/react-query";
import { conversationsResourcesOptions } from "@texera/catalog-client/query";
import { isKindId, KindIcon, KINDS, type ResourceRef, useOpenResource } from "@texera/kinds";
import { SectionTitle, cn } from "@texera/ui";
import { useMemo } from "react";

/** The resources this chat produced or touched: the catalog's record plus what the current run streamed. */
export function ResourcesRail({ rid, live, className }: { rid: string; live: ResourceRef[]; className?: string }) {
  const { data } = useQuery({ ...conversationsResourcesOptions({ path: { rid } }), staleTime: 10_000 });
  const { beside } = useOpenResource();
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: { ref: ResourceRef; name: string }[] = [];
    for (const r of data ?? []) {
      if (!isKindId(r.kind)) continue;
      const ref = { kind: r.kind, rid: r.metadata.rid };
      seen.add(`${ref.kind}:${ref.rid}`);
      out.push({ ref, name: r.metadata.name });
    }
    for (const ref of live) {
      const key = `${ref.kind}:${ref.rid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref, name: `${KINDS[ref.kind].label} ${ref.rid.slice(0, 8)}` });
    }
    return out;
  }, [data, live]);
  if (!items.length) return null;
  return (
    <aside className={cn("space-y-2", className)} aria-label="Resources from this chat" data-resources-rail>
      <SectionTitle>From this chat</SectionTitle>
      <ul className="space-y-1">
        {items.map(({ ref, name }) => (
          <li key={`${ref.kind}:${ref.rid}`}>
            <button
              type="button"
              onClick={() => beside(ref)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent"
              data-rail-item={ref.kind}>
              <KindIcon kind={ref.kind} className="size-6 [&_svg]:size-3.5" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
