// Presentational primitives with no behavior library behind them.

import type { ComponentProps, ReactNode } from "react";
import { cn } from "./utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cn("control focus-ring h-9 w-full px-3", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea data-slot="textarea" className={cn("control focus-ring block min-h-20 w-full resize-y p-2.5", className)} {...props} />
  );
}

/** A native select styled as a control; use `Select` for a custom popup. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <select data-slot="select" className={cn("control focus-ring h-8 px-2 text-xs", className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("block text-xs font-medium", className)} {...props} />;
}

export function Badge({
  className,
  tone = "neutral",
  ...props
}: ComponentProps<"span"> & { tone?: "neutral" | "success" | "warning" | "danger" | "primary" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium",
        tone === "neutral" && "text-muted-foreground",
        tone === "success" && "border-success/30 bg-success/10 text-success",
        tone === "warning" && "border-warning/30 bg-warning/10 text-warning",
        tone === "danger" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "primary" && "border-primary/30 bg-primary/10 text-primary",
        className
      )}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-2xs font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/[\s._@-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0]?.toUpperCase())
    .join("");
  return (
    <span
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary",
        className
      )}>
      {initials || "?"}
    </span>
  );
}

/** A removable chip, for lists of names and tags. */
export function Chip({
  children,
  onRemove,
  className,
}: {
  children: ReactNode;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 text-xs", className)}>
      {children}
      {onRemove && (
        <button type="button" aria-label="Remove" onClick={onRemove} className="rounded px-1 hover:bg-accent">
          ×
        </button>
      )}
    </span>
  );
}

/** A field: label, control, optional help and error. */
export function Field({
  label,
  help,
  error,
  required,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
      {help && <p className="text-2xs text-muted-foreground">{help}</p>}
      {error && <p className="text-2xs text-destructive">{error}</p>}
    </div>
  );
}
