/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// The calls that are the same for every kind of resource: listing them, finding the one a path names, their
// versions, and who a resource is shared with. The answers are turned into the app's own shapes here, so the
// backend's words stop at this file: its privilege, READ or WRITE, is the app's access level, "view" or "edit", and
// its did, mid, wid, cuid, dvid and mvid are an id.

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ResourcePath } from "@/lib/resource-path";
import { publicKey } from "@/lib/session";
import {
  type AccessLevel,
  type Resource,
  type ResourceDeletion,
  type ResourceKind,
  type ResourceRef,
  type ResourceVersion,
  toAccessLevel,
} from "@/lib/resource";

// Query keys. Everything the cache holds about one resource nests under resourceKey, and every list of a kind
// under resourceListKey, so a change to a resource can refresh or forget all of it without knowing the queries.

/** The key that every query about one resource starts with. */
export function resourceKey({ kind, id }: ResourceRef) {
  return ["resources", kind, id] as const;
}

/** The key that every list of the resources of a kind starts with. */
export function resourceListKey(kind: ResourceKind) {
  return ["resources", kind, "list"] as const;
}

type Privilege = "NONE" | "READ" | "WRITE";

/** A dataset as every endpoint sends it (DashboardDataset), with the fields the app reads. */
export interface DatasetAnswer {
  dataset: { did: number; name: string; description: string | null; isPublic: boolean; creationTime: number };
  ownerEmail: string;
  /** "NONE" for a public dataset that is not shared with the user. */
  accessPrivilege: Privilege;
  isOwner: boolean;
}

/**
 * A model, which the server sends like a dataset (DashboardModel), with what it was made with and how it is saved,
 * null where its owner did not say.
 */
interface ModelAnswer extends Omit<DatasetAnswer, "dataset"> {
  model: {
    mid: number;
    name: string;
    description: string | null;
    isPublic: boolean;
    creationTime: number;
    framework: string | null;
    format: string | null;
  };
}

/** A workflow as the search sends it (DashboardWorkflow): owned by name, and without saying whether it is public. */
interface WorkflowAnswer {
  workflow: { wid: number; name: string; description: string | null; creationTime: number };
  ownerName: string;
  accessLevel: Privilege;
  isOwner: boolean;
}

/** The dataset of a server's answer, as a resource. */
export function fromDatasetAnswer({ dataset, ...answer }: DatasetAnswer): Resource {
  return fromVersionedAnswer("dataset", dataset.did, dataset, answer);
}

/** The model of a server's answer, as a resource, with what its owner said it was made with and how it is saved. */
function fromModelAnswer({ model, ...answer }: ModelAnswer): Model {
  const { framework, format } = model;
  return {
    ...fromVersionedAnswer("model", model.mid, model, answer),
    kind: "model",
    ...(framework && { framework }),
    ...(format && { format }),
  };
}

function fromVersionedAnswer(
  kind: VersionedKind,
  id: number,
  { name, description, isPublic, creationTime }: DatasetAnswer["dataset"] | ModelAnswer["model"],
  { ownerEmail, accessPrivilege, isOwner }: Omit<DatasetAnswer, "dataset">
): Resource {
  return {
    kind,
    id,
    name,
    description: description ?? "",
    owner: ownerEmail,
    isPublic,
    createdAt: creationTime,
    access: toAccessLevel({ isOwner, privilege: accessPrivilege, isPublic }),
  };
}

function fromWorkflowAnswer({ workflow, ownerName, accessLevel, isOwner }: WorkflowAnswer): Resource {
  return {
    kind: "workflow",
    id: workflow.wid,
    name: workflow.name,
    description: workflow.description ?? "",
    owner: ownerName,
    createdAt: workflow.creationTime,
    access: toAccessLevel({ isOwner, privilege: accessLevel }),
  };
}

/** The kinds the backend's search finds. Computing units are listed by their own service. */
export type SearchableKind = Exclude<ResourceKind, "computing-unit">;

/** The kinds whose resources have versions, of files, which workflows read by their paths (resource-path.ts). */
export type VersionedKind = ResourcePath["kind"];

/**
 * A model: what every resource has, and what it was made with, such as "PyTorch", and how it is saved, where its
 * owner said.
 */
export interface Model extends Resource {
  kind: "model";
  framework?: string;
  format?: string;
}

/** What each kind of resource is in the app: workflows and datasets are no more than a resource. */
interface ResourcesOfKinds {
  workflow: Resource;
  dataset: Resource;
  model: Model;
  "computing-unit": ComputingUnit;
}

export type ResourceOf<K extends ResourceKind> = ResourcesOfKinds[K];

