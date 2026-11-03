import type { ResourceMetadata } from "@texera/catalog-client/types";
import { timeAgo } from "@texera/ui";

/** The one-line summary under a resource's name: visibility, versions, when, by whom. */
export function metaLine(m: ResourceMetadata, extra: string[] = []): string {
  return [
    m.visibility === "public" ? "public" : "private",
    `v${m.headVersion}`,
    `updated ${timeAgo(m.updatedAt)}`,
    `by ${m.owner.slice(0, 8)}`,
    ...extra,
  ].join(" · ");
}
