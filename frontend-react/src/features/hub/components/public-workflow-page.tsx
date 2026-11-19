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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { linkOptions } from "@tanstack/react-router";
import { cn } from "cn";
import { CopyPlusIcon, HeartIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { PageLink } from "@/components/layout/page-link";
import { Button } from "@/components/ui/button";
import { publicKey } from "@/lib/session";
import { cloneWorkflow, likedQuery, type PublicWorkflow, receptionQuery, setLiked } from "../api";

export interface PublicWorkflowPageProps {
  workflow: PublicWorkflow;
  /** Whether someone is signed in, who may like the workflow and copy it. */
  signedIn: boolean;
  /** The workflow itself, to look at, from another feature. */
  children: ReactNode;
  /** The workflow was copied into a new one of the user's, which is theirs to open. */
  onCloned: (workflowId: number) => void;
}

/** A public workflow as anyone sees it: what it is, how it was received, and the way to like and copy it. */
export function PublicWorkflowPage({ workflow, signedIn, children, onCloned }: PublicWorkflowPageProps) {
  const queryClient = useQueryClient();
  const ref = { kind: "workflow" as const, id: workflow.id };
  const { data: reception } = useQuery(receptionQuery("workflow", [workflow.id]));
  const { data: liked } = useQuery({ ...likedQuery(ref), enabled: signedIn });
  const received = reception?.[workflow.id];
  const like = useMutation({
    mutationFn: (to: boolean) => setLiked(ref, to),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: likedQuery(ref).queryKey }),
        queryClient.invalidateQueries({ queryKey: [...publicKey, "hub", "reception", "workflow"] }),
      ]),
  });
  const clone = useMutation({ mutationFn: () => cloneWorkflow(workflow.id), onSuccess: onCloned });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{workflow.name}</h1>
          {workflow.description && <p className="text-muted-foreground">{workflow.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          {signedIn ? (
            <>
              <Button
                variant="outline"
                aria-pressed={liked === true}
                disabled={liked === undefined || like.isPending}
                onClick={() => like.mutate(!liked)}>
                <HeartIcon className={cn(liked && "fill-destructive text-destructive")} />
                {liked ? "Liked" : "Like"}
                {received && <span className="text-muted-foreground tabular-nums">{received.likes}</span>}
              </Button>
              <Button
                disabled={clone.isPending}
                onClick={() => clone.mutate()}>
                <CopyPlusIcon />
                Make a copy
              </Button>
            </>
          ) : (
            <Button asChild>
              <PageLink page={linkOptions({ to: "/sign-in" })}>Sign in to make a copy</PageLink>
            </Button>
          )}
        </div>
      </div>
      <ErrorAlert error={like.error ?? clone.error} />
      {children}
    </div>
  );
}
