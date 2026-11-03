import { Toast } from "@base-ui/react/toast";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./utils";

/** Wrap the app once; then `useToast().add({ title, description, type })` anywhere. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map(toast => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className={cn(
        "rounded-xl border bg-popover p-3 text-sm text-popover-foreground shadow-lg",
        toast.type === "error" && "border-destructive/40"
      )}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Toast.Title className="font-medium" />
          <Toast.Description className="text-xs text-muted-foreground" />
        </div>
        <Toast.Close className="rounded p-0.5 hover:bg-accent" aria-label="Dismiss">
          <X className="size-3.5" />
        </Toast.Close>
      </div>
    </Toast.Root>
  ));
}

export const useToast = Toast.useToastManager;
