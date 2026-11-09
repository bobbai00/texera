import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationSpec, ConversationStatus, Resource } from "@texera/catalog-client/types";
import { type AppContext, baseUri, chatSettingsQuery, createDatasetVersion, EditableName, FromThisChat, keysOf, KindIcon, ProjectOverview, meQuery, OpenError, Presence, PrincipalName, ProjectScope, refOf, ResourcePanel, resourceQuery, settleViewing, ShareButton, updateMetadata, updateSpec, useChatGraph, useMay, useOpenResource } from "@texera/kinds";
import { Button, ErrorNote, Skeleton, cn } from "@texera/ui";
import { Loader2, Maximize2, Minimize2, PanelRight } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ScrollPoint, staysPinned } from "./chat-scroll";
import { ChatSettingsBar, PassedOver } from "./ChatSettingsBar";
import { Composer } from "./Composer";
import { useResourceLabels } from "./labels";
import { useChatMaximized } from "./maximized";
import { MessageItem } from "./MessageItem";
import { writersOf } from "./model";
import { StatePart } from "./parts";
import { awaitsFirstMessage, takeFirstMessage } from "./pending";
import { type Attachment, useConversation } from "./useConversation";

export interface ChatViewProps {
  rid: string;
  getToken: () => string | undefined;
  /** Beside a page: what the person is looking at there, sent with each message. */
  context?: AppContext[];
  /** Shown in the dock beside a page: the messages and the box, without the chat's own frame. */
  dock?: boolean;
}

/** A conversation: its messages, the composer, the agent it runs, and the resources it produced beside it. */
export function ChatView({ rid, ...rest }: ChatViewProps) {
  const { data: conversation, error } = useQuery({ ...resourceQuery(rid), staleTime: 5_000 });
  if (error) return <OpenError error={error} kind="conversation" />;
  if (!conversation) return <Skeleton className="m-4 h-64" />;
  return <Conversation rid={rid} conversation={conversation} {...rest} />;
}

