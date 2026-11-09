import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { cn } from "./utils";

export const DialogRoot = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

/** A modal surface with nothing of its own in it, for what lays itself out, such as a search. */
export function DialogSurface({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px]" />
      <BaseDialog.Popup className={cn("fixed left-1/2 z-50 w-full -translate-x-1/2 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl", className)}>
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

/** A modal dialog. Control it with `open`/`onOpenChange` on `DialogRoot`. */
export function DialogContent({
  title,
  description,
  children,
  footer,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px]" />
      <BaseDialog.Popup
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border bg-popover text-popover-foreground shadow-2xl outline-none",
          className
        )}>
        <div className="flex items-start gap-3 border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <BaseDialog.Title className="text-base font-semibold">{title}</BaseDialog.Title>
            {description && (
              <BaseDialog.Description className="mt-0.5 text-sm text-muted-foreground">{description}</BaseDialog.Description>
            )}
          </div>
          <BaseDialog.Close render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
            <X />
          </BaseDialog.Close>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t px-5 py-3">{footer}</div>}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}
