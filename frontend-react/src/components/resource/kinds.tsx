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

import { linkOptions } from "@tanstack/react-router";
import { BoxIcon, DatabaseIcon, type LucideIcon, ServerIcon, WorkflowIcon } from "lucide-react";
import type { PageTarget } from "@/components/layout/page-link";
import type { ResourceKind, ResourceRef } from "@/lib/resource";

/** What the app needs to know about a kind of resource to name it, draw it, and link to it. */
export interface ResourceKindInfo {
  /** The name of the kind's list, and of its place in the navigation. */
  plural: string;
  icon: LucideIcon;
  /** The page that lists the user's resources of the kind. */
  listPage: PageTarget;
  /** The page of one resource of the kind, for a kind whose resources have one. */
  page?: (id: number) => PageTarget;
  /** Whether a resource of the kind can be public, for anyone to find in the hub and open. */
  canBePublic: boolean;
}

/**
 * Every kind of resource. This is the one place that says which pages of a kind are in React: the others point
 * to the Angular app, by the paths of its app-routing.constant.ts.
 */
export const resourceKinds = {
  workflow: {
    plural: "Workflows",
    icon: WorkflowIcon,
    listPage: linkOptions({ to: "/workflows" }),
    page: id => linkOptions({ to: "/workflows/$workflowId", params: { workflowId: id } }),
    canBePublic: true,
  },
  dataset: {
    plural: "Datasets",
    icon: DatabaseIcon,
    listPage: linkOptions({ to: "/datasets" }),
    page: id => linkOptions({ to: "/datasets/$datasetId", params: { datasetId: id } }),
    canBePublic: true,
  },
  model: {
    plural: "Models",
    icon: BoxIcon,
    listPage: linkOptions({ to: "/models" }),
    page: id => ({ angularPath: `/user/model/${id}` }),
    canBePublic: true,
  },
  "computing-unit": {
    plural: "Computing units",
    icon: ServerIcon,
    listPage: linkOptions({ to: "/computing-units" }),
    // A unit has no page of its own: all there is to it is in the list.
    canBePublic: false,
  },
} satisfies Record<ResourceKind, ResourceKindInfo>;

/** The page of a resource of any kind, if its kind has pages. */
export function resourcePage({ kind, id }: ResourceRef): PageTarget | undefined {
  const { page }: ResourceKindInfo = resourceKinds[kind];
  return page?.(id);
}
