import { useQuery } from "@tanstack/react-query";
import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps } from "../types";
import { templateQuery } from "./spec";

export default function AgentTemplateCard({ ref, resource }: KindCardProps) {
  const { summary } = useCardSummary(ref, resource);
  const { data } = useQuery(templateQuery(ref.rid));
  return (
    <CardShell ref={ref} summary={summary}>
      {data && (
        <div className="space-y-1 px-3 py-2.5 text-sm">
          <p className="text-muted-foreground">{data.spec.card.description || "No description."}</p>
          {!!data.spec.card.skills?.length && (
            <p className="text-xs text-muted-foreground">Skills: {data.spec.card.skills.map(s => s.name ?? s.id).join(", ")}</p>
          )}
        </div>
      )}
    </CardShell>
  );
}
