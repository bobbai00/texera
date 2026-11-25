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

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import type { PageTarget } from "@/components/layout/page-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayed } from "@/components/use-delayed";
import type { ResourceDeletion, ResourceKind } from "@/lib/resource";
import { type ResourceOf, type ResourceOrder, type ResourceScope, resourceListQuery, resourceOrders } from "./api";
import { ResourceActions } from "./resource-actions";
import { ResourceList } from "./resource-list";
import { ResourceViewSwitch } from "./resource-view";
import { useResourceView } from "./use-resource-view";

export interface ResourceBrowserProps<K extends ResourceKind> {
  kind: K;
  /** By default the user's own and those shared with them. */
  scope?: ResourceScope;
  /** What the list holds, such as "Datasets" or "Public datasets". */
  label: string;
  /** How a resource of this kind is deleted. Without it, a resource's menu has no "Delete". */
  deletion?: ResourceDeletion;
  /** What else each item says about its resource. It is given every resource shown, to ask about all at once. */
  itemDetails?: (resource: ResourceOf<K>, shown: ResourceOf<K>[]) => ReactNode;
  /** Where each one's name leads: by default the resource's own page. */
  itemPage?: (resource: ResourceOf<K>) => PageTarget | undefined;
  /** What to show when there is no resource at all, such as the way to create the first. */
  empty: ReactNode;
}

/** How long the search waits after the last key before it asks the server. */
const searchDelayMs = 300;

/**
 * Resources of one kind: a search box, an order, a list or cards, and more of them on request. It is the same for
 * every kind and every list of one, and asks again for each change.
 */
export function ResourceBrowser<K extends ResourceKind>({
  kind,
  scope = "yours",
  label,
  deletion,
  itemDetails,
  itemPage,
  empty,
}: ResourceBrowserProps<K>) {
  const [search, setSearch] = useState("");
  const keywords = useDelayed(search.trim(), searchDelayMs);
  const [orderBy, setOrderBy] = useState<ResourceOrder>("CreateTimeDesc");
  const [view, setView] = useResourceView();
  const { data, error, isPlaceholderData, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...resourceListQuery({ kind, scope, keywords, orderBy }),
    // The last answer stays on screen until the next one is there.
    placeholderData: keepPreviousData,
  });
  const resources = data?.pages.flatMap(page => page.resources);

  if (resources?.length === 0 && keywords === "" && !isPlaceholderData) return empty;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder="Search by name or description"
            className="pl-8"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={orderBy}
            onValueChange={order => setOrderBy(order as ResourceOrder)}>
            <SelectTrigger aria-label="Order">
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="end">
              {Object.entries(resourceOrders).map(([order, orderLabel]) => (
                <SelectItem
                  key={order}
                  value={order}>
                  {orderLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ResourceViewSwitch
            view={view}
            onChange={setView}
          />
        </div>
      </div>
      <ErrorAlert error={error} />
      {resources === undefined ? (
        !error && <Skeleton className="h-32" />
      ) : resources.length === 0 ? (
        <EmptyState
          icon={SearchIcon}
          title={`No ${label.toLowerCase()} match “${keywords}”`}
        />
      ) : (
        <div
          aria-busy={isPlaceholderData}
          className="space-y-3 aria-busy:opacity-60">
          <ResourceList
            label={label}
            resources={resources}
            view={view}
            publicOnly={scope === "public"}
            itemPage={itemPage}
            itemDetails={itemDetails && (resource => itemDetails(resource, resources))}
            // The public resources of others are there to open, not to share or delete.
            itemActions={
              scope === "yours"
                ? resource => (
                    <ResourceActions
                      compact
                      resource={resource}
                      deletion={deletion}
                    />
                  )
                : undefined
            }
          />
          {hasNextPage && (
            <Button
              variant="outline"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}>
              Show more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
