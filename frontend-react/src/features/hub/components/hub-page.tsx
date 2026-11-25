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
import { linkOptions } from "@tanstack/react-router";
import { CopyIcon, HeartIcon } from "lucide-react";
import type { SearchableKind } from "@/components/resource/api";
import { resourcePage } from "@/components/resource/kinds";
import { ResourceListPage } from "@/components/resource/resource-list-page";
import { receptionQuery } from "../api";

export interface HubPageProps {
  /** The kind of public resources shown. */
  kind: SearchableKind;
}

/** What is public, of one kind, with how it was received. */
export function HubPage({ kind }: HubPageProps) {
  return (
    <ResourceListPage
      kind={kind}
      scope="public"
      description="What people made public for everyone to find, open and copy."
      emptyDescription="What anyone makes public, in its sharing, is listed here."
      // A public workflow opens as the public sees it; the other kinds open on their own pages.
      itemPage={resource =>
        resource.kind === "workflow"
          ? linkOptions({ to: "/hub/workflows/$workflowId", params: { workflowId: resource.id } })
          : resourcePage(resource)
      }
      itemDetails={(resource, shown) => (
        <Reception
          kind={kind}
          id={resource.id}
          shown={shown.map(each => each.id)}
        />
      )}
    />
  );
}

/** How many people like a public resource and, for a workflow, copied it. */
function Reception({ kind, id, shown }: { kind: SearchableKind; id: number; shown: number[] }) {
  // Every item asks about all that are shown, so that one request answers them all.
  const { data: reception } = useQuery(receptionQuery(kind, shown));
  const received = reception?.[id];
  if (!received) return null;
  return (
    <span className="flex shrink-0 items-center gap-3 text-muted-foreground">
      <span className="flex items-center gap-1">
        <HeartIcon
          aria-hidden
          className="size-3.5"
        />
        {received.likes}
        <span className="sr-only"> likes</span>
      </span>
      {kind === "workflow" && (
        <span className="flex items-center gap-1">
          <CopyIcon
            aria-hidden
            className="size-3.5"
          />
          {received.clones}
          <span className="sr-only"> copies</span>
        </span>
      )}
    </span>
  );
}
