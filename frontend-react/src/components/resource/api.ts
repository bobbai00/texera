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

// The calls that are the same for every kind of resource: listing them, and who a resource is shared with. The
// answers are turned into the app's own shapes here, so the backend's words stop at this file: its privilege,
// READ or WRITE, is the app's access level, "view" or "edit", and its did, mid, wid and cuid are an id.

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { publicKey } from "@/lib/session";
import {
  type AccessLevel,
  type Resource,
  type ResourceDeletion,
  type ResourceKind,
  type ResourceRef,
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

/** A model, which the server sends like a dataset (DashboardModel). */
interface ModelAnswer extends Omit<DatasetAnswer, "dataset"> {
  model: { mid: number; name: string; description: string | null; isPublic: boolean; creationTime: number };
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

function fromVersionedAnswer(
  kind: "dataset" | "model",
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

/** What each kind of resource is in the app: every kind but computing units is no more than a resource. */
interface ResourcesOfKinds {
  workflow: Resource;
  dataset: Resource;
  model: Resource;
  "computing-unit": ComputingUnit;
}

export type ResourceOf<K extends ResourceKind> = ResourcesOfKinds[K];

/** Whose resources a list holds: the user's own and those shared with them, or everyone's public ones. */
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

async function searchResources(
  kind: SearchableKind,
  scope: ResourceScope,
  { keywords, orderBy }: { keywords: string; orderBy: ResourceOrder },
  start: number
): Promise<ListedResources> {
  const { results, more } = await api<{ results: SearchEntry[]; more: boolean }>(
    scope === "public" ? "/dashboard/publicSearch" : "/dashboard/search",
    { query: { resourceType: kind, query: keywords, orderBy, start, count: pageSize } }
  );
  return { resources: results.map(fromSearchEntry), more };
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

function fromSearchEntry({ workflow, dataset, model }: SearchEntry): Resource {
  if (workflow) return fromWorkflowAnswer(workflow);
  if (dataset) return fromDatasetAnswer(dataset);
  if (model) return fromVersionedAnswer("model", model.model.mid, model.model, model);
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
