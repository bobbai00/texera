import { useQuery } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { Button } from "@texera/ui";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { searchAllQuery } from "../queries";
import { KINDS } from "../registry";
import { useScope, useWorkingProject } from "../scope";
import { KindIcon } from "../shell/KindIcon";
import { NewResourceDialog } from "../shell/NewResourceDialog";
import type { KindId } from "../types";
import { operatorsOf } from "./describe";
import { ResourceTable } from "./ResourceTable";

/** Operators are many: the project's own first, what is built in behind one click. */
function Operators({ resources, loading, project }: { resources: Resource[] | undefined; loading: boolean; project?: string }) {
  const { own, builtIn } = operatorsOf(resources ?? [], project);
  const [open, setOpen] = useState(false);
  if (loading || own.length === 0) return <ResourceTable resources={resources} loading={loading} />;
  return (
    <div className="space-y-4">
      <ResourceTable resources={own} loading={false} />
      {builtIn.length > 0 && (
        <>
          <Button variant="outline" size="sm" onClick={() => setOpen(!open)} aria-expanded={open} data-built-in-operators={builtIn.length}>
            {open ? <ChevronDown /> : <ChevronRight />} {builtIn.length} built-in operators
          </Button>
          {open && <ResourceTable resources={builtIn} loading={false} />}
        </>
      )}
    </div>
  );
}

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
        {kind === "operator" ? <Operators resources={data?.items} loading={isPending} project={scope} /> : <ResourceTable resources={data?.items} loading={isPending} />}
      </div>
      {spec.defaultSpec && <NewResourceDialog kind={kind} open={creating} onOpenChange={setCreating} />}
    </div>
  );
}
