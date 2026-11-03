import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@texera/ui";
import { useEffect } from "react";
import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps } from "../types";
import { openEditor } from "./editor";
import { contentQuery } from "./queries";
import { WorkflowCanvas } from "./WorkflowCanvas";

/** A workflow inside a chat message or a list: a live picture of its graph. */
export default function WorkflowCard({ ref, resource }: KindCardProps) {
  const { summary } = useCardSummary(ref, resource);
  const { data } = useQuery(contentQuery(ref.rid, ref.vno));
  const n = data?.content.operators.length;
  // A newer version arrived (an agent's edit): a workflow open beside the chat follows it.
  useEffect(() => {
    if (data && ref.vno === undefined) openEditor(ref.rid)?.getState().adopt(data.content, data.vno);
  }, [data, ref.rid, ref.vno]);
  return (
    <CardShell ref={ref} summary={summary && { ...summary, facts: [...(summary.facts ?? []), ...(n !== undefined ? [`${n} operator${n === 1 ? "" : "s"}`] : [])] }}>
      <div className="h-56 bg-canvas">
        {data ? (
          data.content.operators.length > 0 ? (
            <WorkflowCanvas content={data.content} className="size-full" />
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
