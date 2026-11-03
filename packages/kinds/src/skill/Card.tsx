import { useQuery } from "@tanstack/react-query";
import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps } from "../types";
import { skillQuery } from "./spec";

export default function SkillCard({ ref, resource }: KindCardProps) {
  const { summary } = useCardSummary(ref, resource);
  const { data } = useQuery(skillQuery(ref.rid));
  return (
    <CardShell ref={ref} summary={summary}>
      {data && <p className="px-3 py-2.5 text-sm text-muted-foreground">{data.spec.description || "No description."}</p>}
    </CardShell>
  );
}
