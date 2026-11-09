import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ALL_PROJECTS, KINDS, LIBRARY_GROUPS, pluralOf, searchQuery, useLook, useWorkingProject } from "@texera/kinds";
import {
  Avatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Kbd,
  Select,
  Skeleton,
  Tooltip,
  toggleTheme,
} from "@texera/ui";
import { ChevronRight, LogOut, MoonStar, PanelLeftClose, PanelLeftOpen, Search, SquarePen, Users } from "lucide-react";
import { useState } from "react";
import { signOut, useSession } from "@/auth/session";

/** The sidebar collapsed: a narrow column with the way back, a new chat and the search. */
export function SidebarRail({ onExpand, onSearch }: { onExpand: () => void; onSearch: () => void }) {
  const look = useLook();
  return (
    <nav
      className="flex h-full w-12 flex-col items-center gap-1 bg-sidebar py-3"
      aria-label="Main, collapsed"
      data-sidebar-rail>
      <Link to="/" aria-label={look.name} className="mb-1">
        {look.logoUrl && <img src={look.logoUrl} alt="" className="size-7" />}
      </Link>
      <Tooltip content="Expand sidebar" side="right">
        <Button variant="ghost" size="icon-sm" onClick={onExpand} aria-label="Expand sidebar">
          <PanelLeftOpen />
        </Button>
      </Tooltip>
      <Tooltip content="New chat" side="right">
        <Button variant="ghost" size="icon-sm" render={<Link to="/" />} aria-label="New chat">
          <SquarePen />
        </Button>
      </Tooltip>
      <Tooltip content="Search" side="right">
        <Button variant="ghost" size="icon-sm" onClick={onSearch} aria-label="Search">
          <Search />
        </Button>
      </Tooltip>
    </nav>
  );
}

export function Sidebar({ onCollapse, onSearch }: { onCollapse: () => void; onSearch: () => void }) {
  const user = useSession();
  const navigate = useNavigate();
  // The project the person works in: the lists show it, and what is made goes into it. The app
  // wears its look.
  const working = useWorkingProject();
  const look = useLook();
  const { data: chats, isPending } = useQuery({
    ...searchQuery({
      kind: "conversation",
      limit: 50,
      ...(working.current === ALL_PROJECTS ? {} : { project: working.current }),
    }),
    staleTime: 15_000,
    enabled: working.current !== undefined,
  });

  return (
    <nav className="flex h-full w-64 flex-col bg-sidebar" aria-label="Main">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <Link
          to="/"
          className="flex min-w-0 items-center gap-2 px-1 text-[15px] font-semibold tracking-tight"
          data-look={look.name}>
          {look.logoUrl && <img src={look.logoUrl} alt="" className="size-7 shrink-0 rounded" />}
          <span className="truncate">{look.name}</span>
        </Link>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label="Collapse sidebar">
          <PanelLeftClose />
        </Button>
      </div>

      <div className="px-3 pb-2">
        <Select
          aria-label="Project"
          value={working.current ?? null}
          onChange={project => void working.pick(project).catch(() => undefined)}
          options={working.choices}
          placeholder="Project"
          className="w-full"
        />
      </div>

      <div className="space-y-0.5 px-2">
        <Button variant="ghost" className="w-full justify-start px-2" render={<Link to="/" />} data-new-chat-link>
          <SquarePen /> New chat
        </Button>
        <Button variant="ghost" className="w-full justify-start px-2 text-muted-foreground" onClick={onSearch}>
          <Search /> Search
          <Kbd className="ml-auto">⌘K</Kbd>
        </Button>
        {/* What others shared lives in their projects, not in the one the lists below show. */}
        <Button
          variant="ghost"
          className="w-full justify-start px-2 text-muted-foreground data-[status=active]:bg-accent data-[status=active]:text-foreground"
          render={<Link to="/shared" />}
          data-shared-link>
          <Users /> Shared with me
        </Button>
      </div>

      <div className="scrollbar-thin mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {LIBRARY_GROUPS.map(group => (
          <LibraryGroup key={group.title} group={group} />
        ))}
        <section className="mt-3">
          <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Chats</h2>
          {isPending && [0, 1, 2].map(i => <Skeleton key={i} className="mx-2 my-1.5 h-6" />)}
          {chats?.items.map(chat => (
            <Link
              key={chat.metadata.rid}
              to="/conversations/$rid"
              params={{ rid: chat.metadata.rid }}
              className="block truncate rounded-lg px-2 py-1 text-sm text-foreground/85 hover:bg-accent data-[status=active]:bg-accent data-[status=active]:text-foreground">
              {chat.metadata.name}
            </Link>
          ))}
        </section>
      </div>

      <div className="border-t p-2">
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Button variant="ghost" className="h-11 w-full justify-start gap-2.5 px-2" data-user-menu>
              <Avatar name={user?.name ?? "?"} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-medium">{user?.name}</span>
                <span className="block truncate text-xs font-normal text-muted-foreground">{user?.email}</span>
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" className="w-60">
            <DropdownMenuLabel>Signed in through Keycloak</DropdownMenuLabel>
            <DropdownMenuItem onClick={toggleTheme}>
              <MoonStar /> Toggle dark mode
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                void signOut().catch(() => navigate({ to: "/login" }));
              }}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}

/** A group of the library in the sidebar; a folded one opens when asked, or when it holds the page. */
function LibraryGroup({ group }: { group: (typeof LIBRARY_GROUPS)[number] }) {
  const path = useRouterState({ select: state => state.location.pathname });
  const [open, setOpen] = useState(false);
  const shown = !group.folded || open || group.kinds.some(kind => path.startsWith(`/${pluralOf(kind)}`));
  return (
    <section className="mb-3">
      {group.folded ? (
        <button
          type="button"
          aria-expanded={shown}
          onClick={() => setOpen(o => !o)}
          className="flex w-full items-center gap-1 px-2 pb-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          data-library-group={group.title}>
          {group.title}
          <ChevronRight className={shown ? "size-3 rotate-90 transition-transform" : "size-3 transition-transform"} />
        </button>
      ) : (
        <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.title}</h2>
      )}
      {shown &&
        group.kinds.map(kind => {
          const spec = KINDS[kind];
          return (
            <Link
              key={kind}
              to="/$plural"
              params={{ plural: pluralOf(kind) }}
              data-library-link={kind}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1 text-sm hover:bg-accent data-[status=active]:bg-accent data-[status=active]:font-medium">
              <spec.icon className="size-4 text-muted-foreground" />
              {spec.plural}
            </Link>
          );
        })}
    </section>
  );
}
