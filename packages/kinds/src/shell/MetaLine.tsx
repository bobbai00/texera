import type { ResourceMetadata } from "@texera/catalog-client/types";
import { timeAgo } from "@texera/ui";
import { kindEntry, type KindId } from "../types";

/**
 * The one line under a resource's name: its head version and when it changed, and who can see
 * it when that is everyone. A built-in is everyone's through its project, whatever its own
 * visibility says; what is private says nothing, as nearly everything is.
 */
export function metaLine(kind: KindId, m: ResourceMetadata, extra: string[] = [], builtIn = false): string {
  return [
    ...(builtIn ? ["built-in"] : m.visibility === "public" ? ["public"] : []),
    ...(kindEntry(kind).versioned ? [m.head > 0 ? `v${m.head}` : "no version yet"] : []),
    `updated ${timeAgo(m.updatedAt)}`,
    ...extra,
  ].join(" · ");
}
