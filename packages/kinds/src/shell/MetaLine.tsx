import type { ResourceMetadata } from "@texera/catalog-client/types";
import { kindEntry, type KindId } from "../types";

/**
 * The one line under a resource's name: its head version, and who can see it when that is
 * everyone; what is private says nothing, as nearly everything is.
 */
export function metaLine(kind: KindId, m: ResourceMetadata, extra: string[] = []): string {
  return [
    ...(m.visibility === "public" ? ["public"] : []),
    ...(kindEntry(kind).versioned ? [m.head > 0 ? `v${m.head}` : "no version yet"] : []),
    ...extra,
  ].join(" · ");
}
