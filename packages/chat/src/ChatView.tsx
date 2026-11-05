import { useQuery } from "@tanstack/react-query";
import type { AgentTemplateSpec, ConversationSpec, ConversationStatus, Resource } from "@texera/catalog-client/types";
import { baseUri, createDatasetVersion, KindIcon, meQuery, PrincipalName, resourceQuery, searchQuery, useOpenResource } from "@texera/kinds";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, ErrorNote, Skeleton, cn } from "@texera/ui";
import { ChevronDown, Loader2, PanelRight } from "lucide-react";
import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import { templatesOf } from "./model";
import { StatePart } from "./parts";
import { ResourcesRail } from "./ResourcesRail";
import { useTemplateLabels } from "./templates";
import { type Attachment, useConversation } from "./useConversation";

/** A conversation: its messages, the composer, the agent it runs, and the resources it produced beside it. */
export function ChatView({ rid, getToken }: { rid: string; getToken: () => string | undefined }) {
  const { data: conversation, error } = useQuery({ ...resourceQuery(rid), staleTime: 5_000 });
  if (error) return <ErrorNote error={error} prefix="Could not open this chat" className="m-4" />;
  if (!conversation) return <Skeleton className="m-4 h-64" />;
  return <Conversation rid={rid} conversation={conversation} getToken={getToken} />;
}

function Conversation({ rid, conversation, getToken }: { rid: string; conversation: Resource; getToken: () => string | undefined }) {
  const spec = conversation.spec as unknown as ConversationSpec;
  const status = conversation.status as ConversationStatus | undefined;
  const chat = useConversation({ rid, template: spec.template, getToken });
  const { data: me } = useQuery(meQuery());
  const myPid = me?.principal.pid;
  // A shared chat is a group chat: one turn at a time, and the others see whose it is.
  const othersTurn = status?.activeTurn && status.activeTurnBy && status.activeTurnBy !== myPid ? status.activeTurnBy : undefined;
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<{ status?: string; error?: string }>({});
  const uploading = upload.status !== undefined;
  const busy = chat.running || uploading;
  const uris = useMemo(() => [spec.template, ...templatesOf(chat.messages)], [spec.template, chat.messages]);
  const labels = useTemplateLabels(uris);
  const current = labels.get(spec.template);
  const { beside } = useOpenResource();

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = chat.messages.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the streaming message grows
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [last, chat.messages.length]);

  const send = async ({ text, files: attached }: { text: string; files: File[] }) => {
    const attachments: Attachment[] = [];
    if (attached.length) {
      try {
        setUpload({ status: "Preparing upload" });
        const { ref } = await createDatasetVersion(attached, { onStatus: s => setUpload({ status: s }) });
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

  // Which assistant messages open a run of the same template: those get the label.
  let previousTemplate: string | undefined;
  const items = chat.messages.map(m => {
    const show = m.role === "assistant" && m.template !== undefined && baseUri(m.template) !== (previousTemplate ? baseUri(previousTemplate) : undefined);
    if (m.role === "assistant" && m.template) previousTemplate = m.template;
    if (m.role === "system") previousTemplate = undefined;
    return { message: m, showLabel: show };
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a file drop zone; the attach button is the keyboard path
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
            with <span data-current-template>{current?.name ?? "…"}</span>
          </div>
        </div>
        <TemplateSwitcher current={spec.template} disabled={busy || othersTurn !== undefined} onPick={uri => void chat.send(`/mode ${uri}`)} />
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
            <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
              {chat.loading && <Skeleton className="h-24" />}
              {chat.historyError && <ErrorNote error={chat.historyError} prefix="Could not load the history" />}
              {!chat.loading && chat.messages.length === 0 && (
                <p className="py-10 text-center text-sm text-muted-foreground">Say what you want to do, or drop a CSV here. Type /mode and an agent's name to switch agents.</p>
              )}
              {items.map(({ message, showLabel }, i) => (
                <div key={message.id} className="[content-visibility:auto] [contain-intrinsic-size:auto_120px]">
                  <MessageItem message={message} streaming={chat.running && i === items.length - 1} labels={labels} showLabel={showLabel} showAuthor={message.author !== undefined && message.author !== myPid} />
                </div>
              ))}
              {chat.running && (!last || last.role === "user") && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              <StatePart state={chat.state} />
            </div>
          </div>
          <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pb-4">
            {upload.error && <p className="text-xs text-destructive">Upload failed: {upload.error}</p>}
            {othersTurn && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-turn-of={othersTurn}>
                <Loader2 className="size-3 animate-spin" />
                <PrincipalName pid={othersTurn} /> is talking to {current?.name ?? "the agent"}…
              </p>
            )}
            <Composer busy={busy} disabled={othersTurn !== undefined} onSend={send} onStop={chat.stop} files={files} onFilesChange={setFiles} autoFocus status={uploading ? `${upload.status}…` : chat.steps.at(-1)} />
          </div>
        </div>
        <ResourcesRail rid={rid} live={chat.resources} className="hidden w-60 shrink-0 border-l p-3 xl:block" />
      </div>
      <div className={cn("pointer-events-none absolute inset-3 hidden items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary", dragging && "flex")}>
        Drop files to add them as a dataset
      </div>
    </div>
  );
}

/** Picks the agent the next turn runs. Switching goes through the host's `/mode`, like typing it. */
function TemplateSwitcher({ current, disabled, onPick }: { current: string; disabled: boolean; onPick: (uri: string) => void }) {
  const { data } = useQuery({ ...searchQuery({ kind: "agent-template" }), staleTime: 60_000 });
  const name = (t: Resource) => (t.spec as unknown as AgentTemplateSpec).card?.name || t.metadata.name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Button variant="outline" size="sm" disabled={disabled} data-template-switcher>
          <KindIcon kind="agent-template" className="size-5 rounded-md [&_svg]:size-3" />
          {data?.items.find(t => t.metadata.uri === baseUri(current)) ? name(data.items.find(t => t.metadata.uri === baseUri(current)) as Resource) : "Agent"}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" className="w-64">
        <DropdownMenuLabel>Switch agent</DropdownMenuLabel>
        {data?.items.map(t => (
          <DropdownMenuItem key={t.metadata.rid} onClick={() => t.metadata.uri !== baseUri(current) && onPick(t.metadata.uri)} data-switch-to={name(t)}>
            <span className={cn("min-w-0 flex-1 truncate", t.metadata.uri === baseUri(current) && "font-semibold")}>{name(t)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
