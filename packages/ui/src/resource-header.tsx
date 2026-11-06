import { ChevronLeft, Maximize2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { cn } from "./utils";

/**
 * The header every panel and page shares: the kind's icon, the resource's name and one line
 * about it, the kind's actions, and for a panel the back/expand/close controls.
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
    <header className={cn("flex items-center gap-2.5 border-b px-4 py-2.5", className)} data-resource-header>
      {mode === "panel" && onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back">
          <ChevronLeft />
        </Button>
      )}
      <span title={kindLabel} className="shrink-0">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("truncate font-semibold", mode === "page" ? "text-base" : "text-sm")}>{name}</div>
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
