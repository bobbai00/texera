import { Outlet, useRouterState } from "@tanstack/react-router";
import { ChatDock } from "@texera/chat";
import { pageResource, panelRef, ResourceView } from "@texera/kinds";
import { Shell, useOpenPanel } from "@texera/ui";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { getAccessToken } from "@/auth/session";
import { PanelSync } from "./PanelSync";
import { Sidebar, SidebarRail } from "./Sidebar";

// The palette pulls in cmdk; load it the first time it is opened.
const CommandMenu = lazy(() => import("./CommandMenu").then(m => ({ default: m.CommandMenu })));

/** The signed-in layout: sidebar | page | the resource open beside it, and the agent over a resource's page. */
export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoaded, setSearchLoaded] = useState(false);
  const panel = useOpenPanel();
  const ref = panelRef(panel);
  // The resource the page shows, from its address: what the agent beside the page is told.
  const pathname = useRouterState({ select: s => s.location.pathname });
  const vno = useRouterState({ select: s => (s.location.search as { vno?: number }).vno });
  const page = useMemo(() => pageResource(pathname, vno), [pathname, vno]);

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

  const search = () => {
    setSearchLoaded(true);
    setSearchOpen(true);
  };
  return (
    <>
      <PanelSync />
      <Shell
        sidebar={<Sidebar onCollapse={() => setSidebarOpen(false)} onSearch={search} />}
        rail={<SidebarRail onExpand={() => setSidebarOpen(true)} onSearch={search} />}
        sidebarOpen={sidebarOpen}
        panel={
          ref ? (
            <section className="h-full min-w-0 bg-background" aria-label="Resource panel" data-side-panel={panel}>
              <ResourceView key={panel} ref={ref} mode="panel" />
            </section>
          ) : null
        }>
        <Outlet />
      </Shell>
      {page && <ChatDock page={page} getToken={getAccessToken} />}
      {searchLoaded && (
        <Suspense>
          <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} />
        </Suspense>
      )}
    </>
  );
}
