// Menus wrap Base UI, so keyboard handling, focus management and ARIA come from a
// maintained library rather than this codebase.

import { Menu } from "@base-ui/react/menu";
import { Check } from "lucide-react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "./utils";

export const DropdownMenu = Menu.Root;

export function DropdownMenuTrigger({ children }: { children: ReactElement }) {
  return <Menu.Trigger render={children} />;
}

export function DropdownMenuContent({
  className,
  children,
  side = "bottom",
  align = "start",
}: {
  className?: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
  return (
    <Menu.Portal>
      <Menu.Positioner side={side} align={align} sideOffset={6} className="z-50">
        <Menu.Popup
          className={cn(
            "min-w-48 overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg outline-none",
            className
          )}>
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return (
    <Menu.Item
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}>{children}</div>;
}

export function DropdownMenuSeparator() {
  return <Menu.Separator className="-mx-1 my-1 h-px bg-border" />;
}

/** An item that is on or off; the menu stays open while items are switched. */
export function DropdownMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem
      closeOnClick={false}
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50",
        className
      )}
      {...props}>
      <span className="flex size-4 items-center justify-center rounded border">
        <Menu.CheckboxItemIndicator>
          <Check className="size-3" />
        </Menu.CheckboxItemIndicator>
      </span>
      {children}
    </Menu.CheckboxItem>
  );
}
