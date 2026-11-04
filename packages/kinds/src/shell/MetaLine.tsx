import type { ResourceMetadata } from "@texera/catalog-client/types";
import { timeAgo } from "@texera/ui";
import { kindEntry, type KindId } from "../types";

/** The one-line summary under a resource's name: visibility, head version, when, by whom. */
export function metaLine(kind: KindId, m: ResourceMetadata, extra: string[] = []): string {
  return [
    m.visibility === "public" ? "public" : "private",
    ...(kindEntry(kind).versioned ? [m.head > 0 ? `v${m.head}` : "no version yet"] : []),
    `updated ${timeAgo(m.updatedAt)}`,
    ...extra,
  ].join(" · ");
}
