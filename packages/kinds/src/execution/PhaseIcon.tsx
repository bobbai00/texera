import type { ExecutionStatus } from "@texera/catalog-client/types";
import { cn } from "@texera/ui";
import { CheckCircle2, Loader2, PauseCircle, XCircle } from "lucide-react";

/** How an execution stands, as an icon: completed, failed or cancelled, paused, or still going. */
export function PhaseIcon({ phase, className }: { phase: ExecutionStatus["phase"] | undefined; className?: string }) {
  const ended = phase === "failed" || phase === "cancelled";
  const Icon = phase === "completed" ? CheckCircle2 : ended ? XCircle : phase === "paused" ? PauseCircle : Loader2;
  const tone = phase === "completed" ? "text-success" : ended ? "text-destructive" : "text-muted-foreground";
  return (
    <Icon
      className={cn("size-4 shrink-0", tone, Icon === Loader2 && "animate-spin", className)}
      aria-label={phase ?? "pending"}
    />
  );
}
