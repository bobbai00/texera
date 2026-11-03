import { useQuery } from "@tanstack/react-query";
import { Badge } from "@texera/ui";
import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps } from "../types";
import { mcpServerQuery } from "./spec";

export default function McpServerCard({ ref, resource }: KindCardProps) {
  const { summary } = useCardSummary(ref, resource);
  const { data } = useQuery(mcpServerQuery(ref.rid));
  return (
    <CardShell ref={ref} summary={summary}>
      {data && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-xs">
          <Badge>{data.spec.builtin ? "built-in" : data.spec.transport}</Badge>
          {data.spec.url && <code className="min-w-0 truncate text-muted-foreground">{data.spec.url}</code>}
          {data.status?.reachable !== undefined && (
            <Badge tone={data.status.reachable ? "success" : "danger"}>{data.status.reachable ? "reachable" : "unreachable"}</Badge>
          )}
        </div>
      )}
    </CardShell>
  );
}
