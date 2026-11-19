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

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { diffContent, marksOf, type Marks, shownWith, type WorkflowDiff } from "@/lib/workflow/diff";
import { emptyContent, type WorkflowContent } from "@/lib/workflow/model";
import type { WorkflowHistory, WorkflowVersion } from "@/lib/workflow/versions";
import { workflowHistoryQuery } from "./api";

/** What a version is shown against: the version before it, or the workflow as it is now. */
export type Comparison = "previous" | "now";

/** A version being looked at, and how it differs from what it is compared with. */
export interface VersionView {
  version: WorkflowVersion;
  /** The versions just before and just after it, to step to. */
  older?: WorkflowVersion;
  newer?: WorkflowVersion;
  diff: WorkflowDiff;
  /** What the canvas draws: the version, with what is not in it put back, to be drawn as removed. */
  shown: WorkflowContent;
  marks: Marks;
}

export interface WorkflowHistoryState {
  history: WorkflowHistory | undefined;
  error: Error | null;
  /** The version asked for, once the versions are read. */
  view: VersionView | undefined;
}

interface Options {
  workflowId: number;
  /** Whether the versions are wanted at all, as while the history is open or a version is shown. */
  active: boolean;
  /** The version to look at, by its id. */
  versionId: number | undefined;
  comparison: Comparison;
  /** The workflow as it is now, in the room. */
  content: WorkflowContent;
  /** Whether everything in the room is saved: each save makes a version, so the versions are read again. */
  saved: boolean;
}

/** A workflow's versions, read while they are wanted and again after each save, and the one being looked at. */
export function useWorkflowHistory({
  workflowId,
  active,
  versionId,
  comparison,
  content,
  saved,
}: Options): WorkflowHistoryState {
  const queryClient = useQueryClient();
  const { data: history, error } = useQuery({ ...workflowHistoryQuery(workflowId), enabled: active });
  useEffect(() => {
    if (saved) void queryClient.invalidateQueries({ queryKey: workflowHistoryQuery(workflowId).queryKey });
  }, [saved, workflowId, queryClient]);

  const view = useMemo((): VersionView | undefined => {
    const versions = history?.versions ?? [];
    const index = versions.findIndex(each => each.id === versionId);
    if (index < 0) return undefined;
    const version = versions[index];
    const older = versions.at(index + 1);
    const before = comparison === "now" ? content : (older?.content ?? emptyContent);
    const diff = diffContent(before, version.content);
    return { version, older, newer: versions.at(index - 1), diff, shown: shownWith(diff), marks: marksOf(diff) };
  }, [history, versionId, comparison, content]);

  return { history, error, view };
}
