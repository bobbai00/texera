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

import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Trash2Icon } from "lucide-react";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Page, PageHeader } from "@/components/layout/page";
import { PageLink } from "@/components/layout/page-link";
import { Section } from "@/components/layout/section";
import { resourceKinds } from "@/components/resource/kinds";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes } from "@/lib/format";
import { deleteKept, quotaKey, quotaQuery, total } from "../api";

/** What the user has made, and what their executions keep, with the way to let go of what is kept. */
export function QuotaPage() {
  const queryClient = useQueryClient();
  const { data: quota } = useSuspenseQuery(quotaQuery());
  const remove = useMutation({
    mutationFn: deleteKept,
    onSettled: () => queryClient.invalidateQueries({ queryKey: quotaKey }),
  });
  const kept = quota.kept.reduce((sum, each) => sum + total(each), 0);
  const counts = [
    { label: "Workflows you made", value: quota.workflowsMade.toLocaleString("en-US") },
    { label: "Workflows you can open", value: quota.workflowsReachable.toLocaleString("en-US") },
    { label: "Datasets you made", value: quota.datasetsMade.toLocaleString("en-US") },
    { label: "Kept by your executions", value: formatBytes(kept) },
  ];

  return (
    <Page>
      <PageHeader
        title="Quota"
        description="What you have made, and what your executions keep."
      />
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {counts.map(({ label, value }) => (
          <Card key={label}>
            <CardContent className="space-y-1">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
            </CardContent>
          </Card>
        ))}
      </dl>
      <Section title="What your executions keep">
        <ErrorAlert error={remove.error} />
        {quota.kept.length === 0 ? (
          <EmptyState title="Your executions keep nothing" />
        ) : (
          <Card className="py-0">
            <Table aria-label="What your executions keep">
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead className="text-right">Results</TableHead>
                  <TableHead className="text-right">Statistics</TableHead>
                  <TableHead className="text-right">Logs</TableHead>
                  <TableHead>
                    <span className="sr-only">Delete</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {quota.kept.map(each => (
                  <TableRow key={each.executionId}>
                    <TableCell className="max-w-72 truncate">
                      <PageLink
                        page={resourceKinds.workflow.page(each.workflowId)}
                        className="hover:underline">
                        {each.workflowName}
                      </PageLink>{" "}
                      <span className="text-muted-foreground">· execution {each.executionId}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(each.resultBytes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(each.statisticsBytes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(each.logBytes)}</TableCell>
                    <TableCell className="w-10">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete what execution ${each.executionId} keeps`}
                        disabled={total(each) === 0 || remove.isPending}
                        onClick={() => remove.mutate(each.executionId)}>
                        <Trash2Icon />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </Section>
    </Page>
  );
}
