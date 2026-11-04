import { useQuery } from "@tanstack/react-query";
import { Button } from "@texera/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { searchQuery } from "../queries";
import { KINDS } from "../registry";
import { KindIcon } from "../shell/KindIcon";
import { NewResourceDialog } from "../shell/NewResourceDialog";
import type { KindId } from "../types";
import { ResourceTable } from "./ResourceTable";

/** The library page of one kind: everything of that kind the caller can read. */
export function Library({ kind, project }: { kind: KindId; project?: string }) {
  const spec = KINDS[kind];
  const [creating, setCreating] = useState(false);
  const { data, isPending } = useQuery(searchQuery({ kind, project }));
  return (
    <div className="scrollbar-thin h-full overflow-y-auto" data-library={kind}>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-6 flex items-center gap-3">
          <KindIcon kind={kind} className="size-10" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">{spec.plural}</h1>
            <p className="text-sm text-muted-foreground">Everything you, your collaborators and your agents have made.</p>
          </div>
          {spec.defaultSpec && (
            <Button onClick={() => setCreating(true)} data-new={kind}>
              <Plus /> New {spec.label.toLowerCase()}
            </Button>
          )}
        </header>
        <ResourceTable resources={data?.items} loading={isPending} />
      </div>
      {spec.defaultSpec && <NewResourceDialog kind={kind} open={creating} onOpenChange={setCreating} parent={project} />}
    </div>
  );
}
