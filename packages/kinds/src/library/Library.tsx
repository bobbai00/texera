import { useQuery } from "@tanstack/react-query";
import { executionsListOptions } from "@texera/catalog-client/query";
import { Badge, Button, EmptyState, Skeleton, timeAgo } from "@texera/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { searchQuery } from "../queries";
import { KINDS } from "../registry";
import { KindIcon } from "../shell/KindIcon";
import { NewResourceDialog } from "../shell/NewResourceDialog";
import { useOpenResource } from "../shell/navigation";
import type { KindId } from "../types";
import { ResourceTable } from "./ResourceTable";

/** The library page of one kind: everything of that kind the caller can read. */
export function Library({ kind, project }: { kind: KindId; project?: string }) {
  const spec = KINDS[kind];
  const [creating, setCreating] = useState(false);
  return (
    <div className="scrollbar-thin h-full overflow-y-auto" data-library={kind}>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-6 flex items-center gap-3">
          <KindIcon kind={kind} className="size-10" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">{spec.plural}</h1>
            <p className="text-sm text-muted-foreground">Everything you, your collaborators and your agents have made.</p>
          </div>
          {spec.create && (
            <Button onClick={() => setCreating(true)} data-new={kind}>
              <Plus /> New {spec.label.toLowerCase()}
            </Button>
          )}
        </header>
        {kind === "execution" ? <RunList /> : <KindList kind={kind} project={project} />}
      </div>
      {spec.create && <NewResourceDialog kind={kind} open={creating} onOpenChange={setCreating} project={project} />}
    </div>
  );
}

function KindList({ kind, project }: { kind: Exclude<KindId, "execution">; project?: string }) {
  const { data, isPending } = useQuery(searchQuery({ kind, project }));
  return <ResourceTable resources={data?.items} loading={isPending} />;
}

function RunList() {
  const { data, isPending, error } = useQuery(executionsListOptions({ query: { limit: 100 } }));
  const { expand } = useOpenResource();
  if (isPending) return <Skeleton className="h-40" />;
  if (error) return <EmptyState>Could not load runs.</EmptyState>;
  if (!data.items.length) return <EmptyState>No runs yet.</EmptyState>;
  return (
    <div className="divide-y overflow-hidden rounded-xl border bg-card" data-resource-table>
      {data.items.map(x => (
        <div key={x.eid} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50" data-resource-row="execution">
          <KindIcon kind="execution" />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => expand({ kind: "execution", rid: x.eid })}
              className="block truncate text-left text-sm font-medium hover:underline">
              {x.name || `Run ${x.eid.slice(0, 8)}`}
            </button>
            <div className="truncate text-xs text-muted-foreground">
              workflow {x.workflow.rid.slice(0, 8)} v{x.workflow.vno} · {x.results.length} result
              {x.results.length === 1 ? "" : "s"}
            </div>
          </div>
          <Badge tone={x.status === "completed" ? "success" : x.status === "failed" ? "danger" : "neutral"}>{x.status}</Badge>
          <span className="w-28 text-right text-xs text-muted-foreground">{timeAgo(x.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}
