// The agent beside a page. It is the same chat as anywhere else, opened over the resource page
// a person is on: each message says what that page shows, so the agent knows what "this" is
// and reads it with its own tools. Nothing binds the chat to the resource; the app remembers
// the chat last used beside each page, so opening the dock there again continues it.

import { useMutation, useQuery } from "@tanstack/react-query";
import {
  canQuery,
  KINDS,
  KindIcon,
  meQuery,
  type ResourceRef,
  resourceQuery,
  useChangePreferences,
  useOpenResource,
  useViewingDetail,
  viewingContext,
} from "@texera/kinds";
import { Button, Tooltip } from "@texera/ui";
import { Maximize2, MessageCircle, SquarePen, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ChatView } from "./ChatView";
import { dockChat, withDockChat } from "./dock";
import { NewChat } from "./NewChat";

export function ChatDock({ page, getToken }: { page: ResourceRef; getToken: () => string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex flex-col items-end" data-chat-dock-root>
      {open ? (
        <Dock page={page} getToken={getToken} onClose={() => setOpen(false)} />
      ) : (
        <Tooltip content="Ask about this page" side="left">
          <Button size="icon" className="pointer-events-auto size-12 rounded-full shadow-lg" aria-label="Ask about this page" onClick={() => setOpen(true)} data-chat-dock-button>
            <MessageCircle className="size-5" />
          </Button>
        </Tooltip>
      )}
    </div>
  );
}

function Dock({ page, getToken, onClose }: { page: ResourceRef; getToken: () => string | undefined; onClose: () => void }) {
  const change = useChangePreferences();
  const { expand } = useOpenResource();
  const { data: me } = useQuery(meQuery());
  const { data: resource } = useQuery(resourceQuery(page.rid));
  const name = resource?.metadata.name;
  const detail = useViewingDetail();
  const context = useMemo(() => viewingContext(page, name, detail), [page, name, detail]);

  // A chat goes into the project the person works in, like anything they make. With every
  // project in view they are asked, starting from the project of the page's resource when
  // they may add to it.
  const project = resource?.metadata.project;
  const { data: mayAdd } = useQuery({ ...canQuery("write", project ?? ""), enabled: project !== undefined });

  // The chat last used beside this page, while it still exists.
  const remembered = dockChat(me?.preferences, page.rid);
  const { data: chat, isError: gone } = useQuery({ ...resourceQuery(remembered ?? ""), enabled: remembered !== undefined, retry: false });
  const conversation = remembered && !gone ? remembered : undefined;
  const remember = useMutation({
    mutationFn: (next: string | undefined) => change(preferences => withDockChat(preferences, page.rid, next)),
  });

  const label = KINDS[page.kind].label.toLowerCase();
  return (
    <section
      className="pointer-events-auto flex h-[min(40rem,calc(100vh-6rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-background shadow-xl"
      aria-label="Chat about this page"
      data-chat-dock={conversation ?? "new"}>
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <KindIcon kind="conversation" className="size-7" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{chat && conversation ? chat.metadata.name : "New chat"}</div>
          <div className="truncate text-xs text-muted-foreground" data-dock-about={page.rid}>
            about the {label} {name ?? "…"}
          </div>
        </div>
        {conversation && (
          <>
            <Tooltip content="Start a new chat">
              <Button variant="ghost" size="icon-sm" aria-label="Start a new chat" onClick={() => remember.mutate(undefined)} data-dock-new>
                <SquarePen />
              </Button>
            </Tooltip>
            <Tooltip content="Open as a page">
              <Button variant="ghost" size="icon-sm" aria-label="Open the chat as a page" onClick={() => expand({ kind: "conversation", rid: conversation })} data-dock-open-page>
                <Maximize2 />
              </Button>
            </Tooltip>
          </>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Close the chat" onClick={onClose} data-dock-close>
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {conversation ? (
          <ChatView key={conversation} rid={conversation} getToken={getToken} context={context} dock />
        ) : (
          mayAdd !== undefined && (
            <NewChat
              dock
              about={name}
              suggested={mayAdd ? project : undefined}
              greeting={`Ask about this ${label}. The agent reads it as it is now.`}
              onCreated={rid => remember.mutate(rid)}
            />
          )
        )}
      </div>
    </section>
  );
}
