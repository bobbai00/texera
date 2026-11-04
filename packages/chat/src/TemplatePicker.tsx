import { useQuery } from "@tanstack/react-query";
import type { AgentTemplateSpec, Resource } from "@texera/catalog-client/types";
import { KindIcon, searchQuery } from "@texera/kinds";
import { EmptyState, ErrorNote, Skeleton, cn } from "@texera/ui";

/** The agent templates a chat can start with or switch to: every one the person can read. */
export function TemplatePicker({ value, onChange }: { value?: string; onChange: (template: Resource) => void }) {
  const { data, error, isPending } = useQuery({ ...searchQuery({ kind: "agent-template" }), staleTime: 60_000 });
  if (error) return <ErrorNote error={error} prefix="Could not load the agent templates" />;
  if (isPending) return <Skeleton className="h-24" />;
  if (!data.items.length) return <EmptyState>No agent templates yet. Create one under Agents → Agent templates.</EmptyState>;
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Agent template" data-template-picker>
      {data.items.map(t => {
        const spec = t.spec as unknown as AgentTemplateSpec;
        const on = t.metadata.uri === value;
        return (
          <button
            key={t.metadata.rid}
            type="button"
            role="radio"
            aria-checked={on}
            data-template={t.metadata.name}
            onClick={() => onChange(t)}
            className={cn("flex items-start gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent", on && "border-primary ring-2 ring-primary/15")}>
            <KindIcon kind="agent-template" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{spec.card?.name || t.metadata.name}</span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{spec.card?.description || t.metadata.description || "No description."}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
