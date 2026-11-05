import type { ResourceMetadata } from "@texera/catalog-client/types";
import { timeAgo } from "@texera/ui";
import { kindEntry, type KindId } from "../types";

/**
 * The one-line summary under a resource's name: who can see it, head version, when. A built-in
 * is everyone's through its project, whatever its own visibility says.
 */
export function metaLine(kind: KindId, m: ResourceMetadata, extra: string[] = [], builtIn = false): string {
  return [
    builtIn ? "built-in" : m.visibility === "public" ? "public" : "private",
    ...(kindEntry(kind).versioned ? [m.head > 0 ? `v${m.head}` : "no version yet"] : []),
    `updated ${timeAgo(m.updatedAt)}`,
    ...extra,
  ].join(" · ");
}
