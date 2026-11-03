import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { conversationsListOptions } from "@texera/catalog-client/query";
import { KINDS, LIBRARY_KINDS } from "@texera/kinds";
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
  Skeleton,
  toggleTheme,
} from "@texera/ui";
import { LogOut, MoonStar, PanelLeftClose, Search, SquarePen } from "lucide-react";
import { signOut, useSession } from "@/auth/session";

export function Sidebar({ onCollapse, onSearch }: { onCollapse: () => void; onSearch: () => void }) {
  const user = useSession();
  const navigate = useNavigate();
  const { data: chats, isPending } = useQuery({
    ...conversationsListOptions({ query: { limit: 50 } }),
    staleTime: 15_000,
  });

  return (
    <nav className="flex h-full w-64 flex-col bg-sidebar" aria-label="Main">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <Link to="/" className="flex items-center gap-2 px-1 text-[15px] font-semibold tracking-tight">
          <img src="/texera-mark.png" alt="" className="size-7" />
          Texera
        </Link>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label="Collapse sidebar">
          <PanelLeftClose />
        </Button>
      </div>

      <div className="space-y-0.5 px-2">
        <Button variant="ghost" className="w-full justify-start px-2" render={<Link to="/" />} data-new-chat-link>
          <SquarePen /> New chat
        </Button>
        <Button variant="ghost" className="w-full justify-start px-2 text-muted-foreground" onClick={onSearch}>
          <Search /> Search
          <Kbd className="ml-auto">⌘K</Kbd>
        </Button>
      </div>

      <div className="mt-4 px-2">
        <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Library</h2>
        {LIBRARY_KINDS.map(kind => {
          const spec = KINDS[kind];
          return (
            <Link
              key={kind}
              to="/library/$kind"
              params={{ kind: spec.librarySlug }}
              data-library-link={kind}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-accent data-[status=active]:bg-accent data-[status=active]:font-medium">
              <spec.icon className="size-4 text-muted-foreground" />
              {spec.plural}
            </Link>
          );
        })}
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col px-2">
        <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Chats</h2>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pb-2">
          {isPending && [0, 1, 2].map(i => <Skeleton key={i} className="mx-2 my-1.5 h-6" />)}
          {chats?.items.map(chat => (
            <Link
              key={chat.metadata.rid}
              to="/c/$rid"
              params={{ rid: chat.metadata.rid }}
              className="block truncate rounded-lg px-2 py-1.5 text-sm text-foreground/85 hover:bg-accent data-[status=active]:bg-accent data-[status=active]:text-foreground">
              {chat.metadata.name}
            </Link>
          ))}
        </div>
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
