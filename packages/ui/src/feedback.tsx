import { AlertTriangle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./utils";

export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("py-12 text-center text-sm text-muted-foreground", className)}>{children}</p>;
}

export function ErrorNote({ error, prefix, className }: { error: unknown; prefix?: string; className?: string }) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  return (
    <p className={cn("flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive", className)}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {prefix ? `${prefix}: ` : ""}
        {message}
      </span>
    </p>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-muted-foreground", className)} aria-label="Loading" />;
}

/** A section heading inside a panel or page. */
export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("text-xs font-medium tracking-wide text-muted-foreground uppercase", className)}>{children}</h2>;
}
