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

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { SquareTerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { FloatingPanel } from "@/components/floating/floating-panel";
import { useFloatingPanel } from "@/components/floating/use-floating-panel";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  activeStates,
  type ExecutionClient,
  type ExecutionSnapshot,
  type OperatorResult,
} from "@/lib/execution/client";

export interface ExecutionPanelProps {
  /** The connection the results are asked through. */
  client: ExecutionClient | undefined;
  snapshot: ExecutionSnapshot;
  /** The name of each operator on the canvas, by its id. */
  operatorNames: Record<string, string>;
  /** The operator whose result to show first, such as the one selected on the canvas. */
  operatorId?: string;
}

const pageSize = 20;

/**
 * What an execution has to show: each operator's result, what the operators printed, and why it failed. It floats
 * over the canvas, docked to its bottom edge, and an execution that starts shows it again if it was minimized.
 */
export function ExecutionPanel({ client, snapshot, operatorNames, operatorId }: ExecutionPanelProps) {
  const { state, results, errors, console: printed } = snapshot;
  const panel = useFloatingPanel({ id: "workflow-execution", dock: "bottom", size: { width: 720, height: 300 } });
  const active = activeStates.has(state);
  const { setMinimized } = panel;
  useEffect(() => {
    if (active) setMinimized(false);
  }, [active, setMinimized]);
  const withResult = Object.keys(results);
  const [chosen, setChosen] = useState<string>();
  // The operator that was chosen here, or the one selected on the canvas, or else the first with a result.
  const shown = [chosen, operatorId].find(id => id !== undefined && id in results) ?? withResult.at(0);
  const lines = Object.entries(printed).flatMap(([id, messages]) => messages.map(message => ({ id, ...message })));
  const name = (id: string) => operatorNames[id] ?? id;

  if (state === "Uninitialized" && withResult.length === 0 && errors.length === 0) return null;

  return (
    <FloatingPanel
      panel={panel}
      title="Execution"
      icon={SquareTerminalIcon}
      status={<span role="status">{state}</span>}>
      <Tabs
        // An execution that failed opens on why.
        key={errors.length > 0 ? "failed" : "ok"}
        defaultValue={errors.length > 0 ? "errors" : "result"}
        className="h-full gap-0">
        <div className="flex items-center gap-3 border-b px-3 py-1.5">
          <TabsList>
            <TabsTrigger value="result">Result</TabsTrigger>
            <TabsTrigger value="console">Console{lines.length > 0 && ` (${lines.length})`}</TabsTrigger>
            <TabsTrigger value="errors">Errors{errors.length > 0 && ` (${errors.length})`}</TabsTrigger>
          </TabsList>
          {shown && (
            <Select
              value={shown}
              onValueChange={setChosen}>
              <SelectTrigger
                aria-label="Result of"
                className="ml-auto max-w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                position="popper"
                align="end">
                {withResult.map(id => (
                  <SelectItem
                    key={id}
                    value={id}>
                    {name(id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <TabsContent
          value="result"
          className="min-h-0 overflow-auto">
          {shown && client ? (
            <OperatorResultView
              // Another operator's result, or a newer one of the same operator, starts on its first page.
              key={`${shown}/${results[shown].revision}`}
              client={client}
              operatorId={shown}
              result={results[shown]}
            />
          ) : (
            <EmptyState title={state === "Completed" ? "No operator kept a result" : "No result yet"} />
          )}
        </TabsContent>
        <TabsContent
          value="console"
          className="min-h-0 overflow-auto p-3">
          {lines.length === 0 ? (
            <EmptyState title="Nothing was printed" />
          ) : (
            <ol
              aria-label="Console"
              className="space-y-1 font-mono text-sm">
              {lines.map((line, index) => (
                <li key={index}>
                  <span className="text-muted-foreground">{name(line.id)}:</span> {line.title || line.message}
                </li>
              ))}
            </ol>
          )}
        </TabsContent>
        <TabsContent
          value="errors"
          className="min-h-0 space-y-2 overflow-auto p-3">
          {errors.length === 0 ? (
            <EmptyState title="No errors" />
          ) : (
            errors.map((error, index) => (
              <ErrorAlert
                key={index}
                error={error.operatorId ? `${name(error.operatorId)}: ${error.message}` : error.message}
              />
            ))
          )}
        </TabsContent>
      </Tabs>
    </FloatingPanel>
  );
}

/** One operator's result: a visualization as the page it is, or a table, a page of rows at a time. */
function OperatorResultView({
  client,
  operatorId,
  result,
}: {
  client: ExecutionClient;
  operatorId: string;
  result: OperatorResult;
}) {
  const [pageIndex, setPageIndex] = useState(1);
  const totalRows = result.kind === "table" ? result.totalRows : 0;
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  const { data: page, error } = useQuery({
    queryKey: ["executionResult", operatorId, result.revision, pageIndex],
    queryFn: () => client.page(operatorId, pageIndex, pageSize),
    enabled: result.kind === "table",
    // The page on screen stays until the next one is there.
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: false,
  });

  if (result.kind === "visualization") {
    return (
      // What an operator made is shown apart from the app: it may run its own scripts, and nothing of the app's.
      <iframe
        title="Visualization"
        sandbox="allow-scripts"
        srcDoc={result.html}
        className="size-full"
      />
    );
  }
  if (error) return <ErrorAlert error={error} />;
  if (!page) return null;
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {page.columns.map(column => (
              <TableHead key={column.attributeName}>
                {column.attributeName} <span className="font-normal text-muted-foreground">{column.attributeType}</span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.rows.map((row, index) => (
            <TableRow key={index}>
              {page.columns.map(column => (
                <TableCell key={column.attributeName}>{cellText(row[column.attributeName])}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t bg-background px-3 py-1.5 text-sm text-muted-foreground">
        <span>
          {totalRows.toLocaleString("en-US")} rows · page {pageIndex} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={pageIndex <= 1}
          onClick={() => setPageIndex(pageIndex - 1)}>
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pageIndex >= pageCount}
          onClick={() => setPageIndex(pageIndex + 1)}>
          Next
        </Button>
      </div>
    </>
  );
}

/** A cell as text: text as it is, and a number, a boolean or anything else as JSON writes it. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}
