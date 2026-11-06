import type { ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { TooltipProvider } from "./tooltip";

/**
 * The signed-in layout: sidebar | page | side panel. The page is usually a chat; the
 * panel shows a resource opened from it, so the person works on the workflow without
 * leaving the conversation that made it.
 */
export function Shell({
  sidebar,
  rail,
  sidebarOpen,
  panel,
  children,
}: {
  sidebar: ReactNode;
  /** What stands in the sidebar's place while it is collapsed: a narrow column of its own, so nothing lies over the page. */
  rail: ReactNode;
  sidebarOpen: boolean;
  /** The side panel's content, or null when nothing is open. */
  panel: ReactNode | null;
  children: ReactNode;
}) {
  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full">
        <div className="shrink-0 border-r">{sidebarOpen ? sidebar : rail}</div>
        <main className="relative min-w-0 flex-1">
          <Group orientation="horizontal" className="h-full">
            <Panel id="page" minSize="30%">
              {children}
            </Panel>
            {panel !== null && (
              <>
                <Separator className="w-px bg-border transition-colors hover:bg-primary data-[separator=active]:bg-primary" />
                <Panel id="side" defaultSize="55%" minSize="25%">
                  {panel}
                </Panel>
              </>
            )}
          </Group>
        </main>
      </div>
    </TooltipProvider>
  );
}
