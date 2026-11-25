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
import { cn } from "cn";
import { StarIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { PagePending } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ExecutionState } from "@/lib/execution/protocol";
import { formatDuration, formatTime } from "@/lib/format";
import {
  bookmarkExecution,
  deleteExecution,
  executionHistoryQuery,
  executionsKey,
  executionStatisticsQuery,
  type OperatorStatistics,
  type PastExecution,
  type PastExecutionStatus,
  renameExecution,
} from "../api";

export interface ExecutionHistoryProps {
  workflowId: number;
  /** Whether the user may change the workflow, and so rename, bookmark and delete its executions. */
  canChange: boolean;
  /** The name of each operator on the canvas, by its id. */
  operatorNames: Record<string, string>;
  /** Where the execution under way stands: whenever that changes, the history is read again. */
  state: ExecutionState;
  /** Shows the version of the workflow that an execution executed. */
  onOpenVersion: (versionId: number) => void;
}

const filters = {
  all: { label: "All", keeps: () => true },
  bookmarked: { label: "Bookmarked", keeps: (execution: PastExecution) => execution.bookmarked },
  failed: { label: "Failed", keeps: (execution: PastExecution) => execution.status === "Failed" },
};
type Filter = keyof typeof filters;

const statusClassNames: Record<PastExecutionStatus, string> = {
  Created: "bg-muted-foreground",
  Initializing: "bg-warning",
  Running: "bg-warning",
  Paused: "bg-warning",
  Completed: "bg-success",
  Failed: "bg-destructive",
  Killed: "bg-destructive",
  Unknown: "bg-muted-foreground",
};

