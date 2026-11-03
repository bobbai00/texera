import { useQuery } from "@tanstack/react-query";
import { Badge } from "@texera/ui";
import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps } from "../types";
import { phaseTone, unitQuery } from "./View";

export default function ComputingUnitCard({ ref, resource }: KindCardProps) {
  const { summary } = useCardSummary(ref, resource);
  const { data } = useQuery(unitQuery(ref.rid));
  return (
    <CardShell ref={ref} summary={summary}>
      {data && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-xs">
          <Badge>{data.spec.unitKind}</Badge>
          {data.status && <Badge tone={phaseTone(data.status.phase)}>{data.status.phase}</Badge>}
          {data.status?.nodes && <span className="text-muted-foreground">{data.status.nodes.length} node{data.status.nodes.length === 1 ? "" : "s"}</span>}
        </div>
      )}
    </CardShell>
  );
}
