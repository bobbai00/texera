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

import { cn } from "cn";
import type { ReactNode } from "react";
import { PageLink, type PageTarget } from "@/components/layout/page-link";
import { Card } from "@/components/ui/card";
import { UserAvatar } from "@/components/user-avatar";
import { formatDate } from "@/lib/format";
import type { Resource } from "@/lib/resource";
import { resourceKinds, resourcePage } from "./kinds";
import { VisibilityBadge } from "./resource-badges";

/** How a list lays out its resources: a row for each, or a card for each. Each says the same either way. */
export type ResourceView = "list" | "cards";

export interface ResourceListProps<T extends Resource> {
  /** What the list holds, for assistive technology, such as "Datasets". */
  label: string;
  /** In the order to show them. They may be of different kinds. */
  resources: T[];
  view?: ResourceView;
  /** The buttons of each resource, such as its menu. */
  itemActions?: (resource: T) => ReactNode;
  /** What else each says about its resource, beside its name, such as where a computing unit stands. */
  itemDetails?: (resource: T) => ReactNode;
  /** Where each one's name leads: by default the resource's own page, for a kind whose resources have one. */
  itemPage?: (resource: T) => PageTarget | undefined;
  /** The list holds public resources only, such as the hub's, so none says that it is public. */
  publicOnly?: boolean;
}

/**
 * Resources of any kind: what each is, who owns it, and when it was made, in rows or in cards. Each name opens the
 * resource's page. The list fits the space it is given, not the screen: in a narrow place, such as a chat message,
 * a row's owner and date move under its name, and the cards stand in one column.
 */
export function ResourceList<T extends Resource>({
  label,
  resources,
  view = "list",
  itemActions,
  itemDetails,
  itemPage = resourcePage,
  publicOnly = false,
}: ResourceListProps<T>) {
  // A list of one kind says the kind once, in its name; an item says it only among items of other kinds.
  const mixed = new Set(resources.map(resource => resource.kind)).size > 1;
  const items = resources.map(resource => (
    <ResourceItem
      key={`${resource.kind}/${resource.id}`}
      view={view}
      resource={resource}
      kind={mixed}
      page={itemPage(resource)}
      details={
        <>
          {!publicOnly && <VisibilityBadge resource={resource} />}
          {itemDetails?.(resource)}
        </>
      }
      actions={itemActions?.(resource)}
      // A row without buttons keeps their place, so the owners and dates line up down the list.
      keepActionsPlace={itemActions !== undefined}
    />
  ));

  if (view === "cards") {
    return (
      <div className="@container">
        <ul
          aria-label={label}
          className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
          {items}
        </ul>
      </div>
    );
  }
  return (
    <Card className="gap-0 py-0">
      <ul
        aria-label={label}
        className="@container divide-y">
        {items}
      </ul>
    </Card>
  );
}

/** One resource, as a row or as a card: the same parts, laid out for each. */
function ResourceItem({
  view,
  resource,
  kind,
  page,
  details,
  actions,
  keepActionsPlace,
}: {
  view: ResourceView;
  resource: Resource;
  /** Whether to show the resource's kind. */
  kind: boolean;
  page?: PageTarget;
  details: ReactNode;
  actions: ReactNode;
  keepActionsPlace: boolean;
}) {
  const { icon: KindIcon } = resourceKinds[resource.kind];
  const nameClassName = "truncate font-medium";
  // A name that is cut off shows whole on hover.
  const name = page ? (
    <PageLink
      page={page}
      title={resource.name}
      className={cn(nameClassName, "hover:underline")}>
      {resource.name}
    </PageLink>
  ) : (
    <span
      title={resource.name}
      className={nameClassName}>
      {resource.name}
    </span>
  );
  const heading = (
    <div className="flex min-w-0 items-center gap-2">
      {kind && (
        <KindIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
      )}
      {name} {details}
    </div>
  );
  const description = resource.description && (
    <p className={cn("text-muted-foreground", view === "cards" ? "line-clamp-2" : "truncate")}>
      {resource.description}
    </p>
  );
  const owner = (
    <p className="flex min-w-0 items-center gap-2 text-muted-foreground">
      <UserAvatar name={resource.owner} />
      <span className="truncate">
        {resource.owner} · {formatDate(resource.createdAt)}
      </span>
    </p>
  );
  if (view === "cards") {
    return (
      <li className="flex min-w-0 flex-col gap-2 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">{heading}</div> {actions && <div className="-my-1 shrink-0">{actions}</div>}
        </div>{" "}
        {description} {/* The owners stand at the foot of the cards, level across a row of them. */}
        <div className="mt-auto pt-2">{owner}</div>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="grid min-w-0 flex-1 gap-x-6 gap-y-1 @2xl:grid-cols-[minmax(0,1fr)_auto] @2xl:items-center">
        <div className="min-w-0 space-y-0.5">
          {heading} {description}
        </div>{" "}
        {owner}
      </div>
      {(actions ?? keepActionsPlace) && <div className="flex w-8 shrink-0 justify-end">{actions}</div>}
    </li>
  );
}
