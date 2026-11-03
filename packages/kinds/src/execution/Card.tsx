import { useQuery } from "@tanstack/react-query";
import { Badge, formatDuration } from "@texera/ui";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { CardShell } from "../shell/CardShell";
import type { KindCardProps } from "../types";
import { executionQuery } from "./queries";

/** A run inside a chat message: how it ended, then what it produced. */
export default function ExecutionCard({ ref }: KindCardProps) {
  const { data: x } = useQuery(executionQuery(ref.rid));
  const failed = x && Object.values(x.operators).filter(o => o.error).length;
  return (
    <CardShell
      ref={ref}
      summary={
        x && {
          name: x.name || `Run ${x.eid.slice(0, 8)}`,
          facts: [`workflow v${x.workflow.vno}`, `${x.results.length} result${x.results.length === 1 ? "" : "s"}`, formatDuration(x.startedAt, x.finishedAt)].filter(Boolean),
        }
      }>
      {x && (
        <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
          {x.status === "completed" ? (
            <CheckCircle2 className="size-4 text-success" />
          ) : x.status === "failed" || x.status === "cancelled" ? (
            <XCircle className="size-4 text-destructive" />
          ) : (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
          <span className="font-medium capitalize">{x.status}</span>
          {!!failed && <Badge tone="danger">{failed} operator{failed === 1 ? "" : "s"} failed</Badge>}
          {x.error !== undefined && x.error !== null && (
            <span className="min-w-0 truncate text-xs text-destructive">{String((x.error as { message?: string }).message ?? x.error)}</span>
          )}
        </div>
      )}
    </CardShell>
  );
}