/** A workflow's executions, newest first: who started each, when, how it ended, and what each operator did. */
export function ExecutionHistory({
  workflowId,
  canChange,
  operatorNames,
  state,
  onOpenVersion,
}: ExecutionHistoryProps) {
  const queryClient = useQueryClient();
  const { data: executions, error } = useQuery(executionHistoryQuery(workflowId));
  const [filter, setFilter] = useState<Filter>("all");
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: executionsKey(workflowId), exact: true });
  }, [state, workflowId, queryClient]);
  const changed = () => queryClient.invalidateQueries({ queryKey: executionsKey(workflowId), exact: true });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => renameExecution(workflowId, id, name),
    onSettled: changed,
  });
  const bookmark = useMutation({
    mutationFn: ({ id, bookmarked }: { id: number; bookmarked: boolean }) =>
      bookmarkExecution(workflowId, id, bookmarked),
    onSettled: changed,
  });
  const remove = useMutation({ mutationFn: (id: number) => deleteExecution(workflowId, id), onSettled: changed });

  if (error) return <ErrorAlert error={error} />;
  if (!executions) return <PagePending />;
  const shown = executions.filter(filters[filter].keeps);

  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-label="Show"
        className="flex gap-1">
        {Object.entries(filters).map(([key, { label }]) => (
          <Button
            key={key}
            variant={filter === key ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={filter === key}
            onClick={() => setFilter(key as Filter)}>
            {label}
          </Button>
        ))}
      </div>
      <ErrorAlert error={rename.error ?? bookmark.error ?? remove.error} />
      {shown.length === 0 ? (
        <EmptyState title={executions.length === 0 ? "Not executed yet" : "None of them"} />
      ) : (
        <ol
          aria-label="Executions"
          className="space-y-2">
          {shown.map(execution => (
            <ExecutionItem
              key={execution.id}
              workflowId={workflowId}
              execution={execution}
              canChange={canChange}
              operatorNames={operatorNames}
              onOpenVersion={onOpenVersion}
              onRename={name => rename.mutate({ id: execution.id, name })}
              onBookmark={bookmarked => bookmark.mutate({ id: execution.id, bookmarked })}
              onDelete={() => remove.mutate(execution.id)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function ExecutionItem({
  workflowId,
  execution,
  canChange,
  operatorNames,
  onOpenVersion,
  onRename,
  onBookmark,
  onDelete,
}: {
  workflowId: number;
  execution: PastExecution;
  canChange: boolean;
  operatorNames: Record<string, string>;
  onOpenVersion: (versionId: number) => void;
  onRename: (name: string) => void;
  onBookmark: (bookmarked: boolean) => void;
  onDelete: () => void;
}) {
  const { name, status, reason, by, startedAt, updatedAt, bookmarked, versionId } = execution;
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showStatistics, setShowStatistics] = useState(false);
  const ended = status === "Completed" || status === "Failed" || status === "Killed";

  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = new FormData(event.currentTarget).get("name");
    const newName = typeof typed === "string" ? typed.trim() : "";
    if (newName && newName !== name) onRename(newName);
    setRenaming(false);
  }

  return (
    <li
      aria-label={name}
      className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", statusClassNames[status])}
        />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form onSubmit={submitName}>
              <Input
                name="name"
                aria-label="Name of the execution"
                defaultValue={name}
                maxLength={128}
                // The field is there to be typed in at once.
                autoFocus
                onBlur={event => event.currentTarget.form?.requestSubmit()}
                onKeyDown={event => event.key === "Escape" && setRenaming(false)}
              />
            </form>
          ) : (
            <p className="truncate text-sm font-medium">{name}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {/* Why it ended as it did, when the service says, is where a past execution is looked at for it. */}
            {reason ? `${status}: ${reason}` : status} · by {by} · {formatTime(startedAt)}
            {ended && ` · took ${formatDuration(updatedAt - startedAt)}`}
          </p>
        </div>
        {canChange && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Bookmark"
            aria-pressed={bookmarked}
            onClick={() => onBookmark(!bookmarked)}>
            <StarIcon className={cn(bookmarked && "fill-warning text-warning")} />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3">
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0"
          onClick={() => onOpenVersion(versionId)}>
          Open its version
        </Button>
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0"
          aria-expanded={showStatistics}
          onClick={() => setShowStatistics(!showStatistics)}>
          Statistics
        </Button>
        {canChange && (
          <>
            <Button
              variant="link"
              size="xs"
              className="h-auto p-0"
              onClick={() => setRenaming(true)}>
              Rename
            </Button>
            <Button
              variant="link"
              size="xs"
              className="h-auto p-0 text-destructive"
              onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </>
        )}
      </div>
      {showStatistics && (
        <ExecutionStatistics
          workflowId={workflowId}
          executionId={execution.id}
          operatorNames={operatorNames}
        />
      )}
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{name}”?</DialogTitle>
            <DialogDescription>Its results and its statistics are deleted with it.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setDeleting(false);
                onDelete();
              }}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** What each operator did in an execution: the rows it took and put out, its time, and its rows as they came. */
function ExecutionStatistics({
  workflowId,
  executionId,
  operatorNames,
}: {
  workflowId: number;
  executionId: number;
  operatorNames: Record<string, string>;
}) {
  const { data: statistics } = useQuery(executionStatisticsQuery(workflowId, executionId));
  if (!statistics) return <PagePending />;
  if (statistics.length === 0) return <EmptyState title="No statistics were kept" />;
  // An operator that is no longer on the canvas is named by its type, which its id starts with.
  const name = (id: string) => operatorNames[id] ?? id.split("-operator-")[0];
  return (
    <Table aria-label="Statistics">
      <TableHeader>
        <TableRow>
          <TableHead>Operator</TableHead>
          <TableHead className="text-right">Rows out</TableHead>
          <TableHead className="text-right">Time</TableHead>
          <TableHead>
            <span className="sr-only">Rows as they came</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {statistics.map(operator => (
          <TableRow key={operator.operatorId}>
            <TableCell className="max-w-28 truncate">{name(operator.operatorId)}</TableCell>
            <TableCell className="text-right tabular-nums">{operator.outputRows.toLocaleString("en-US")}</TableCell>
            <TableCell className="text-right tabular-nums">{formatDuration(operator.processingMs)}</TableCell>
            <TableCell>
              <Sparkline samples={operator.samples} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** How many rows an operator had put out, over the time it was sampled, as a line. */
function Sparkline({ samples }: { samples: OperatorStatistics["samples"] }) {
  if (samples.length < 2) return null;
  const [start, end] = [samples[0].at, samples.at(-1)!.at];
  const most = Math.max(1, ...samples.map(sample => sample.rows));
  const points = samples
    .map(sample => `${((sample.at - start) / Math.max(1, end - start)) * 100},${20 - (sample.rows / most) * 20}`)
    .join(" ");
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      className="h-5 w-16 text-primary">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
