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
import { ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { PagePending } from "@/components/layout/page";
import { formatSpan, formatTimeOfDay } from "@/lib/format";
import { diffContent, isUnchanged, summaryOf } from "@/lib/workflow/diff";
import { emptyContent } from "@/lib/workflow/model";
import { sessionsOf, type WorkflowHistory } from "@/lib/workflow/versions";

export interface VersionListProps {
  /** The workflow's versions, once they are read. */
  history: WorkflowHistory | undefined;
  error: Error | null;
  /** The version shown in place of the workflow, if one is. */
  shown?: number;
  onOpen: (versionId: number) => void;
}

/** Saves this close together are one stretch of work. */
const sessionGapMs = 15 * 60_000;

/** A workflow's versions in stretches of work, newest first, each saying what it changed from the one before it. */
export function VersionList({ history, error, shown, onOpen }: VersionListProps) {
  const sessions = useMemo(() => {
    if (!history) return [];
    const { versions } = history;
    return sessionsOf(versions, sessionGapMs).map(session => ({
      ...session,
      summary: summaryOf(diffContent(session.before?.content ?? emptyContent, session.versions[0].content)),
      changes: session.versions.map(version => {
        const older = versions.at(versions.indexOf(version) + 1);
        const diff = diffContent(older?.content ?? emptyContent, version.content);
        // The first version is the workflow as it was made.
        if (older) return { version, summary: summaryOf(diff) };
        return { version, summary: ["Created the workflow", ...(isUnchanged(diff) ? [] : summaryOf(diff))] };
      }),
    }));
  }, [history]);

  if (error) return <ErrorAlert error={error} />;
  if (!history) return <PagePending />;
  if (sessions.length === 0) return <EmptyState title="No version yet" />;

  return (
    <ol
      aria-label="Versions"
      className="space-y-3">
      {sessions.map((session, index) => {
        const [newest, oldest] = [session.versions[0], session.versions.at(-1)!];
        return (
          <li key={newest.id}>
            <details
              // The newest stretch is open, and so is the one with the version that is shown.
              open={index === 0 || session.versions.some(version => version.id === shown)}
              className="group rounded-lg border bg-card">
              <summary className="flex cursor-pointer list-none items-start gap-2 p-3 [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{formatSpan(oldest.savedAt, newest.savedAt)}</p>
                  <p className="text-sm text-muted-foreground">{session.summary.join(" · ")}</p>
                </div>
                <span className="shrink-0 text-sm text-muted-foreground">
                  {session.versions.length} {session.versions.length === 1 ? "save" : "saves"}
                </span>
              </summary>
              <ol className="border-t">
                {session.changes.map(({ version, summary }) => (
                  <li key={version.id}>
                    <button
                      type="button"
                      aria-current={version.id === shown || undefined}
                      className={cn(
                        "w-full px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                        version.id === shown && "bg-accent"
                      )}
                      onClick={() => onOpen(version.id)}>
                      <span className="block text-sm text-muted-foreground tabular-nums">
                        {formatTimeOfDay(version.savedAt)}
                        {version === history.versions[0] && " · the workflow as it is saved now"}
                      </span>
                      <span className="block text-sm">{summary.join(" · ")}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          </li>
        );
      })}
      {!history.complete && (
        <li>
          <ErrorAlert error="The versions before these could not be rebuilt from what the backend keeps." />
        </li>
      )}
    </ol>
  );
}
