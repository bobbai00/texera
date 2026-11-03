import { useQuery } from "@tanstack/react-query";
import { Chip } from "@texera/ui";
import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps } from "../types";
import { environmentQuery } from "./spec";

export default function EnvironmentCard({ ref, resource }: KindCardProps) {
  const { summary } = useCardSummary(ref, resource);
  const { data } = useQuery(environmentQuery(ref.rid));
  const packages = data?.spec.python?.packages ?? [];
  return (
    <CardShell ref={ref} summary={summary}>
      {data && (
        <div className="flex flex-wrap gap-1.5 px-3 py-2.5">
          {packages.length === 0 && <span className="text-xs text-muted-foreground">No packages beyond the base image.</span>}
          {packages.slice(0, 8).map(p => (
            <Chip key={p}>{p}</Chip>
          ))}
          {packages.length > 8 && <span className="text-xs text-muted-foreground">and {packages.length - 8} more</span>}
        </div>
      )}
    </CardShell>
  );
}
