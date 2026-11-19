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

// The hub: what is public, how many like and copied each, and a public workflow as the public sees it
// (HubResource.scala, WorkflowResource.scala). The lists of public resources are resource lists, in
// components/resource/api.ts.

import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ResourceRef } from "@/lib/resource";
import { publicKey } from "@/lib/session";
import { parseContent, type WorkflowContent } from "@/lib/workflow/model";

/** How many people like a resource, and how many copied it. */
export interface Reception {
  likes: number;
  clones: number;
}

type HubKind = Exclude<ResourceRef["kind"], "computing-unit">;

/** How resources of one kind were received, by their ids. Anyone may read it. */
export function receptionQuery(kind: HubKind, ids: number[]) {
  return queryOptions({
    queryKey: [...publicKey, "hub", "reception", kind, ids.toSorted((a, b) => a - b)],
    queryFn: async (): Promise<Record<number, Reception>> => {
      const query = [
        `entityType=${kind}`,
        ...ids.map(id => `entityId=${id}`),
        "actionTypes=like",
        "actionTypes=clone",
      ].join("&");
      const answers = await api<{ entityId: number; counts: { like?: number; clone?: number } }[]>(
        `/hub/counts?${query}`
      );
      return Object.fromEntries(
        answers.map(({ entityId, counts }) => [entityId, { likes: counts.like ?? 0, clones: counts.clone ?? 0 }])
      );
    },
    enabled: ids.length > 0,
  });
}

/** Whether the signed-in user likes a resource. */
export function likedQuery({ kind, id }: ResourceRef) {
  return queryOptions({
    queryKey: ["hub", "liked", kind, id],
    queryFn: async (): Promise<boolean> => {
      const [answer] = await api<{ isLiked: boolean }[]>(`/hub/isLiked?entityId=${id}&entityType=${kind}`);
      return answer?.isLiked ?? false;
    },
  });
}

export function setLiked({ kind, id }: ResourceRef, liked: boolean): Promise<void> {
  return api(`/hub/${liked ? "like" : "unlike"}`, {
    method: "POST",
    json: { entityId: id, entityType: kind },
    responseType: "void",
  });
}

/** A public workflow as the public sees it: its pinned copy, if its owner pinned one, or else as it is now. */
export interface PublicWorkflow {
  id: number;
  name: string;
  description: string;
  content: WorkflowContent;
}

export function publicWorkflowQuery(id: number) {
  return queryOptions({
    queryKey: [...publicKey, "hub", "workflow", id],
    queryFn: async (): Promise<PublicWorkflow> => {
      const { wid, name, description, content } = await api<{
        wid: number;
        name: string;
        description: string | null;
        content: string | null;
      }>(`/workflow/publicised/${id}`);
      return { id: wid, name, description: description ?? "", content: parseContent(content) };
    },
    retry: false,
  });
}

/** Copies a public workflow, as the public sees it, into a new workflow of the user's, and returns its id. */
export function cloneWorkflow(id: number): Promise<number> {
  return api<number>(`/workflow/clone/${id}`, { method: "POST", json: {} });
}