/**
 * Whose resources are read: the user's, in their session, where a list holds their own and those shared with them,
 * and a lookup by a path finds everyone's public ones too; or everyone's public ones, which anyone may read, signed in
 * or not, kept under `publicKey`.
 */
export type ResourceScope = "yours" | "public";

/** The orders a list can be in, as the search names them. Every searchable kind has a name and a creation time. */
export const resourceOrders = {
  CreateTimeDesc: "Newest first",
  CreateTimeAsc: "Oldest first",
  NameAsc: "Name, A to Z",
  NameDesc: "Name, Z to A",
} as const;

export type ResourceOrder = keyof typeof resourceOrders;

export interface ResourceListSearch<K extends ResourceKind = ResourceKind> {
  kind: K;
  /** By default the user's own and those shared with them. */
  scope?: ResourceScope;
  /** Words to look for in names and descriptions. Without any, every resource is found. */
  keywords?: string;
  orderBy?: ResourceOrder;
}

/** A part of a list, as every list is read: some of its resources, and whether there are more after them. */
export interface ListedResources<T extends Resource = Resource> {
  resources: T[];
  more: boolean;
}

/** One entry of the search's answer (DashboardClickableFileEntry): only the field of its kind is there. */
interface SearchEntry {
  resourceType: SearchableKind;
  workflow?: WorkflowAnswer;
  dataset?: DatasetAnswer;
  model?: ModelAnswer;
}

/** The search returns this many resources at a time. */
const pageSize = 20;

/** How often a list is read again while one of its resources is changing, such as a unit that is starting. */
const changingIntervalMs = 3_000;

/**
 * The resources of a kind with the words asked for, in the order asked for, a part at a time: the user's, or the
 * public ones of everyone, which anyone may read, signed in or not. Workflows, datasets and models are found by
 * the one search the Dashboard Service has for them (DashboardResource.scala). Computing units are listed by their
 * own service, all at once, so they are found and ordered here. A list in which a resource is changing, such as a
 * unit that is starting or ending, is read again until none is.
 */
export function resourceListQuery<K extends ResourceKind>({
  kind,
  scope = "yours",
  keywords = "",
  orderBy = "CreateTimeDesc",
}: ResourceListSearch<K>) {
  const search = { keywords, orderBy };
  return infiniteQueryOptions({
    queryKey: scope === "public" ? [...publicKey, "hub", kind, search] : [...resourceListKey(kind), search],
    queryFn: ({ pageParam: start }) =>
      (kind === "computing-unit" ? listComputingUnits(search) : searchResources(kind, scope, search, start)) as Promise<
        ListedResources<ResourceOf<K>>
      >,
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => (lastPage.more ? pages.length * pageSize : undefined),
    refetchInterval: query =>
      query.state.data?.pages.some(page => page.resources.some(isChanging)) ? changingIntervalMs : false,
  });
}

/** What the search is asked for, besides the kind and whose resources it searches. */
interface Search {
  keywords: string;
  orderBy: ResourceOrder;
  /** The email of the one whose resources alone are found. */
  owner?: string;
  /** Whether everyone's public resources are found too, beside the user's own and those shared with them. */
  includePublic?: boolean;
}

async function searchResources(
  kind: SearchableKind,
  scope: ResourceScope,
  { keywords, orderBy, owner, includePublic }: Search,
  start: number,
  signal?: AbortSignal
): Promise<ListedResources<ResourceOf<SearchableKind>>> {
  const query = {
    resourceType: kind,
    query: keywords,
    orderBy,
    start,
    count: pageSize,
    ...(owner !== undefined && { owner }),
    ...(includePublic && { includePublic }),
  };
  const { results, more } = await api<{ results: SearchEntry[]; more: boolean }>(
    scope === "public" ? "/dashboard/publicSearch" : "/dashboard/search",
    { query, signal }
  );
  return { resources: results.map(fromSearchEntry), more };
}

/**
 * The dataset or the model that a path names, found by its owner and its name among those there are to read: those
 * the user may read, their own, the ones shared with them and the public ones, or, for someone who is not signed in
 * (`public`), the public ones alone. Null where it is none of them. The search is asked for every resource of the kind
 * of the owner's, without words, a page at a time until the name is there: it finds words, not names, and the name is
 * matched exactly, as the server reads a path (FileResolver.scala). It reads no further than a page that brings
 * nothing, whatever the search says of more, and stops asking once whoever asked has gone, as a chip that is closed.
 */
