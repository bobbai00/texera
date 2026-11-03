import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps } from "../types";

export default function ProjectCard({ ref, resource }: KindCardProps) {
  const { summary } = useCardSummary(ref, resource);
  return <CardShell ref={ref} summary={summary} />;
}
