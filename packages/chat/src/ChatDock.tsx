// The agent beside a page. It is the same chat as anywhere else, opened over the resource page
// a person is on: each message says what that page shows, so the agent knows what "this" is
// and reads it with its own tools. Nothing binds the chat to the resource; the app remembers
// the chat last used beside each page, so opening the dock there again continues it. Open, it
// is a window that floats over the page without blocking the rest of it: its header moves it,
// its top left corner sizes it, a double click on the header puts it back.

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
import { Button, cn, Tooltip } from "@texera/ui";
import { Maximize2, SquarePen, X } from "lucide-react";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { ChatBubble } from "./ChatBubble";
import { ChatView } from "./ChatView";
import { dockChat, withDockChat } from "./dock";
import { DEFAULT_WINDOW, type DockWindow, fitted, moved, remember, remembered, resized } from "./dock-window";
import { NewChat } from "./NewChat";

export function ChatDock({ page, getToken }: { page: ResourceRef; getToken: () => string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex flex-col items-end" data-chat-dock-root>
      {open ? (
        <Dock page={page} getToken={getToken} onClose={() => setOpen(false)} />
      ) : (
        <ChatBubble label="Ask about this page" className="pointer-events-auto" onClick={() => setOpen(true)} data-chat-dock-button />
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
  const { box, drag, grip, reset, dragging } = useDockWindow();
  return (
    <section
      className="pointer-events-auto fixed flex flex-col overflow-hidden rounded-2xl border bg-background shadow-xl"
      style={box}
      aria-label="Chat about this page"
      data-chat-dock={conversation ?? "new"}>
      {/* The corner that faces the page sizes the window; the opposite one stays where it is. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer's grip; the window is whole at the size it opens at */}
      <div
        className="absolute top-0 left-0 z-10 size-4 cursor-nwse-resize touch-none"
        aria-hidden
        {...grip}
        data-dock-grip
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer's handle that moves the window; it is whole where it opens */}
      <header
        className={cn("flex shrink-0 touch-none items-center gap-2 border-b px-3 py-2", dragging ? "cursor-grabbing" : "cursor-grab")}
        title="Drag to move; double-click to put it back"
        onDoubleClick={reset}
        {...drag}
        data-dock-header>
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

/**
 * The window's place and size, kept on screen as the screen changes and remembered in this
 * browser: a pointer held on the header moves it, one held on the grip sizes it. A press on one
 * of the header's buttons is the button's, not a move.
 */
const screen = () => ({ width: window.innerWidth, height: window.innerHeight });

function useDockWindow() {
  const [box, setBox] = useState<DockWindow>(() => fitted(remembered(), screen()));
  const [dragging, setDragging] = useState(false);
  const held = useRef<{ x: number; y: number; from: DockWindow; how: typeof moved } | null>(null);
  useEffect(() => {
    const refit = () => setBox(b => fitted(b, screen()));
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, []);
  const handlers = (how: typeof moved) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      held.current = { x: e.clientX, y: e.clientY, from: box, how };
      setDragging(true);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const h = held.current;
      if (h) setBox(fitted(h.how(h.from, e.clientX - h.x, e.clientY - h.y), screen()));
    },
    onPointerUp: () => {
      if (!held.current) return;
      held.current = null;
      setDragging(false);
      setBox(b => {
        remember(b);
        return b;
      });
    },
  });
  const reset = () => {
    remember(undefined);
    setBox(fitted(DEFAULT_WINDOW, screen()));
  };
  return { box, drag: handlers(moved), grip: handlers(resized), reset, dragging };
}
