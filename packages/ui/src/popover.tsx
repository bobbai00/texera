import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./utils";

export const PopoverRoot = BasePopover.Root;

export function PopoverTrigger({ children }: { children: ReactElement }) {
  return <BasePopover.Trigger render={children} />;
}

export function PopoverContent({
  children,
  className,
  side = "bottom",
  align = "start",
}: {
  children: ReactNode;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={6} className="z-50">
        <BasePopover.Popup
          className={cn(
            "w-80 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none",
            className
          )}>
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
