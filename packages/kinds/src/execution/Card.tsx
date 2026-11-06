import { useQuery } from "@tanstack/react-query";
import { Badge } from "@texera/ui";
import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps } from "../types";
import { PhaseIcon } from "./PhaseIcon";
import { executionQuery } from "./queries";

/** An execution inside a chat message: how it ended, then what it produced. */
export default function ExecutionCard({ ref, resource }: KindCardProps) {
  const { summary } = useCardSummary(ref, resource);
  const { data: x } = useQuery(executionQuery(ref.rid));
  const phase = x?.status?.phase;
  const failed = x ? Object.values(x.status?.operators ?? {}).filter(o => o.error).length : 0;
  const error = x?.status?.error;
  return (
    <CardShell ref={x ? { ...ref, parent: x.metadata.parent } : ref} summary={summary}>
      {x && (
        <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
          <PhaseIcon phase={phase} />
          <span className="font-medium capitalize">{phase}</span>
          {!!failed && <Badge tone="danger">{failed} operator{failed === 1 ? "" : "s"} failed</Badge>}
          {error !== undefined && error !== null && <span className="min-w-0 truncate text-xs text-destructive">{String((error as { message?: string }).message ?? error)}</span>}
        </div>
      )}
    </CardShell>
  );
}
