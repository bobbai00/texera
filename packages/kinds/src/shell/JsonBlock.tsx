import { cn } from "@texera/ui";

/** Pretty-printed JSON for specs and raw content. */
export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn("scrollbar-thin overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-2xs leading-relaxed", className)}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
