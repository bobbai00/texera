// A chat seen from outside: the template it runs, its last messages and the resources it
// produced. The chat page itself is the app's.

import { useQuery } from "@tanstack/react-query";
import { conversationsListMessagesOptions, conversationsResourcesOptions } from "@texera/catalog-client/query";
import type { ConversationSpec, ConversationStatus } from "@texera/catalog-client/types";
import { Button, EmptyState, ErrorNote, SectionTitle, Skeleton, cn, timeAgo } from "@texera/ui";
import { ArrowUpRight, MessagesSquare } from "lucide-react";
import { lazy } from "react";
import { resourceQuery } from "../queries";
import { ResourceCard } from "../ResourceView";
import { UriChip } from "../shell/Chips";
import { KindHeader } from "../shell/KindHeader";
import { metaLine } from "../shell/MetaLine";
import { useOpenResource } from "../shell/navigation";
import type { KindSpec, KindViewProps } from "../types";
import { isKindId } from "../registry";

function ConversationView({ ref, mode }: KindViewProps) {
  const { data, error } = useQuery(resourceQuery(ref.rid));
  const { data: messages } = useQuery(conversationsListMessagesOptions({ path: { rid: ref.rid }, query: { limit: 20 } }));
  const { data: resources } = useQuery(conversationsResourcesOptions({ path: { rid: ref.rid } }));
  const { expand } = useOpenResource();
  if (error) return <ErrorNote error={error} prefix="Could not open this chat" className="m-4" />;
  if (!data) return <Skeleton className="m-4 h-64" />;
  const spec = data.spec as ConversationSpec;
  return (
    <div className="flex h-full min-h-0 flex-col" data-conversation-view={ref.rid}>
      <KindHeader
        ref={{ kind: "conversation", rid: ref.rid }}
        mode={mode}
        name={data.metadata.name}
        meta={metaLine("conversation", data.metadata)}
        actions={
          <Button size="sm" onClick={() => expand({ kind: "conversation", rid: ref.rid })}>
            <ArrowUpRight /> Open chat
          </Button>
        }
      />
      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto p-4">
        <section className="space-y-2">
          <SectionTitle>Agent template</SectionTitle>
          <UriChip uri={spec.template} emphasis />
        </section>
        <section className="space-y-2">
          <SectionTitle>Resources from this chat</SectionTitle>
          {!resources?.length && <EmptyState className="py-4">Nothing produced yet.</EmptyState>}
          {resources?.map(r =>
            isKindId(r.kind) ? <ResourceCard key={r.metadata.rid} ref={{ kind: r.kind, rid: r.metadata.rid, parent: r.metadata.parent }} resource={r} /> : null
          )}
        </section>
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
