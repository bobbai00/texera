import { useQuery } from "@tanstack/react-query";
import { Button } from "@texera/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { searchAllQuery } from "../queries";
import { KINDS } from "../registry";
import { useScope, useWorkingProject } from "../scope";
import { KindIcon } from "../shell/KindIcon";
import { NewResourceDialog } from "../shell/NewResourceDialog";
import type { KindId } from "../types";
import { ResourceTable } from "./ResourceTable";

/**
 * The library page of one kind: what the working project holds and what it inherits, the
 * platform's built-ins. Something new goes into the working project.
 */
export function Library({ kind }: { kind: KindId }) {
  const spec = KINDS[kind];
  const scope = useScope();
  // The list waits for the working project: until it is known there is nothing to scope to.
  const known = useWorkingProject().current !== undefined;
  const [creating, setCreating] = useState(false);
  const { data, isPending } = useQuery({ ...searchAllQuery({ kind, scope }), enabled: known });
  return (
    <div className="scrollbar-thin h-full overflow-y-auto" data-library={kind}>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-6 flex items-center gap-3">
          <KindIcon kind={kind} className="size-10" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">{spec.plural}</h1>
            <p className="text-sm text-muted-foreground">{scope ? "What this project holds, and what is built in." : "Everything you can open, in every project."}</p>
          </div>
          {spec.defaultSpec && (
            <Button onClick={() => setCreating(true)} data-new={kind}>
              <Plus /> New {spec.label.toLowerCase()}
            </Button>
          )}
        </header>
        <ResourceTable resources={data?.items} loading={isPending} />
      </div>
      {spec.defaultSpec && <NewResourceDialog kind={kind} open={creating} onOpenChange={setCreating} />}
    </div>
  );
}
