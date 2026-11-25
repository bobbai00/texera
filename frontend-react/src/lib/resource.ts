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

// What every kind of resource has in common. Workflows, datasets, models and computing units are each owned by
// one user, shared with others at an access level, and listed, opened, shared and deleted in the same way. A
// feature's api.ts turns the backend's answer for its kind into this shape, so the shared components in
// components/resource/ never read a kind's own field names.

/** The kinds of resources, named as the backend's access endpoints name them. */
export type ResourceKind = "workflow" | "dataset" | "model" | "computing-unit";

/** A resource by its kind and id: all the backend needs to find it. */
export interface ResourceRef {
  kind: ResourceKind;
  id: number;
}

/** What the signed-in user may do with a resource. Each level includes the ones before it. */
export const accessLevels = ["none", "view", "edit", "owner"] as const;
export type AccessLevel = (typeof accessLevels)[number];

/** How the app words each access level, wherever it shows one. */
export const accessLabels: Record<AccessLevel, string> = {
  none: "No access",
  view: "Can view",
  edit: "Can edit",
  owner: "Owner",
};

/** A resource of any kind, as the signed-in user sees it. */
export interface Resource extends ResourceRef {
  name: string;
  description: string;
  /** Who owns it, as the backend names them: by name for a workflow, by email for a dataset or a model. */
  owner: string;
  /** Whether anyone signed in may view it. Undefined where the backend does not say, as for a workflow in a list. */
  isPublic?: boolean;
  /** In epoch milliseconds. */
  createdAt: number;
  access: AccessLevel;
}

/** A saved state of a resource that can be opened again. */
export interface ResourceVersion {
  id: number;
  name: string;
  /** In epoch milliseconds. */
  createdAt: number;
}

/** How a resource of one kind is deleted: the one thing about deleting that differs between the kinds. */
export interface ResourceDeletion {
  /** The call that deletes the resource with this id. */
  run: (id: number) => Promise<void>;
  /** What goes with the resource, such as "Its versions and files are deleted too." */
  consequence?: string;
}

/** The access level the backend's three answers add up to: who owns it, what was granted, and whether it is public. */
export function toAccessLevel(answer: {
  isOwner: boolean;
  privilege: "NONE" | "READ" | "WRITE";
  isPublic?: boolean;
}): AccessLevel {
  if (answer.isOwner) return "owner";
  if (answer.privilege === "WRITE") return "edit";
  if (answer.privilege === "READ" || answer.isPublic) return "view";
  return "none";
}

/** What a user can do with a resource, and the least access level each takes. The backend enforces the same. */
const requiredAccess = {
  view: "view",
  edit: "edit",
  share: "edit",
  delete: "owner",
} as const satisfies Record<string, AccessLevel>;

export type ResourceAction = keyof typeof requiredAccess;

/** Whether the signed-in user may do this with the resource. Every button that acts on a resource asks here. */
export function can(resource: Pick<Resource, "access">, action: ResourceAction): boolean {
  return accessLevels.indexOf(resource.access) >= accessLevels.indexOf(requiredAccess[action]);
}
