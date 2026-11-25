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

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { type ReactNode, useId } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { PageLink, type PageTarget } from "@/components/layout/page-link";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UserAvatar } from "@/components/user-avatar";
import type { Resource } from "@/lib/resource";
import { type ResourcePath, resourcePath } from "@/lib/resource-path";
import { type Model, resourceLookupQuery, type ResourceScope, versionListQuery } from "./api";
import { type ResourceKindInfo, resourceKinds, resourcePage } from "./kinds";

export interface ResourceChipProps {
  /** The version that is read, and the file in it, where the path names one. */
  path: ResourcePath;
  /**
   * Whose resources it is looked up among once it is opened: those the user may read, or, for someone who is not
   * signed in, the public ones.
   */
  scope?: ResourceScope;
  /** More classes for the chip, as the place it is drawn in needs. */
  className?: string;
}

/**
 * A version of a dataset or a model that something reads, such as an operator of a workflow, by the path that names
 * it: in its kind's color, the kind's picture, the resource's name and the version's, with the whole path as its
 * title. It is drawn from the path alone, so it shows for everyone, whatever they may read. A click opens what the path
 * says, and what the backend says of the resource, which is asked only then: its description, what a model was made
 * with and how it is saved, and a link to its page, at that version where the page shows one.
 */
export function ResourceChip({ path, scope = "yours", className }: ResourceChipProps) {
  const { icon: Icon, tone }: ResourceKindInfo = resourceKinds[path.kind];
  const title = useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={resourcePath(path)}
          className={cn(
            "flex h-9 w-50 items-center gap-1.5 rounded-lg border border-dashed bg-card px-2 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
            tone?.border,
            className
          )}>
          <Icon
            aria-hidden
            className={cn("size-3.5 shrink-0", tone?.text)}
          />
          <span className="min-w-0 truncate font-medium">{path.name}</span>{" "}
          <span className="max-w-1/2 shrink-0 truncate text-muted-foreground">{path.version}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent aria-labelledby={title}>
        <Details
          path={path}
          scope={scope}
          title={title}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * What an opened chip says: what its path says, whole, which is there at once, and what the backend says of the
 * resource, once it has answered. How the lookup ends is said in one place, there from the moment it is asked, which a
 * screen reader reads out when it changes: what the resource is, and a link to its page, or why there is none.
 */
function Details({ path, scope, title }: { path: ResourcePath; scope: ResourceScope; title: string }) {
  const { singular, icon: Icon, tone }: ResourceKindInfo = resourceKinds[path.kind];
  const { looking, found, error, line, page } = useLookup(path, scope);
  return (
    <>
      <PopoverHeader>
        <PopoverTitle
          id={title}
          className="flex items-center gap-1.5">
          <Icon
            aria-hidden
            className={cn("size-4 shrink-0", tone?.text)}
          />
          <span className="min-w-0 wrap-anywhere">{path.name}</span>
        </PopoverTitle>
        <PopoverDescription>
          {singular} · {path.version}
        </PopoverDescription>
      </PopoverHeader>
      <dl className="space-y-1">
        {path.file && <Term name="File">{path.file}</Term>}
        <Term name="Owner">
          <span className="flex items-center gap-1.5">
            <UserAvatar name={path.owner} />
            <span className="min-w-0 wrap-anywhere">{path.owner}</span>
          </span>
        </Term>
        {found?.framework && <Term name="Framework">{found.framework}</Term>}
        {found?.format && <Term name="Format">{found.format}</Term>}
      </dl>
      <div
        role="status"
        className="flex flex-col gap-2.5 empty:hidden">
        {looking ? (
          <Quiet>Looking it up…</Quiet>
        ) : (
          <>
            {found?.description && <p className="wrap-anywhere">{found.description}</p>}
            {line && <Quiet>{line}</Quiet>}
            {page && (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="self-start">
                <PageLink page={page}>Open</PageLink>
              </Button>
            )}
          </>
        )}
      </div>
      <ErrorAlert error={error} />
    </>
  );
}

/** What the backend says of the resource that a path names. */
interface Lookup {
  /** Whether it is still being asked. */
  looking: boolean;
  /** The resource, once it is found. */
  found?: Resource & Partial<Pick<Model, "framework" | "format">>;
  /** Why it could not be asked. */
  error?: Error | null;
  /**
   * What to say once it has answered, beside what the resource says of itself: that nothing was found, or which
   * version the resource does not have.
   */
  line?: string;
  /** The page to open the resource on. */
  page?: PageTarget;
}

/**
 * What the backend says of the resource that a path names, asked once its chip is opened: the resource, if the user
 * may read it, with its versions where its kind's page shows one, so that its page opens at the version the path names.
 * While either is asked, it is looking; once both have answered, it says what it found, or why there is nothing to
 * open, or that the resource has no version of that name, whose page then opens at its newest; or what went wrong.
 */
function useLookup(path: ResourcePath, scope: ResourceScope): Lookup {
  const { versionPage }: ResourceKindInfo = resourceKinds[path.kind];
  const lookup = useQuery(resourceLookupQuery(path, scope));
  const found = lookup.data ?? undefined;
  const asksVersions = found !== undefined && versionPage !== undefined;
  // Asked once the resource is found; until then nothing is asked, and 0 stands in for its id.
  const versions = useQuery({
    ...versionListQuery({ kind: path.kind, id: found?.id ?? 0 }, scope),
    enabled: asksVersions,
  });
  const looking = lookup.isPending || (asksVersions && versions.isPending);
  const error = lookup.error ?? versions.error;
  if (looking || error) return { looking, found, error };
  if (!found) return { looking, found, line: "Not found, or you cannot read it." };
  const version = versions.data?.find(each => each.name === path.version);
  const page = versionPage && version ? versionPage(found.id, version.id, path.file) : resourcePage(found);
  const line = versionPage && !version ? `It has no version named ${path.version}.` : undefined;
  return { looking, found, line, page };
}

/** One thing an opened chip says, by its name, whole: what is long takes more lines. */
function Term({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-muted-foreground">{name}</dt>
      <dd className="min-w-0 flex-1 wrap-anywhere">{children}</dd>
    </div>
  );
}

/** A line that says where the lookup stands, or what it found of nothing. */
function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}
