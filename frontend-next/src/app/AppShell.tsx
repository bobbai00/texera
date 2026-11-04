import { Outlet } from "@tanstack/react-router";
import { panelRef, ResourceView } from "@texera/kinds";
import { Shell, useOpenPanel } from "@texera/ui";
import { lazy, Suspense, useEffect, useState } from "react";
import { PanelSync } from "./PanelSync";
import { Sidebar } from "./Sidebar";

// The palette pulls in cmdk; load it the first time it is opened.
const CommandMenu = lazy(() => import("./CommandMenu").then(m => ({ default: m.CommandMenu })));

/** The signed-in layout: sidebar | page | the resource open beside it. */
export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoaded, setSearchLoaded] = useState(false);
  const panel = useOpenPanel();
  const ref = panelRef(panel);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchLoaded(true);
        setSearchOpen(o => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <PanelSync />
      <Shell
        sidebar={
          <Sidebar
            onCollapse={() => setSidebarOpen(false)}
            onSearch={() => {
              setSearchLoaded(true);
              setSearchOpen(true);
            }}
          />
        }
        sidebarOpen={sidebarOpen}
        onOpenSidebar={() => setSidebarOpen(true)}
        panel={
          ref ? (
            <section className="h-full min-w-0 bg-background" aria-label="Resource panel" data-panel={panel}>
              <ResourceView key={panel} ref={ref} mode="panel" />
            </section>
          ) : null
        }>
        <Outlet />
      </Shell>
      {searchLoaded && (
        <Suspense>
          <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} />
        </Suspense>
      )}
    </>
  );
}
