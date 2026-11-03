import { useQuery } from "@tanstack/react-query";
import { agentsSpawn } from "@texera/catalog-client";
import { conversationQuery, createDatasetVersion, unwrap } from "@texera/kinds";
import { ErrorNote, Skeleton, cn } from "@texera/ui";
import { Loader2 } from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import { StatePart } from "./parts";
import { ResourcesRail } from "./ResourcesRail";
import { type Attachment, useConversation } from "./useConversation";

/** A conversation: its messages, the composer, and the resources it produced beside it. */
export function ChatView({ rid, getToken }: { rid: string; getToken: () => string | undefined }) {
  const { data: conversation, error, refetch } = useQuery(conversationQuery(rid));
  const [spawning, setSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<unknown>();
  const agent = conversation?.status?.agent;
  // An older chat without an agent on record gets one on first open.
  useEffect(() => {
    if (!conversation || agent || spawning) return;
    setSpawning(true);
    unwrap(agentsSpawn({ body: { template: conversation.spec.template, conversation: rid, lifetime: "conversation" } }))
      .then(() => refetch())
      .catch(setSpawnError)
      .finally(() => setSpawning(false));
  }, [conversation, agent, spawning, rid, refetch]);
  if (error) return <ErrorNote error={error} prefix="Could not open this chat" className="m-4" />;
  if (spawnError !== undefined) return <ErrorNote error={spawnError} prefix="Could not start the chat's agent" className="m-4" />;
  if (!conversation) return <Skeleton className="m-4 h-64" />;
  return <Conversation rid={rid} agent={agent} getToken={getToken} />;
}

function Conversation({ rid, agent, getToken }: { rid: string; agent: string | undefined; getToken: () => string | undefined }) {
  const chat = useConversation({ rid, agent, getToken });
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<{ status?: string; error?: string }>({});
  const uploading = upload.status !== undefined;
  const busy = chat.running || uploading;

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
        const { ref } = await createDatasetVersion(attached, { onStatus: s => setUpload({ status: s }), origin: { conversation: rid, seq: 0 } });
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

  const composer = (
    <div className="space-y-2">
      {upload.error && <p className="text-xs text-destructive">Upload failed: {upload.error}</p>}
      <Composer
        busy={busy}
        onSend={send}
        onStop={chat.stop}
        files={files}
        onFilesChange={setFiles}
        autoFocus
        status={uploading ? `${upload.status}…` : chat.steps.at(-1)}
      />
    </div>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a file drop zone; the attach button is the keyboard path
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
              <p className="py-10 text-center text-sm text-muted-foreground">Say what you want to analyze, or drop a CSV here.</p>
            )}
            {chat.messages.map((m, i) => (
              <div key={m.id} className="[content-visibility:auto] [contain-intrinsic-size:auto_120px]">
                <MessageItem message={m} streaming={chat.running && i === chat.messages.length - 1} />
              </div>
            ))}
            {chat.running && (!last || last.role === "user") && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            <StatePart state={chat.state} />
          </div>
        </div>
        <div className="mx-auto w-full max-w-3xl px-4 pb-4">{composer}</div>
      </div>
      <ResourcesRail rid={rid} live={chat.resources} className="hidden w-60 shrink-0 border-l p-3 xl:block" />
      <div
        className={cn(
          "pointer-events-none absolute inset-3 hidden items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary",
          dragging && "flex"
        )}>
        Drop files to add them as a dataset
      </div>
    </div>
  );
}
