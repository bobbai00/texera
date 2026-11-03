// Queries shared by every kind: the caller, the envelope, versions, lineage, operators.

import { queryOptions } from "@tanstack/react-query";
import { executionsRead, resourcesRead } from "@texera/catalog-client";
import {
  computingUnitsAvailableOptions,
  meGetOptions,
  operatorsListOptions,
  resourcesLineageOptions,
  resourcesListVersionsOptions,
  resourcesSearchOptions,
} from "@texera/catalog-client/query";
import type { Resource, ResourceKind } from "@texera/catalog-client/types";
import { fromCatalogOperators, schemaMap } from "@texera/workflow-model";
import type { ResourceRef } from "./types";

export const meQuery = () => ({ ...meGetOptions(), staleTime: 5 * 60_000 });

/** The envelope of any catalog resource. */
export const resourceQuery = (rid: string) =>
  queryOptions({
    queryKey: ["resource", rid],
    queryFn: async () => (await resourcesRead({ path: { rid }, throwOnError: true })).data,
  });

/** Runs are not catalog resources; this gives them an envelope-like summary for cards and lists. */
export const executionSummaryQuery = (eid: string) =>
  queryOptions({
    queryKey: ["execution-summary", eid],
    queryFn: async () => (await executionsRead({ path: { eid }, throwOnError: true })).data,
  });

export const versionsQuery = (rid: string, limit = 50) =>
  resourcesListVersionsOptions({ path: { rid }, query: { limit } });

export const lineageQuery = (ref: ResourceRef) =>
  resourcesLineageOptions({ path: { rid: ref.rid }, query: ref.vno !== undefined ? { vno: ref.vno } : undefined });

export const searchQuery = (filter: { kind?: ResourceKind; project?: string; q?: string; origin?: string; limit?: number }) =>
  resourcesSearchOptions({ query: { limit: 100, ...filter } });

export const unitsQuery = () => ({ ...computingUnitsAvailableOptions(), staleTime: 30_000 });

/** Operator types from the registry, as the editor's schemas. */
export const operatorsQuery = () => ({
  ...operatorsListOptions(),
  select: fromCatalogOperators,
  staleTime: 10 * 60_000,
});

export const operatorSchemasQuery = () => ({
  ...operatorsListOptions(),
  select: (list: Parameters<typeof fromCatalogOperators>[0]) => schemaMap(fromCatalogOperators(list)),
  staleTime: 10 * 60_000,
});

/** The owner's display name is on the principal; lists show the pid's prefix until principals are joined. */
export const describeOwner = (r: Resource) => r.metadata.owner.slice(0, 8);
