import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { executionsCancel, executionsSaveResult } from "@texera/catalog-client";
import type { Execution, PortResult } from "@texera/catalog-client/types";
import { Badge, Button, DataTable, EmptyState, ErrorNote, Skeleton, Tab, TabPanel, Tabs, TabsList, cn, formatDuration, formatNumber, timeAgo } from "@texera/ui";
import { AlertTriangle, ChevronLeft, ChevronRight, Cpu, Database, Loader2, Square, Table2, Workflow } from "lucide-react";
import { useState } from "react";
import { unwrap } from "../api";
import { ResourceCard } from "../ResourceView";
import { KindHeader } from "../shell/KindHeader";
import { JsonBlock } from "../shell/JsonBlock";
import { useOpenResource } from "../shell/navigation";
import type { KindViewProps } from "../types";
import { executionQuery, PAGE_SIZE, resultQuery } from "./queries";

const TONE: Record<Execution["status"], "neutral" | "success" | "danger" | "warning"> = {
  pending: "neutral",
  running: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "danger",
};

/** A run: when and how it ended, each operator's state, its port results, and what it read. */
export default function ExecutionView({ ref, mode }: KindViewProps) {
  const queryClient = useQueryClient();
  const { data: x, error } = useQuery(executionQuery(ref.rid));
  const { beside } = useOpenResource();
  const cancel = useMutation({
    mutationFn: () => unwrap(executionsCancel({ path: { eid: ref.rid } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [{ _id: "executionsRead", path: { eid: ref.rid } }] }),
  });
  const [tab, setTab] = useState("results");
  if (error) return <ErrorNote error={error} prefix="Could not open this run" className="m-4" />;
  if (!x) return <Skeleton className="m-4 h-64" />;
  const live = x.status === "pending" || x.status === "running";
  const errors = Object.entries(x.operators).filter(([, o]) => o.error);
  return (
    <div className="flex h-full min-h-0 flex-col" data-execution-view={ref.rid}>
      <KindHeader
        ref={ref}
        mode={mode}
        name={x.name || `Run ${x.eid.slice(0, 8)}`}
        meta={`${timeAgo(x.createdAt)} · ${formatDuration(x.startedAt, x.finishedAt) || "not started"} · by ${x.actor.slice(0, 8)}${x.onBehalfOf ? ` for ${x.onBehalfOf.slice(0, 8)}` : ""}`}
        actions={
          <>
            <Badge tone={TONE[x.status]} className="capitalize">
              {live && <Loader2 className="size-3 animate-spin" />}
              {x.status}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => beside({ kind: "workflow", rid: x.workflow.rid, vno: x.workflow.vno })}>
              <Workflow /> Workflow v{x.workflow.vno}
            </Button>
            <Button variant="outline" size="sm" onClick={() => beside({ kind: "computing_unit", rid: x.computingUnit })}>
              <Cpu /> Unit
            </Button>
            {live && (
              <Button variant="secondary" size="sm" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <Square className="fill-current" /> Stop
              </Button>
            )}
          </>
        }
      />
      {x.error !== undefined && x.error !== null && <ErrorNote error={x.error} prefix="The run failed" className="m-3" />}
      <Tabs value={tab} onValueChange={v => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <Tab value="results">
            <Table2 /> Results ({x.results.length})
          </Tab>
          <Tab value="operators">
            <Workflow /> Operators
          </Tab>
          <Tab value="inputs">
            <Database /> Inputs ({x.inputs.length})
          </Tab>
          {errors.length > 0 && (
            <Tab value="errors" className="text-destructive">
              <AlertTriangle /> Errors ({errors.length})
            </Tab>
          )}
          <Tab value="raw">Raw</Tab>
        </TabsList>
        <TabPanel value="results" className="flex min-h-0 flex-1 flex-col">
          <Results eid={x.eid} results={x.results} completed={x.status === "completed"} />
        </TabPanel>
        <TabPanel value="operators" className="scrollbar-thin overflow-y-auto">
          <Operators execution={x} />
        </TabPanel>
        <TabPanel value="inputs" className="scrollbar-thin space-y-3 overflow-y-auto p-3">
          {x.inputs.length === 0 ? (
            <EmptyState>This run read no dataset versions.</EmptyState>
          ) : (
            x.inputs.map(i => <ResourceCard key={`${i.rid}@${i.vno}`} ref={{ kind: "dataset", rid: i.rid, vno: i.vno }} resolveKind />)
          )}
        </TabPanel>
        <TabPanel value="errors" className="scrollbar-thin space-y-2 overflow-y-auto p-3">
          {errors.map(([opid, o]) => (
            <ErrorNote key={opid} error={o.error} prefix={opid} />
          ))}
        </TabPanel>
        <TabPanel value="raw" className="scrollbar-thin overflow-y-auto p-3">
          <JsonBlock value={x} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function Operators({ execution }: { execution: Execution }) {
  const rows = Object.entries(execution.operators);
  if (!rows.length) return <EmptyState>No operator states reported yet.</EmptyState>;
  return (
    <DataTable
      columns={[{ name: "operator" }, { name: "state" }, { name: "tuples", type: "long" }]}
      rows={rows.map(([opid, o]) => [opid, o.state, o.tuples !== undefined ? formatNumber(o.tuples) : ""])}
      className="min-h-0"
    />
  );
}

function Results({ eid, results, completed }: { eid: string; results: PortResult[]; completed: boolean }) {
  const [picked, setPicked] = useState<string>();
  const key = (r: PortResult) => `${r.opid}:${r.port}`;
  const active = results.find(r => key(r) === picked) ?? results[0];
  if (!active) return <EmptyState>No port results yet.</EmptyState>;
  return (
    <>
      <div className="scrollbar-thin flex gap-1 overflow-x-auto border-b px-2 py-1.5" role="tablist">
        {results.map(r => (
          <button
            key={key(r)}
            type="button"
            role="tab"
            aria-selected={key(r) === key(active)}
            onClick={() => setPicked(key(r))}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
              key(r) === key(active) ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            )}>
            <Table2 className="size-3.5" />
            {r.opid}
            <span className="opacity-60">{r.port}</span>
            {r.tupleCount !== undefined && <span className="opacity-60">· {formatNumber(r.tupleCount)}</span>}
          </button>
        ))}
      </div>
      <ResultPages key={key(active)} eid={eid} result={active} completed={completed} />
    </>
  );
}

function ResultPages({ eid, result, completed }: { eid: string; result: PortResult; completed: boolean }) {
  const [page, setPage] = useState(1);
  const { data, error, isPending } = useQuery({ ...resultQuery(eid, result.opid, result.port, page), placeholderData: keepPreviousData });
  if (error) return <ErrorNote error={error} prefix="Could not load the result" className="m-3" />;
  if (isPending) return <Skeleton className="m-3 h-32" />;
  const total = data.total ?? result.tupleCount ?? data.rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DataTable columns={data.schema.map(a => ({ name: a.attributeName, type: a.attributeType }))} rows={data.rows} className="min-h-0 flex-1" />
      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1 text-xs text-muted-foreground">
        <span className="flex-1">
          {formatNumber(total)} row{total === 1 ? "" : "s"}
          {result.table && <span className="ml-2 font-mono text-2xs">{result.table}</span>}
        </span>
        {completed && <SaveAsDataset eid={eid} result={result} />}
        <Button variant="ghost" size="icon-xs" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <Button variant="ghost" size="icon-xs" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

/** Keeps a result as a new dataset version; its lineage names this run. Opens it beside. */
function SaveAsDataset({ eid, result }: { eid: string; result: PortResult }) {
  const { beside } = useOpenResource();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => unwrap(executionsSaveResult({ path: { eid, opid: result.opid, port: result.port }, body: {} })),
    onSuccess: v => {
      void queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      beside({ kind: "dataset", rid: v.rid, vno: v.vno });
    },
  });
  return (
    <>
      {save.error && <span className="text-destructive">{save.error.message}</span>}
      <Button variant="ghost" size="xs" disabled={save.isPending} onClick={() => save.mutate()} data-save-result title="Keep this result as a new dataset version">
        {save.isPending ? <Loader2 className="animate-spin" /> : <Database />}
        Save as dataset
      </Button>
    </>
  );
}
