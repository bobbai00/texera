import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@texera/ui";
import { normalizeSpec } from "@texera/workflow-model";
import { useEffect, useMemo } from "react";
import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps } from "../types";
import { openEditor } from "./editor";
import { versionSpecQuery } from "./queries";
import { WorkflowCanvas } from "./WorkflowCanvas";

/** A workflow inside a chat message or a list: a live picture of its graph. */
export default function WorkflowCard({ ref, resource }: KindCardProps) {
  const { resource: r, summary } = useCardSummary(ref, resource);
  const pinned = useQuery({ ...versionSpecQuery(ref.rid, ref.vno ?? 0), enabled: ref.vno !== undefined });
  const spec = useMemo(() => (ref.vno !== undefined ? pinned.data : r ? normalizeSpec(r.spec) : undefined), [ref.vno, pinned.data, r]);
  // A newer version arrived (an agent's edit): a workflow open beside the chat follows it.
  useEffect(() => {
    if (r && ref.vno === undefined) openEditor(ref.rid)?.getState().adopt(normalizeSpec(r.spec), r.metadata.head, r.metadata.name);
  }, [r, ref.rid, ref.vno]);
  return (
    <CardShell ref={ref} summary={summary}>
      <div className="h-56 bg-canvas">
        {spec ? (
          spec.operators.length > 0 ? (
            <WorkflowCanvas spec={spec} className="size-full" />
          ) : (
            <p className="flex size-full items-center justify-center text-sm text-muted-foreground">No operators yet</p>
          )
        ) : (
          <Skeleton className="size-full rounded-none" />
        )}
      </div>
    </CardShell>
  );
}
