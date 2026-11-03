import { conversationsReadOptions } from "@texera/catalog-client/query";
import type { ConversationStatus } from "@texera/catalog-client/types";
import { MessagesSquare } from "lucide-react";
import { lazy } from "react";
import type { KindSpec } from "../types";

export const conversationQuery = (rid: string) => conversationsReadOptions({ path: { rid } });

export const conversationKind: KindSpec = {
  kind: "conversation",
  label: "Chat",
  plural: "Chats",
  slug: "c",
  librarySlug: "chats",
  icon: MessagesSquare,
  accent: "bg-kind-conversation/12 text-kind-conversation",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) => qc.prefetchQuery(conversationQuery(ref.rid)),
  facts: r => {
    const n = (r.status as Partial<ConversationStatus> | undefined)?.messages;
    return n !== undefined ? [`${n} message${n === 1 ? "" : "s"}`] : [];
  },
};
