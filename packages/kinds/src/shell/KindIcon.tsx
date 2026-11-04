import { cn } from "@texera/ui";
import { KINDS } from "../registry";
import type { KindId } from "../types";

export function KindIcon({ kind, className }: { kind: KindId; className?: string }) {
  const spec = KINDS[kind];
  const Icon = spec.icon;
  return (
    <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-lg", spec.accent, className)} data-kind-icon={kind}>
      <Icon className="size-4" />
    </span>
  );
}
