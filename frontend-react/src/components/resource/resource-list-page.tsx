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

import type { ReactNode } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import { Page, PageHeader } from "@/components/layout/page";
import type { ResourceKind } from "@/lib/resource";
import { resourceKinds } from "./kinds";
import { ResourceBrowser, type ResourceBrowserProps } from "./resource-browser";

export interface ResourceListPageProps<K extends ResourceKind> extends Pick<
  ResourceBrowserProps<K>,
  "kind" | "scope" | "deletion" | "itemDetails" | "itemPage"
> {
  /** What the page says under its title, if it has more to say than that. */
  description?: string;
  /** The page's buttons, such as the one that creates a resource of the kind. */
  actions?: ReactNode;
  /** Something the page has to say above the list, such as why creating a resource failed. */
  notice?: ReactNode;
  /** What to tell a user when there is no resource to list yet. */
  emptyDescription: string;
}

/**
 * The page that lists resources of one kind: the user's own and those shared with them, or the hub's, which are
 * everyone's public ones. It is the same page for every kind and both lists.
 */
export function ResourceListPage<K extends ResourceKind>({
  kind,
  scope = "yours",
  description,
  actions,
  notice,
  emptyDescription,
  ...browser
}: ResourceListPageProps<K>) {
  const { plural, icon } = resourceKinds[kind];
  const title = scope === "public" ? `Public ${plural.toLowerCase()}` : plural;
  return (
    <Page>
      <PageHeader
        title={title}
        description={description}
        actions={actions}
      />
      {notice}
      <ResourceBrowser
        kind={kind}
        scope={scope}
        label={title}
        empty={
          <EmptyState
            icon={icon}
            title={`No ${title.toLowerCase()} yet`}
            description={emptyDescription}
          />
        }
        {...browser}
      />
    </Page>
  );
}
