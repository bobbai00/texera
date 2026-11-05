import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationSpec, ConversationStatus, Resource } from "@texera/catalog-client/types";
import { baseUri, chatSettingsQuery, createDatasetVersion, keysOf, KindIcon, meQuery, PrincipalName, ProjectScope, resourceQuery, updateSpec, useOpenResource } from "@texera/kinds";
import { Button, ErrorNote, Skeleton, cn } from "@texera/ui";
import { Loader2, PanelRight } from "lucide-react";
import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { ChatSettingsBar, PassedOver } from "./ChatSettingsBar";
import { Composer } from "./Composer";
import { useResourceLabels } from "./labels";
import { MessageItem } from "./MessageItem";
import { writersOf } from "./model";
import { StatePart } from "./parts";
import { takeFirstMessage } from "./pending";
import { ResourcesRail } from "./ResourcesRail";
import { type Attachment, useConversation } from "./useConversation";

/** A conversation: its messages, the composer, the agent it runs, and the resources it produced beside it. */
export function ChatView({ rid, getToken }: { rid: string; getToken: () => string | undefined }) {
  const { data: conversation, error } = useQuery({ ...resourceQuery(rid), staleTime: 5_000 });
  if (error) return <ErrorNote error={error} prefix="Could not open this chat" className="m-4" />;
  if (!conversation) return <Skeleton className="m-4 h-64" />;
  return <Conversation rid={rid} conversation={conversation} getToken={getToken} />;
}

function Conversation({ rid, conversation, getToken }: { rid: string; conversation: Resource; getToken: () => string | undefined }) {
  const status = conversation.status as ConversationStatus | undefined;
  // The chat stores only its choices; what it runs with is the catalog's to resolve.
  const choices = conversation.spec as ConversationSpec;
  const project = conversation.metadata.project;
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(chatSettingsQuery(rid));
  const agent = settings?.agent;
  const choose = useMutation({
    mutationFn: (next: ConversationSpec) => updateSpec("conversation", rid, { spec: next }),
    onSuccess: () => {
      for (const key of keysOf(rid)) queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const chat = useConversation({ rid, template: agent?.uri, getToken });
  const { data: me } = useQuery(meQuery());
  const myPid = me?.principal.pid;
  // A shared chat is a group chat: one turn at a time, and the others see whose it is.
  const othersTurn = status?.activeTurn && status.activeTurnBy && status.activeTurnBy !== myPid ? status.activeTurnBy : undefined;
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<{ status?: string; error?: string }>({});
  const uploading = upload.status !== undefined;
  const busy = chat.running || uploading;
  const uris = useMemo(() => writersOf(chat.messages), [chat.messages]);
  const labels = useResourceLabels(uris);
  const { beside } = useOpenResource();

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = chat.messages.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the streaming message grows
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [last, chat.messages.length]);
  // A message settles into its height after it renders: the persisted copy replaces the live one,
  // a card loads its data. A chat at its end stays there while that happens.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const follow = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    follow.observe(inner);
    return () => follow.disconnect();
  }, []);

  const send = async ({ text, files: attached }: { text: string; files: File[] }) => {
    const attachments: Attachment[] = [];
    if (attached.length) {
      try {
        setUpload({ status: "Preparing upload" });
        // An attachment becomes a dataset of the chat's project.
        const { ref } = await createDatasetVersion(attached, { parent: project, onStatus: s => setUpload({ status: s }) });
        attachments.push({ ref, name: attached.map(f => f.name).join(", ") });
      } catch (e) {
        setUpload({ error: e instanceof Error ? e.message : String(e) });
        return false;
      }
      setUpload({});
    }
    setFiles([]);
    void chat.send(text, attachments);
    return true;
  };

  // A chat is created by its first message: the page that started it left the message here.
  const sendFirst = useRef(send);
  sendFirst.current = send;
  useEffect(() => {
    const first = takeFirstMessage(rid);
    if (first) void sendFirst.current(first);
  }, [rid]);

  // Which assistant messages open a run of the same template: those get the label.
  let previousTemplate: string | undefined;
  const items = chat.messages.map(m => {
    const show = m.role === "assistant" && m.template !== undefined && baseUri(m.template) !== (previousTemplate ? baseUri(previousTemplate) : undefined);
    if (m.role === "assistant" && m.template) previousTemplate = m.template;
    if (m.role === "system") previousTemplate = undefined;
    return { message: m, showLabel: show };
  });

  return (
    // What the chat lists (models, units, add-ons) and makes is its own project's.
    <ProjectScope project={project}>
    {/* biome-ignore lint/a11y/noStaticElementInteractions: a file drop zone; the attach button is the keyboard path */}
    <div
      className="relative flex h-full min-h-0 flex-col"
      data-chat={rid}
      onDragOver={e => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={e => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) setFiles(f => [...f, ...Array.from(e.dataTransfer.files)]);
      }}>
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2" data-chat-header>
        <KindIcon kind="conversation" className="size-7" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{conversation.metadata.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            with <span data-current-template>{agent?.name ?? "…"}</span>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Open the chat's details beside" onClick={() => beside({ kind: "conversation", rid })}>
          <PanelRight />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scroller}
            onScroll={e => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <div ref={content} className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
              {chat.loading && <Skeleton className="h-24" />}
              {chat.historyError && <ErrorNote error={chat.historyError} prefix="Could not load the history" />}
              {!chat.loading && chat.messages.length === 0 && (
                <p className="py-10 text-center text-sm text-muted-foreground">Say what you want to do, or drop a CSV here.</p>
              )}
              {items.map(({ message, showLabel }, i) => (
                // Older messages skip layout until scrolled to; the newest ones must have their real
                // height, or the chat cannot find its end when the persisted copy replaces the live one.
                <div key={message.id} className={cn(i < items.length - NEWEST_LAID_OUT && "[content-visibility:auto] [contain-intrinsic-size:auto_120px]")}>
                  <MessageItem message={message} streaming={chat.running && i === items.length - 1} labels={labels} showLabel={showLabel} showAuthor={message.author !== undefined && message.author !== myPid} />
                </div>
              ))}
              {chat.running && (!last || last.role === "user") && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              <StatePart state={chat.state} />
            </div>
          </div>
          <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pb-4">
            {upload.error && <p className="text-xs text-destructive">Upload failed: {upload.error}</p>}
            {choose.error && <ErrorNote error={choose.error} prefix="Could not change what this chat runs with" />}
            <PassedOver settings={settings} />
            {othersTurn && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-turn-of={othersTurn}>
                <Loader2 className="size-3 animate-spin" />
                <PrincipalName pid={othersTurn} /> is talking to {agent?.name ?? "the agent"}…
              </p>
            )}
            <Composer
              busy={busy}
              disabled={othersTurn !== undefined}
              onSend={send}
              onStop={chat.stop}
              files={files}
              onFilesChange={setFiles}
              autoFocus
              status={uploading ? `${upload.status}…` : chat.steps.at(-1)}
              controls={<ChatSettingsBar settings={settings} choices={choices} onChange={next => choose.mutate(next)} disabled={busy || choose.isPending || othersTurn !== undefined} />}
            />
          </div>
        </div>
        <ResourcesRail rid={rid} live={chat.resources} className="hidden w-60 shrink-0 border-l p-3 xl:block" />
      </div>
      <div className={cn("pointer-events-none absolute inset-3 hidden items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary", dragging && "flex")}>
        Drop files to add them as a dataset
      </div>
    </div>
    </ProjectScope>
  );
}

/** How many messages at the end of a chat are always laid out: a whole turn, a handoff included. */
const NEWEST_LAID_OUT = 6;
