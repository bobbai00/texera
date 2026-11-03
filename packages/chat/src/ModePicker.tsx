import { useQuery } from "@tanstack/react-query";
import { agentTemplatesListOptions } from "@texera/catalog-client/query";
import type { AgentTemplate } from "@texera/catalog-client/types";
import { KindIcon } from "@texera/kinds";
import { EmptyState, ErrorNote, Skeleton, cn } from "@texera/ui";

/** The modes a chat can start in: every agent template the person can read. */
export function ModePicker({ value, onChange }: { value?: string; onChange: (template: AgentTemplate) => void }) {
  const { data, error, isPending } = useQuery({ ...agentTemplatesListOptions({ query: { limit: 100 } }), staleTime: 60_000 });
  if (error) return <ErrorNote error={error} prefix="Could not load the modes" />;
  if (isPending) return <Skeleton className="h-24" />;
  if (!data.items.length) return <EmptyState>No agent templates yet. Create one under Library → Agent templates.</EmptyState>;
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Mode" data-mode-picker>
      {data.items.map(t => {
        const on = t.metadata.rid === value;
        return (
          <button
            key={t.metadata.rid}
            type="button"
            role="radio"
            aria-checked={on}
            data-mode={t.metadata.rid}
            onClick={() => onChange(t)}
            className={cn(
              "flex items-start gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent",
              on && "border-primary ring-2 ring-primary/15"
            )}>
            <KindIcon kind="agent_template" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{t.spec.card.name || t.metadata.name}</span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{t.spec.card.description || t.metadata.description || "No description."}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
