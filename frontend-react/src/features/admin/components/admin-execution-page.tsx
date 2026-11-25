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

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { SquareIcon } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Page, PageHeader, PagePending } from "@/components/layout/page";
import { PageLink } from "@/components/layout/page-link";
import { resourceKinds } from "@/components/resource/kinds";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDuration, formatTime } from "@/lib/format";
import { type AdminExecutionStatus, adminExecutionsQuery, stopExecution } from "../api";

const filters: { label: string; statuses: AdminExecutionStatus[] }[] = [
  { label: "All", statuses: [] },
  { label: "Under way", statuses: ["READY", "RUNNING", "PAUSED"] },
  { label: "Completed", statuses: ["COMPLETED"] },
  { label: "Failed", statuses: ["FAILED"] },
  { label: "Stopped", statuses: ["KILLED"] },
];

const statusNames: Record<AdminExecutionStatus, string> = {
  CREATED: "Created",
  READY: "Initializing",
  RUNNING: "Running",
  PAUSED: "Paused",
  COMPLETED: "Completed",
  FAILED: "Failed",
  KILLED: "Stopped",
  UNKNOWN: "Unknown",
};

const statusClassNames: Partial<Record<AdminExecutionStatus, string>> = {
  READY: "text-warning",
  RUNNING: "text-warning",
  PAUSED: "text-warning",
  COMPLETED: "text-success",
  FAILED: "text-destructive",
  KILLED: "text-destructive",
};

const underWay = new Set<AdminExecutionStatus>(["READY", "RUNNING", "PAUSED"]);

/** The latest execution of every workflow, as it stands, with the way to stop one that is under way. */
export function AdminExecutionPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState(filters[0]);
  const query = adminExecutionsQuery(filter.statuses);
  const { data, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    ...query,
    // Where executions stand changes while the page is open.
    refetchInterval: 5_000,
  });
  const stop = useMutation({
    mutationFn: stopExecution,
    onSettled: () => queryClient.invalidateQueries({ queryKey: query.queryKey }),
  });
  const executions = data?.pages.flat();

  return (
    <Page>
      <PageHeader
        title="Executions"
        description="The latest execution of every workflow, the most recently ended first."
      />
      <div
        role="group"
        aria-label="Show"
        className="flex flex-wrap gap-1">
        {filters.map(each => (
          <Button
            key={each.label}
            variant={each === filter ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={each === filter}
            onClick={() => setFilter(each)}>
            {each.label}
          </Button>
        ))}
      </div>
      <ErrorAlert error={error ?? stop.error} />
      {!executions ? (
        !error && <PagePending />
      ) : executions.length === 0 ? (
        <EmptyState title="No executions" />
      ) : (
        <Card className="py-0">
          <Table aria-label="Executions">
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Execution</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">Took</TableHead>
                <TableHead>
                  <span className="sr-only">Stop</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {executions.map(execution => (
                <TableRow key={execution.executionId}>
                  <TableCell className="max-w-64 truncate">
                    {execution.canOpen ? (
                      <PageLink
                        page={resourceKinds.workflow.page(execution.workflowId)}
                        className="hover:underline">
                        {execution.workflowName}
                      </PageLink>
                    ) : (
                      execution.workflowName
                    )}
                  </TableCell>
                  <TableCell className="max-w-48 truncate">{execution.name}</TableCell>
                  <TableCell>{execution.by}</TableCell>
                  <TableCell className="max-w-64">
                    <Badge
                      variant="outline"
                      className={cn(statusClassNames[execution.status])}>
                      {statusNames[execution.status]}
                    </Badge>
                    {execution.reason && (
                      <p
                        className="truncate text-sm text-muted-foreground"
                        title={execution.reason}>
                        {execution.reason}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>{formatTime(execution.startedAt)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {execution.endedAt !== null && !underWay.has(execution.status)
                      ? formatDuration(execution.endedAt - execution.startedAt)
                      : ""}
                  </TableCell>
                  <TableCell className="w-10">
                    {/* The unit an execution is on is told only to someone who may open its workflow. */}
                    {underWay.has(execution.status) && execution.canOpen && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Stop the execution of ${execution.workflowName}`}
                        disabled={stop.isPending}
                        onClick={() => stop.mutate(execution)}>
                        <SquareIcon />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}>
          Load more
        </Button>
      )}
    </Page>
  );
}
