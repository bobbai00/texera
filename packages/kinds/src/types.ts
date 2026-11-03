// The contract every kind module fulfils. The registry maps a kind to its module; the
// chat, the library, the side panel and the full page render through `ResourceView`.

import type { QueryClient } from "@tanstack/react-query";
import type { Resource, ResourceKind } from "@texera/catalog-client/types";
import type { LucideIcon } from "lucide-react";
import type { ComponentType, LazyExoticComponent } from "react";

/** Catalog resource kinds plus executions, which have their own ids and routes. */
export type KindId = ResourceKind | "execution";

export const KIND_IDS: readonly KindId[] = [
  "conversation",
  "workflow",
  "dataset",
  "execution",
  "agent_template",
  "mcp_server",
  "computing_unit",
  "environment",
  "project",
  "skill",
] as const;

export interface ResourceRef {
  kind: KindId;
  rid: string;
  vno?: number;
}

export type ViewMode = "card" | "panel" | "page";

export interface KindCardProps {
  ref: ResourceRef;
  /** The envelope, when the caller already has it (lists); the card fetches it otherwise. */
  resource?: Resource;
}

export interface KindViewProps {
  ref: ResourceRef;
  mode: "panel" | "page";
}

export interface CreateInput {
  name: string;
  description?: string;
  project?: string;
}

export interface KindSpec {
  kind: KindId;
  label: string;
  plural: string;
  /** URL segment of the page: `/w/{rid}`. */
  slug: string;
  /** URL segment of the library list: `/library/workflows`. */
  librarySlug: string;
  icon: LucideIcon;
  /** Tailwind classes for the kind's icon chip, from the kind's accent token. */
  accent: string;
  Card: LazyExoticComponent<ComponentType<KindCardProps>>;
  View: LazyExoticComponent<ComponentType<KindViewProps>>;
  /** Starts the view's requests while its code loads. */
  prefetch?: (queryClient: QueryClient, ref: ResourceRef) => Promise<unknown>;
  /** Creates an empty resource of the kind; absent for kinds made elsewhere (runs, chats). */
  create?: (input: CreateInput) => Promise<ResourceRef>;
  /** Short facts for lists and cards, from the envelope. */
  facts?: (resource: Resource) => string[];
}

export const refKey = (r: ResourceRef) => `${r.kind}:${r.rid}${r.vno !== undefined ? `@${r.vno}` : ""}`;