export function resourceLookupQuery(
  { kind, owner, name }: Pick<ResourcePath, "kind" | "owner" | "name">,
  scope: ResourceScope
) {
  return queryOptions({
    queryKey:
      scope === "public"
        ? [...publicKey, "hub", kind, "named", owner, name]
        : [...resourceListKey(kind), "named", owner, name],
    // A dataset, or a model, which says what it was made with and how it is saved.
    queryFn: async ({ signal }): Promise<(Resource & Partial<Pick<Model, "framework" | "format">>) | null> => {
      const search: Search = { keywords: "", orderBy: "NameAsc", owner, includePublic: scope === "yours" };
      for (let start = 0; ; start += pageSize) {
        const { resources, more } = await searchResources(kind, scope, search, start, signal);
        const found = resources.find(resource => resource.name === name && resource.owner === owner);
        if (found) return found;
        if (!more || resources.length === 0) return null;
      }
    },
  });
}

/**
 * A version as the server sends it (DatasetVersion, ModelVersion), by the id of its kind's. Its name is "v1", or
 * "v2 - " and the description it was made with.
 */
export type VersionAnswer = { name: string; creationTime: number } & ({ dvid: number } | { mvid: number });

/** The version of a server's answer, as a version of any kind. */
export function fromVersionAnswer(answer: VersionAnswer): ResourceVersion {
  return { id: "dvid" in answer ? answer.dvid : answer.mvid, name: answer.name, createdAt: answer.creationTime };
}

/**
 * The versions of a dataset or a model, newest first: of one the user may read, or of a public one, for someone who is
 * not signed in (`public`). They nest under the resource's key, so refreshing or forgetting it covers them.
 */
export function versionListQuery(resource: { kind: VersionedKind; id: number }, scope: ResourceScope = "yours") {
  const { kind, id } = resource;
  return queryOptions({
    queryKey: scope === "public" ? [...publicKey, "hub", kind, id, "versions"] : [...resourceKey(resource), "versions"],
    queryFn: async () =>
      (await api<VersionAnswer[]>(`/${kind}/${id}/${scope === "public" ? "publicVersion" : "version"}/list`))
        .map(fromVersionAnswer)
        .sort((a, b) => b.createdAt - a.createdAt),
  });
}

/** How each order sorts resources, for a list that is ordered here and not by the search. */
const orderings: Record<ResourceOrder, (a: Resource, b: Resource) => number> = {
  CreateTimeDesc: (a, b) => b.createdAt - a.createdAt,
  CreateTimeAsc: (a, b) => a.createdAt - b.createdAt,
  NameAsc: (a, b) => a.name.localeCompare(b.name),
  NameDesc: (a, b) => b.name.localeCompare(a.name),
};

