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

import { Fragment, type ReactNode } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Skeleton } from "@/components/ui/skeleton";
import { PageLink, type PageTarget } from "./page-link";

/** A page's content: one column of a readable width, in the middle of the space the shell leaves. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl space-y-6">{children}</div>;
}

export interface PageHeaderProps {
  /** The pages above this one, nearest last, such as the list a resource belongs to. */
  parents?: { label: string; page: PageTarget }[];
  title: string;
  /** Short labels beside the title, such as "Public". */
  badges?: ReactNode;
  description?: string;
  /** Small facts under the title, such as the owner and the date. */
  meta?: ReactNode;
  /** The page's buttons. */
  actions?: ReactNode;
}

/** The top of every page: where it is, what it is, and what the user can do with it. */
export function PageHeader({ parents = [], title, badges, description, meta, actions }: PageHeaderProps) {
  return (
    <div className="space-y-2">
      {parents.length > 0 && (
        <Breadcrumb>
          <BreadcrumbList>
            {parents.map(({ label, page }) => (
              <Fragment key={label}>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <PageLink page={page}>{label}</PageLink>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* A name may be 128 characters with no space to break at. */}
            <h1 className="text-2xl font-semibold tracking-tight wrap-anywhere">{title}</h1>
            {badges}
          </div>
          {description && <p className="max-w-3xl text-muted-foreground">{description}</p>}
          {meta && <p className="text-sm text-muted-foreground">{meta}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** What a page shows while its data loads: the outline of a title and a few rows. */
export function PagePending() {
  return (
    <Page>
      <div
        role="status"
        aria-label="Loading"
        className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="space-y-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      </div>
    </Page>
  );
}