function Conversation({ rid, conversation, getToken, context, dock = false }: ChatViewProps & { conversation: Resource }) {
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
  const chat = useConversation({ rid, template: agent?.uri, getToken, context });
  const { data: me } = useQuery(meQuery());
  const myPid = me?.principal.pid;
  // A shared chat is a group chat: one turn at a time, and the others see whose it is.
  const othersTurn = status?.activeTurn && status.activeTurnBy && status.activeTurnBy !== myPid ? status.activeTurnBy : undefined;
  // Someone the chat is shared with to read follows it; writing in it takes more.
  const may = useMay(rid);
  const readOnly = may.write === false;
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<{ status?: string; error?: string }>({});
  const uploading = upload.status !== undefined;
  // A chat is created by its first message, which the page that started it left for it. Until
  // that message is sent the chat is busy with it: it never stands empty with a box to write in.
  const [starting, setStarting] = useState(() => awaitsFirstMessage(rid));
  const busy = chat.running || uploading || starting;
  // The chat's resource graph, followed while the agent works, and again with every message.
  const { graph, started, refresh } = useChatGraph(rid, { enabled: !dock, live: chat.running });
  const [maximized, toggleMaximized] = useChatMaximized();
  const graphBeside = !dock && !maximized && started && !!graph;
  const rename = useMutation({
    mutationFn: (name: string) => updateMetadata(rid, { name }, conversation.metadata.etag),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      for (const key of keysOf(rid)) queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const said = chat.messages.length;
  useEffect(() => {
    if (said > 0) refresh();
  }, [said, refresh]);
  const uris = useMemo(() => writersOf(chat.messages), [chat.messages]);
  const labels = useResourceLabels(uris);
  const { beside, expand } = useOpenResource();
  const openGraph = useCallback(() => expand({ kind: "conversation", rid }), [expand, rid]);

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const scrolledTo = useRef<ScrollPoint>({ top: 0, height: 0, client: 0 });
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

  const [noteError, setNoteError] = useState<unknown>();
  /** Sends what is in the box: to the agent, or as a note to the people in the chat. */
  const send = async ({ text, files: attached }: { text: string; files: File[] }, ask = true) => {
    setNoteError(undefined);
    const attachments: Attachment[] = [];
    if (attached.length) {
      try {
        setUpload({ status: "Preparing upload" });
        // A file attached is the chat's own: the agent reads it, a workflow can use it, and it is
        // a dataset of the project only if someone asks to keep it.
        const { ref } = await createDatasetVersion(attached, { parent: project, attachedTo: rid, name: attached[0]?.name, onStatus: s => setUpload({ status: s }) });
        attachments.push({ ref, name: attached.map(f => f.name).join(", ") });
      } catch (e) {
        setUpload({ error: e instanceof Error ? e.message : String(e) });
        return false;
      }
      setUpload({});
    }
    setFiles([]);
    if (!ask) {
      try {
        await chat.note(text, attachments);
      } catch (e) {
        setNoteError(e);
        return false;
      }
      return true;
    }
    // The agent reads what the person sees: an edit of the page still on its way is saved first.
    if (context) await settleViewing();
    void chat.send(text, attachments);
    return true;
  };

  /**
   * A comment on a thing of the graph: a message of the chat that names the thing and has it
   * attached. It asks the agent, unless a turn is going: then the agent reads it in the next one.
   */
  const comment = async (on: { uri: string; name: string }, text: string) => {
    const ref = refOf(on.uri);
    const attachments: Attachment[] = ref ? [{ ref, name: on.name }] : [];
    const words = `Comment on ${on.name}: ${text}`;
    if (busy || othersTurn !== undefined) {
      try {
        await chat.note(words, attachments);
      } catch (e) {
        setNoteError(e);
        return false;
      }
      return true;
    }
    void chat.send(words, attachments);
    return true;
  };

  const sendFirst = useRef(send);
  sendFirst.current = send;
  useEffect(() => {
    const first = takeFirstMessage(rid);
    if (first) void sendFirst.current(first).finally(() => setStarting(false));
  }, [rid]);

  // The newest reply is what the chat waits on: a question to pick from, a change to decide on.
  // The person answers it there, when nothing runs and the chat is theirs to write in.
  const canAnswer = !busy && !readOnly && othersTurn === undefined;
  const answers = useMemo(
    () => ({
      pick: (label: string) => void sendFirst.current({ text: label, files: [] }),
      decide: (toolCallId: string, approved: boolean) => void chat.decide(toolCallId, approved),
    }),
    [chat.decide]
  );

  // Which assistant messages open a run of the same template: those get the label.
  let previousTemplate: string | undefined;
  const items = chat.messages.map(m => {
    const show = m.role === "assistant" && m.template !== undefined && baseUri(m.template) !== (previousTemplate ? baseUri(previousTemplate) : undefined);
    if (m.role === "assistant" && m.template) previousTemplate = m.template;
    if (m.role === "system") previousTemplate = undefined;
    return { message: m, showLabel: show };
  });

  return (
    // What the chat lists (models, add-ons) and makes is its own project's.
    <ProjectScope project={project}>
    {/* biome-ignore lint/a11y/noStaticElementInteractions: a file drop zone; the attach button is the keyboard path */}
    <div
      className="relative flex h-full min-h-0"
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
      {/* Behind the chat, what the project holds; once the chat starts work, what it reads, makes and runs. */}
      {!dock &&
        !maximized &&
        (started && graph ? (
          <ResourcePanel rid={rid} graph={graph} className="hidden min-w-0 flex-1 xl:flex" onComment={readOnly ? undefined : comment} />
        ) : (
          <div className="scrollbar-thin hidden min-w-0 flex-1 overflow-y-auto xl:block" data-chat-behind>
            <FromThisChat rid={rid} className="mx-auto max-w-5xl px-6 pt-6" />
            <ProjectOverview rid={project} />
          </div>
        ))}
      <div className={cn("flex min-h-0 min-w-0 flex-col", dock || maximized ? "flex-1" : "flex-1 xl:m-3 xl:w-[30rem] xl:flex-none xl:overflow-hidden xl:rounded-2xl xl:border xl:bg-background xl:shadow-xl")} data-chat-window data-chat-maximized={maximized ? "true" : undefined}>
      {!dock && (
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2" data-chat-header>
          <KindIcon kind="conversation" className="size-7" />
          <div className="min-w-0 flex-1">
            <EditableName value={conversation.metadata.name} onChange={name => rename.mutateAsync(name)} disabled={may.write !== true} label="Chat name" />
            <div className="truncate text-xs text-muted-foreground">
              with <span data-current-template>{agent?.name ?? "…"}</span> · started by <PrincipalName pid={conversation.metadata.createdBy} />
            </div>
          </div>
          {/* Beside the graph the people show on it; where the graph is not drawn, they show here. */}
          <div className={cn(graphBeside && "xl:hidden")}>
            <Presence rid={rid} />
          </div>
          <ShareButton ref={{ kind: "conversation", rid }} />
          <Button variant="ghost" size="icon-sm" aria-label="Open the chat's details beside" onClick={() => beside({ kind: "conversation", rid })}>
            <PanelRight />
          </Button>
          <Button variant="ghost" size="icon-sm" className="hidden xl:inline-flex" aria-label={maximized ? "Show the graph and project again" : "Maximize the chat"} title={maximized ? "Show the graph and project again" : "Maximize the chat"} aria-pressed={maximized} onClick={toggleMaximized} data-chat-maximize>
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </header>
      )}
          <div
            ref={scroller}
            onScroll={e => {
              const el = e.currentTarget;
              const now = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
              pinned.current = staysPinned(pinned.current, scrolledTo.current, now);
              scrolledTo.current = now;
            }}
            className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <div ref={content} className={cn("mx-auto w-full max-w-3xl space-y-6", dock ? "px-3 py-4" : "px-4 py-8")}>
              {chat.loading && <Skeleton className="h-24" />}
              {chat.historyError && <ErrorNote error={chat.historyError} prefix="Could not load the history" />}
              {!chat.loading && chat.messages.length === 0 && (
                <p className="py-10 text-center text-sm text-muted-foreground">Say what you want to do, or drop a CSV here.</p>
              )}
              {items.map(({ message, showLabel }, i) => (
                // Older messages skip layout until scrolled to; the newest ones must have their real
                // height, or the chat cannot find its end when the persisted copy replaces the live one.
                <div
                  key={message.id}
                  data-message-seq={message.seq}
                  className={cn(i < items.length - NEWEST_LAID_OUT && "[content-visibility:auto] [contain-intrinsic-size:auto_120px]")}>
                  <MessageItem
                    message={message}
                    streaming={chat.running && i === items.length - 1}
                    labels={labels}
                    showLabel={showLabel}
                    showAuthor={message.author !== undefined && message.author !== myPid}
                    answers={canAnswer && i === items.length - 1 && message.role === "assistant" ? answers : undefined}
                    openGraph={dock ? openGraph : undefined}
                  />
                </div>
              ))}
              {chat.running && (!last || last.role === "user") && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              <StatePart state={chat.state} />
            </div>
          </div>
          <div className={cn("mx-auto w-full max-w-3xl space-y-2", dock ? "px-3 pb-3" : "px-4 pb-4")}>
            {upload.error && <p className="text-xs text-destructive">Upload failed: {upload.error}</p>}
            {choose.error && <ErrorNote error={choose.error} prefix="Could not change what this chat runs with" />}
            {noteError !== undefined && <ErrorNote error={noteError} prefix="Could not post the note" />}
            <PassedOver settings={settings} />
            {othersTurn && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-turn-of={othersTurn}>
                <Loader2 className="size-3 animate-spin" />
                <PrincipalName pid={othersTurn} /> is talking to {agent?.name ?? "the agent"}…
              </p>
            )}
            {readOnly && (
              <p className="text-xs text-muted-foreground" data-chat-read-only>
                This chat is shared with you to read. Ask its owner to let you write in it.
              </p>
            )}
            <Composer
              busy={busy}
              disabled={othersTurn !== undefined}
              readOnly={readOnly}
              onSend={send}
              onNote={message => send(message, false)}
              onStop={chat.stop}
              files={files}
              onFilesChange={setFiles}
              autoFocus
              status={uploading ? `${upload.status}…` : chat.steps.at(-1)}
              // What the chat runs with is chosen on the chat's own page; the dock is for asking.
              controls={dock ? undefined : <ChatSettingsBar settings={settings} choices={choices} onChange={next => choose.mutate(next)} disabled={busy || choose.isPending || othersTurn !== undefined} />}
            />
          </div>
        </div>
      <div className={cn("pointer-events-none absolute inset-3 hidden items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary", dragging && "flex")}>
        Drop files to attach them to this chat
      </div>
    </div>
    </ProjectScope>
  );
}

/** How many messages at the end of a chat are always laid out: a whole turn, a handoff included. */
const NEWEST_LAID_OUT = 6;