async function listComputingUnits({
  keywords,
  orderBy,
}: {
  keywords: string;
  orderBy: ResourceOrder;
}): Promise<ListedResources<ComputingUnit>> {
  const words = keywords.toLowerCase().split(/\s+/).filter(Boolean);
  const units = (await fetchComputingUnits()).filter(unit => {
    const text = `${unit.name} ${unit.description}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
  return { resources: units.toSorted(orderings[orderBy]), more: false };
}

const isChanging = (resource: Resource) =>
  "status" in resource && (resource.status === "Pending" || resource.status === "Terminating");

/** Whether anyone may find a resource in the hub and open it. */
export function visibilityQuery(resource: ResourceRef) {
  return queryOptions({
    queryKey: [...resourceKey(resource), "visibility"],
    queryFn: () => isPublic(resource),
  });
}

async function isPublic({ kind, id }: ResourceRef): Promise<boolean> {
  if (kind === "workflow") return (await api<{ isPublished: boolean }>(`/workflow/${id}`)).isPublished;
  if (kind === "dataset") return (await api<DatasetAnswer>(`/dataset/${id}`)).dataset.isPublic;
  if (kind === "model") return (await api<ModelAnswer>(`/model/${id}`)).model.isPublic;
  return false;
}

/**
 * Makes a resource public, so that anyone finds it in the hub, or private again. A dataset's and a model's
 * publicity is turned over by its endpoint, whatever it is, so it is turned only when it is not as asked.
 */
export async function setPublic(resource: ResourceRef, makePublic: boolean): Promise<void> {
  const { kind, id } = resource;
  if (kind === "workflow") {
    return api(`/workflow/${makePublic ? "public" : "private"}/${id}`, { method: "PUT", responseType: "void" });
  }
  if (kind === "computing-unit") throw new Error("A computing unit cannot be public.");
  if ((await isPublic(resource)) === makePublic) return;
  return api(`/${kind}/${id}/update/publicity`, { method: "POST", responseType: "void" });
}

function fromSearchEntry({ workflow, dataset, model }: SearchEntry): ResourceOf<SearchableKind> {
  if (workflow) return fromWorkflowAnswer(workflow);
  if (dataset) return fromDatasetAnswer(dataset);
  if (model) return fromModelAnswer(model);
  throw new Error("The server sent a search result of a kind this app does not know.");
}

/** The access a resource can be shared at. Its owner has more, and is never one of the people it is shared with. */
export type SharedAccess = Extract<AccessLevel, "view" | "edit">;

/** A person a resource is shared with. */
export interface SharedWith {
  email: string;
  name: string;
  access: SharedAccess;
}

const sharedPrivileges: Record<SharedAccess, Privilege> = { view: "READ", edit: "WRITE" };

// Every kind is shared through the same four endpoints under /access/{kind}.

/** Everyone the resource is shared with, except its owner. */
export function sharedWithQuery(resource: ResourceRef) {
  const { kind, id } = resource;
  return queryOptions({
    queryKey: [...resourceKey(resource), "sharedWith"],
    queryFn: async (): Promise<SharedWith[]> => {
      const entries = await api<{ email: string; name: string; privilege: Privilege }[]>(`/access/${kind}/list/${id}`);
      return entries.map(({ email, name, privilege }) => ({
        email,
        name,
        access: privilege === "WRITE" ? "edit" : "view",
      }));
    },
  });
}

/** The owner's email, which the server sends as bare text. */
export function ownerQuery(resource: ResourceRef) {
  const { kind, id } = resource;
  return queryOptions({
    queryKey: [...resourceKey(resource), "owner"],
    queryFn: () => api<string>(`/access/${kind}/owner/${id}`, { responseType: "text" }),
  });
}

/** Shares the resource with the account that has this email, or changes what they may do with it. */
export function shareResource({ kind, id }: ResourceRef, email: string, access: SharedAccess): Promise<void> {
  return api(`/access/${kind}/grant/${id}/${encodeURIComponent(email)}/${sharedPrivileges[access]}`, {
    method: "PUT",
    responseType: "void",
  });
}

/** Stops sharing the resource with the account that has this email. */
export function unshareResource({ kind, id }: ResourceRef, email: string): Promise<void> {
  return api(`/access/${kind}/revoke/${id}/${encodeURIComponent(email)}`, { method: "DELETE", responseType: "void" });
}

/** A computing unit: where workflows are executed. */
export interface ComputingUnit extends Resource {
  kind: "computing-unit";
  /** As the unit reports it: "Running", "Pending", "Failed", "Terminating" or "Unknown". */
  status: string;
  /** A unit of the cluster, made for the user, or one that runs elsewhere, at an address. */
  type: "kubernetes" | "local";
  /** What the unit was made with, as the backend writes it, such as "2" CPUs and "4Gi". A local unit has none. */
  limits?: { cpu: string; memory: string; gpu: string };
}

/** A unit as the server sends it (DashboardWorkflowComputingUnit), with the fields the app reads. */
export interface ComputingUnitAnswer {
  computingUnit: { cuid: number; name: string; creationTime: number; type: string; resource: string };
  status: string;
  isOwner: boolean;
  accessPrivilege: Privilege;
  ownerName: string;
}

/**
 * All the computing units the user owns or that are shared with them, to pick one from. Their status changes, so
 * it is asked often.
 */
export function computingUnitListQuery() {
  return queryOptions({
    queryKey: [...resourceListKey("computing-unit"), "all"],
    queryFn: fetchComputingUnits,
    staleTime: 5_000,
  });
}

async function fetchComputingUnits(): Promise<ComputingUnit[]> {
  return (await api<ComputingUnitAnswer[]>("/computing-unit")).map(fromComputingUnitAnswer);
}

/** Ending a unit, which only its owner or an administrator may: it is what deleting it is. */
export const computingUnitDeletion: ResourceDeletion = {
  run: id => api(`/computing-unit/${id}/terminate`, { method: "DELETE", responseType: "void" }),
  consequence: "An execution on it stops, and the workflows executed on it need another unit.",
};

/** A unit of a server's answer, as a resource. */
export function fromComputingUnitAnswer({
  computingUnit,
  status,
  isOwner,
  accessPrivilege,
  ownerName,
}: ComputingUnitAnswer): ComputingUnit {
  const resource = JSON.parse(computingUnit.resource || "{}") as Record<string, string>;
  const { cpuLimit, memoryLimit, gpuLimit } = resource;
  // A local unit's limits are "NaN": the backend does not set them.
  const limited = computingUnit.type === "kubernetes" && cpuLimit && cpuLimit !== "NaN";
  return {
    kind: "computing-unit",
    id: computingUnit.cuid,
    name: computingUnit.name,
    description: "",
    owner: ownerName,
    createdAt: computingUnit.creationTime,
    access: toAccessLevel({ isOwner, privilege: accessPrivilege }),
    status,
    type: computingUnit.type === "kubernetes" ? "kubernetes" : "local",
    ...(limited && { limits: { cpu: cpuLimit, memory: memoryLimit, gpu: gpuLimit } }),
  };
}
