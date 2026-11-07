// Queries shared by every kind: the caller, settings, envelopes, versions, lineage,
// grants, principals, search, units and operator types.

import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { evaluationEvaluate, operatorsList, resourcesRead, resourcesResolve, resourcesSearch } from "@texera/catalog-client";
import {
  computingUnitsAvailableOptions,
  conversationsSettingsOptions,
  meGetOptions,
  principalsListOptions,
  projectsChatSettingsOptions,
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
/** A resource as the catalog has it this moment, past any cache: for a write that must start from it. */
export const readResource = async (rid: string): Promise<Resource> => (await resourcesRead({ path: { rid }, throwOnError: true })).data;

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

export const grantsQuery = (rid: string) => resourcesListGrantsOptions({ path: { rid } });

/** Whether the caller may do something to a resource: the catalog's own decision. */
export const canQuery = (action: "read" | "write" | "share" | "delete", rid: string) =>
  queryOptions({
    queryKey: ["can", action, rid],
    queryFn: async () => (await evaluationEvaluate({ body: { subject: { type: "user", id: "" }, action: { name: action }, resource: { type: "resource", id: rid } }, throwOnError: true })).data.decision,
    staleTime: 60_000,
  });

export const principalsQuery = (q?: string) => ({ ...principalsListOptions({ query: { q: q || undefined, limit: 20 } }), staleTime: 60_000 });

export interface SearchFilter {
  kind?: ResourceKind;
  /** A project and what it inherits, the platform's built-ins; absent narrows nothing. */
  scope?: string;
  parent?: string;
  /** Exactly a project's own resources. */
  project?: string;
  /** Only what other people shared with the person, in whatever project. */
  shared?: boolean;
  q?: string;
  origin?: string;
  limit?: number;
}

export const searchQuery = (filter: SearchFilter) => resourcesSearchOptions({ query: { limit: 100, ...filter } });

/** How many a list reads at most: past this a list is searched, not scrolled. */
const LIST_AT_MOST = 2000;

/**
 * Every resource a filter finds, page after page, for a list that shows them all (a library):
 * a single page would stop at 100 and look complete.
 */
export const searchAllQuery = (filter: Omit<SearchFilter, "limit">) =>
  queryOptions({
    // Under the search's own key, so whatever asks the searches again after a change asks this too.
    queryKey: [{ _id: "resourcesSearch", all: true, query: filter }],
    queryFn: async () => {
      const items: Resource[] = [];
      for (let cursor: string | undefined; ; ) {
        const page = (await resourcesSearch({ query: { ...filter, limit: 200, ...(cursor ? { cursor } : {}) }, throwOnError: true })).data;
        items.push(...page.items);
        if (!page.nextCursor || items.length >= LIST_AT_MOST) return { items };
        cursor = page.nextCursor;
      }
    },
  });

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

/**
 * Every operator type usable in a scope, with its properties schema, as the editor's schemas.
 * The list comes a page at a time, and the palette needs all of it.
 */
export const operatorSchemasQuery = (scope?: string) =>
  queryOptions({
    queryKey: ["operator-schemas", scope ?? null],
    queryFn: async () => {
      const operators: Parameters<typeof schemaMap>[0] = [];
      for (let cursor: string | undefined; ; ) {
        const page = (await operatorsList({ query: { view: "full", limit: 200, scope, cursor }, throwOnError: true })).data;
        operators.push(...page.items);
        if (!page.nextCursor) return schemaMap(operators);
        cursor = page.nextCursor;
      }
    },
    staleTime: 10 * 60_000,
  });

/**
 * The query keys a write to a resource invalidates: its envelope, every kind list, its
 * versions, and what chats resolve their settings to (a default or a choice may have changed).
 */
/** Whether a query read something of one resource: its envelope, whatever was read by its rid, what the person may do with it. */
export function isAbout(queryKey: readonly unknown[], rid: string): boolean {
  const [first, second, third] = queryKey;
  if (first === "resource") return second === rid;
  if (first === "can") return third === rid;
  return typeof first === "object" && first !== null && (first as { path?: { rid?: unknown } }).path?.rid === rid;
}

/**
 * Has everything the app read about a resource asked again. A view turned away from the
 * resource's watch or its live session calls this: what the person may see has changed, and
 * the catalog's answer is what the view then shows.
 */
export const askAgain = (queryClient: QueryClient, rid: string) => queryClient.invalidateQueries({ predicate: query => isAbout(query.queryKey, rid) });

export const keysOf = (rid: string) => [
  ["resource", rid],
  [{ _id: "resourcesSearch" }],
  [{ _id: "resourcesListVersions", path: { rid } }],
  [{ _id: "conversationsSettings" }],
  [{ _id: "projectsChatSettings" }],
];
