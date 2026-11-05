// Queries shared by every kind: the caller, settings, envelopes, versions, lineage,
// grants, principals, search, units and operator types.

import { queryOptions } from "@tanstack/react-query";
import { resourcesRead, resourcesResolve } from "@texera/catalog-client";
import {
  computingUnitsAvailableOptions,
  conversationsSettingsOptions,
  meGetOptions,
  operatorsListOptions,
  principalsListOptions,
  projectsChatSettingsOptions,
  resourcesDependentsOptions,
  resourcesLineageOptions,
  resourcesListGrantsOptions,
  resourcesListVersionsOptions,
  resourcesSearchOptions,
  settingsRoutesReadOptions,
} from "@texera/catalog-client/query";
import type { LineageDirection, Resource, ResourceKind, SettingSource } from "@texera/catalog-client/types";
import { schemaMap } from "@texera/workflow-model";
import type { ResourceRef } from "./types";
import { baseUri } from "./uri";

export const meQuery = () => ({ ...meGetOptions(), staleTime: 5 * 60_000 });

export const settingsQuery = () => ({ ...settingsRoutesReadOptions(), staleTime: 5 * 60_000 });

/** The envelope of any catalog resource, by rid. */
export const resourceQuery = (rid: string) =>
  queryOptions({
    queryKey: ["resource", rid],
    queryFn: async () => (await resourcesRead({ path: { rid }, throwOnError: true })).data,
  });

/** What a URI names: the resource, and the version when the URI pins one. */
export const resolveQuery = (uri: string) =>
  queryOptions({
    queryKey: ["resolve", uri],
    queryFn: async () => (await resourcesResolve({ query: { uri }, throwOnError: true })).data,
    staleTime: 60_000,
  });

/** The envelope a URI names, ignoring its version. */
export const resourceByUriQuery = (uri: string) => ({ ...resolveQuery(baseUri(uri)), select: (r: { resource: Resource }) => r.resource });

export const versionsQuery = (rid: string, limit = 50) => resourcesListVersionsOptions({ path: { rid }, query: { limit } });

export const lineageQuery = (ref: ResourceRef, direction: LineageDirection = "both") =>
  resourcesLineageOptions({ path: { rid: ref.rid }, query: { direction, ...(ref.vno !== undefined ? { vno: ref.vno } : {}) } });

export const dependentsQuery = (rid: string) => resourcesDependentsOptions({ path: { rid } });

export const grantsQuery = (rid: string) => resourcesListGrantsOptions({ path: { rid } });

export const principalsQuery = (q?: string) => ({ ...principalsListOptions({ query: { q: q || undefined, limit: 20 } }), staleTime: 60_000 });

export interface SearchFilter {
  kind?: ResourceKind;
  /** A project and what it inherits, the platform's built-ins; absent narrows nothing. */
  scope?: string;
  parent?: string;
  /** Exactly a project's own resources. */
  project?: string;
  q?: string;
  origin?: string;
  limit?: number;
}

export const searchQuery = (filter: SearchFilter) => resourcesSearchOptions({ query: { limit: 100, ...filter } });

/** The units the caller may run on, in a scope. */
export const unitsQuery = (scope?: string) => ({ ...computingUnitsAvailableOptions({ query: { scope } }), staleTime: 30_000 });

/**
 * What a turn of a chat runs with: its agent, model, computing unit and MCP servers, each the
 * chat's choice or the default it falls back to. The catalog resolves it; the app only shows it.
 */
export const chatSettingsQuery = (rid: string) => ({ ...conversationsSettingsOptions({ path: { rid } }), staleTime: 30_000 });

/** Which level chose a setting of a chat, in words. */
export const SOURCE_LABEL: Record<SettingSource, string> = {
  chat: "chosen for this chat",
  project: "the project's default",
  agent: "the agent's own",
  platform: "the platform's default",
};

/** The same for a chat that is not started yet, in a project. */
export const newChatSettingsQuery = (project: string) => ({ ...projectsChatSettingsOptions({ path: { rid: project } }), staleTime: 30_000 });

/** Every operator type usable in a scope, with its properties schema, as the editor's schemas. */
export const operatorSchemasQuery = (scope?: string) => ({
  ...operatorsListOptions({ query: { view: "full", limit: 500, scope } }),
  select: (page: { items: Parameters<typeof schemaMap>[0] }) => schemaMap(page.items),
  staleTime: 10 * 60_000,
});

/**
 * The query keys a write to a resource invalidates: its envelope, every kind list, its
 * versions, and what chats resolve their settings to (a default or a choice may have changed).
 */
export const keysOf = (rid: string) => [
  ["resource", rid],
  [{ _id: "resourcesSearch" }],
  [{ _id: "resourcesListVersions", path: { rid } }],
  [{ _id: "conversationsSettings" }],
  [{ _id: "projectsChatSettings" }],
];
