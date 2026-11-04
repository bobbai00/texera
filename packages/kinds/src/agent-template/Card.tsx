import type { AgentTemplateSpec } from "@texera/catalog-client/types";
import { CardShell, useCardSummary } from "../shell/CardShell";
import { UriChip } from "../shell/Chips";
import type { KindCardProps } from "../types";

export default function AgentTemplateCard({ ref, resource }: KindCardProps) {
  const { resource: r, summary } = useCardSummary(ref, resource);
  const spec = r?.spec as AgentTemplateSpec | undefined;
  return (
    <CardShell ref={ref} summary={summary}>
      {spec && (
        <div className="space-y-1.5 px-3 py-2.5 text-sm">
          <p className="text-muted-foreground">{spec.card.description || "No description."}</p>
          <div className="flex flex-wrap gap-1">{spec.model && <UriChip uri={spec.model} />}</div>
        </div>
      )}
    </CardShell>
  );
}
