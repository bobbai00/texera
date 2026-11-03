import { useQuery } from "@tanstack/react-query";
import { conversationsMessagesOptions, conversationsResourcesOptions } from "@texera/catalog-client/query";
import { Button, EmptyState, ErrorNote, SectionTitle, Skeleton, cn, timeAgo } from "@texera/ui";
import { ArrowUpRight } from "lucide-react";
import { ResourceCard } from "../ResourceView";
import { KindHeader } from "../shell/KindHeader";
import { metaLine } from "../shell/MetaLine";
import { useOpenResource } from "../shell/navigation";
import type { KindViewProps } from "../types";
import { isKindId } from "../registry";
import { conversationQuery } from "./spec";

/** A chat seen from outside: its last messages and the resources it produced; the chat page itself is the app's. */
export default function ConversationView({ ref, mode }: KindViewProps) {
  const { data, error } = useQuery(conversationQuery(ref.rid));
  const { data: messages } = useQuery(conversationsMessagesOptions({ path: { rid: ref.rid }, query: { limit: 20 } }));
  const { data: resources } = useQuery(conversationsResourcesOptions({ path: { rid: ref.rid } }));
  const { expand } = useOpenResource();
  if (error) return <ErrorNote error={error} prefix="Could not open this chat" className="m-4" />;
  if (!data) return <Skeleton className="m-4 h-64" />;
  return (
    <div className="flex h-full min-h-0 flex-col" data-conversation-view={ref.rid}>
      <KindHeader
        ref={{ kind: "conversation", rid: ref.rid }}
        mode={mode}
        name={data.metadata.name}
        meta={metaLine(data.metadata)}
        actions={
          <Button size="sm" onClick={() => expand({ kind: "conversation", rid: ref.rid })}>
            <ArrowUpRight /> Open chat
          </Button>
        }
      />
      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto p-4">
        <section className="space-y-2">
          <SectionTitle>Resources from this chat</SectionTitle>
          {!resources?.length && <EmptyState className="py-4">Nothing produced yet.</EmptyState>}
          {resources?.map(r =>
            isKindId(r.kind) ? <ResourceCard key={r.metadata.rid} ref={{ kind: r.kind, rid: r.metadata.rid }} resource={r} /> : null
          )}
        </section>
        <section className="space-y-2">
          <SectionTitle>Recent messages</SectionTitle>
          {!messages?.length && <EmptyState className="py-4">No messages yet.</EmptyState>}
          {messages?.map(m => (
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
