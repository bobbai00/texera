// The contract every kind module fulfils. The registry maps a kind to its module; the
// chat, the library, the side panel and the full page render through `ResourceView`.
// What the contract knows about a kind (plural, versioned, nested) comes from the
// generated kind table; a module adds what the app knows (icon, forms, cards).

import type { QueryClient } from "@tanstack/react-query";
import type { Defaults, Resource, ResourceKind } from "@texera/catalog-client/types";
import type { LucideIcon } from "lucide-react";
import type { ComponentType, LazyExoticComponent } from "react";
import { KIND_TABLE, type KindEntry } from "./kinds.gen";

/** The kinds, as the contract names them. */
export type KindId = ResourceKind;

export const KIND_IDS: readonly KindId[] = KIND_TABLE.map(k => k.kind as KindId);

/** The contract's facts about a kind. */
export const kindEntry = (kind: KindId): KindEntry => KIND_TABLE.find(k => k.kind === kind) as KindEntry;

/**
 * A reference to a resource, or to one of its versions. `parent` is the parent's rid of a
 * nested kind (the workflow of an execution); it is known once the envelope has been read.
 */
export interface ResourceRef {
  kind: KindId;
  rid: string;
  vno?: number;
  parent?: string;
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

/** A kind-specific tab of the generic page. */
export interface KindTab {
  value: string;
  label: string;
  icon?: LucideIcon;
  Component: ComponentType<{ resource: Resource; ref: ResourceRef; mode: "panel" | "page" }>;
}

export interface CreateInput {
  name: string;
  description?: string;
  /** The project; the caller's home project when absent. */
  parent?: string;
}

export interface KindSpec {
  kind: KindId;
  label: string;
  plural: string;
  icon: LucideIcon;
  /** Tailwind classes for the kind's icon chip, from the kind's accent token. */
  accent: string;
  /** Replaces the generic card. */
  Card?: LazyExoticComponent<ComponentType<KindCardProps>>;
  /** Replaces the generic page and panel. */
  View?: LazyExoticComponent<ComponentType<KindViewProps>>;
  /** Replaces the schema form in the generic page's spec tab. */
  Editor?: ComponentType<{ resource: Resource; readonly?: boolean }>;
  /** Tabs the generic page shows before the shared ones (spec, versions, access, lineage). */
  tabs?: KindTab[];
  /** Header actions of the generic page; `readonly` when the resource is not the caller's to change. */
  Actions?: ComponentType<{ resource: Resource; readonly?: boolean }>;
  /** The spec a new resource starts with; absent for kinds made elsewhere (executions, chats). */
  defaultSpec?: (input: CreateInput, defaults: Defaults) => unknown;
  /**
   * What the "New" dialog asks for besides a name, for a kind whose first spec depends on a
   * choice (the size of a unit). It is given the starting spec and reports the one to create.
   */
  CreateFields?: ComponentType<{ spec: unknown; onChange: (spec: unknown) => void }>;
  /** Short facts for lists and cards, from the envelope. */
  facts?: (resource: Resource) => string[];
  /** Spec fields the schema form shows as multi-line text, by property name. */
  long?: string[];
  /** Spec fields the schema form does not show (set by the platform). */
  hidden?: string[];
  /** Starts the view's requests while its code loads. */
  prefetch?: (queryClient: QueryClient, ref: ResourceRef) => Promise<unknown>;
}

export const refKey = (r: ResourceRef) => `${r.kind}:${r.rid}${r.vno !== undefined ? `@${r.vno}` : ""}`;
