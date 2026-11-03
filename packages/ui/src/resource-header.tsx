import { ChevronLeft, Maximize2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { cn } from "./utils";

/**
 * The header every panel and page shares: the kind's icon and label, the resource's
 * name and a meta line, kind actions, and for a panel the back/expand/close controls.
 */
export function ResourceHeader({
  icon,
  kindLabel,
  name,
  meta,
  actions,
  mode,
  onBack,
  onExpand,
  onClose,
  className,
}: {
  icon: ReactNode;
  kindLabel: string;
  name: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  mode: "panel" | "page";
  onBack?: () => void;
  onExpand?: () => void;
  onClose?: () => void;
  className?: string;
}) {
  return (
    <header className={cn("flex items-center gap-2 border-b px-3 py-2", className)} data-resource-header>
      {mode === "panel" && onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back">
          <ChevronLeft />
        </Button>
      )}
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">{kindLabel}</div>
        <div className="truncate text-sm font-semibold">{name}</div>
        {meta && <div className="truncate text-xs text-muted-foreground">{meta}</div>}
      </div>
      {actions}
      {mode === "panel" && onExpand && (
        <Tooltip content="Open full page">
          <Button variant="ghost" size="icon-sm" onClick={onExpand} aria-label="Open full page">
            <Maximize2 />
          </Button>
        </Tooltip>
      )}
      {mode === "panel" && onClose && (
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel">
          <X />
        </Button>
      )}
    </header>
  );
}
