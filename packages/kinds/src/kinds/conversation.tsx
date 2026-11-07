// A chat seen from outside: what it runs with, what it made and worked from, and its last
// messages. The chat page itself is the app's.

import { useQuery } from "@tanstack/react-query";
import { conversationsListMessagesOptions } from "@texera/catalog-client/query";
import type { ConversationStatus, Setting } from "@texera/catalog-client/types";
import { Button, EmptyState, SectionTitle, Skeleton, cn, timeAgo } from "@texera/ui";
import { ArrowUpRight, MessagesSquare } from "lucide-react";
import { lazy } from "react";
import { chatSettingsQuery, resourceQuery, sourceOf } from "../queries";
import { PrincipalName, UriChip } from "../shell/Chips";
import { FromThisChat } from "../shell/FromThisChat";
import { KindHeader } from "../shell/KindHeader";
import { metaLine } from "../shell/MetaLine";
import { useOpenResource } from "../shell/navigation";
import type { KindSpec, KindViewProps } from "../types";
import { OpenError } from "../shell/OpenError";

function ConversationView({ ref, mode }: KindViewProps) {
  const { data, error } = useQuery(resourceQuery(ref.rid));
  const { data: messages } = useQuery(conversationsListMessagesOptions({ path: { rid: ref.rid }, query: { limit: 20 } }));
  const { data: settings } = useQuery(chatSettingsQuery(ref.rid));
  const { expand } = useOpenResource();
  if (error) return <OpenError error={error} kind="conversation" />;
  if (!data) return <Skeleton className="m-4 h-64" />;
  return (
    <div className="flex h-full min-h-0 flex-col" data-conversation-view={ref.rid}>
      <KindHeader
        ref={{ kind: "conversation", rid: ref.rid }}
        mode={mode}
        name={data.metadata.name}
        meta={
          <>
            {metaLine("conversation", data.metadata)} · started by <PrincipalName pid={data.metadata.createdBy} />
          </>
        }
        actions={
          <Button size="sm" onClick={() => expand({ kind: "conversation", rid: ref.rid })}>
            <ArrowUpRight /> Open chat
          </Button>
        }
      />
      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto p-4">
        <section className="space-y-2" data-chat-settings>
          <SectionTitle>Runs with</SectionTitle>
          {!settings && <Skeleton className="h-16" />}
          {settings && (
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
              <Chosen label="Agent" setting={settings.agent} emphasis />
              <Chosen label="Model" setting={settings.modelEndpoint} />
              {settings.mcpServers.map(server => (
                <Chosen key={server.uri} label={server.platform ? "Tools" : "Add-on"} setting={server} />
              ))}
            </dl>
          )}
        </section>
        <FromThisChat rid={ref.rid} empty={<EmptyState className="py-4">Nothing made or used yet.</EmptyState>} />
        <section className="space-y-2">
          <SectionTitle>Recent messages</SectionTitle>
          {!messages?.items.length && <EmptyState className="py-4">No messages yet.</EmptyState>}
          {messages?.items.map(m => (
            <div key={m.seq} className={cn("rounded-lg px-3 py-2 text-sm", m.role === "user" ? "ml-8 bg-secondary" : "mr-8 border")}>
              <p className="mb-1 text-2xs text-muted-foreground">
                {m.role} · {timeAgo(m.createdAt)}
              </p>
              <p className="line-clamp-4 whitespace-pre-wrap">{m.parts.map(p => p.text ?? (p.toolName ? `[${p.toolName}]` : "")).join(" ")}</p>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

/** One setting of the chat: what it is and which level chose it. */
function Chosen({ label, setting, emphasis }: { label: string; setting: Setting; emphasis?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <UriChip uri={setting.uri} emphasis={emphasis} />
        <span className="truncate text-muted-foreground">{sourceOf(setting)}</span>
      </dd>
    </>
  );
}

export const conversationKind: KindSpec = {
  kind: "conversation",
  label: "Chat",
  plural: "Chats",
  icon: MessagesSquare,
  accent: "bg-kind-conversation/12 text-kind-conversation",
  View: lazy(() => Promise.resolve({ default: ConversationView })),
  facts: r => {
    const n = (r.status as Partial<ConversationStatus> | undefined)?.messages;
    return n !== undefined ? [`${n} message${n === 1 ? "" : "s"}`] : [];
  },
};
